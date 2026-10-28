import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { addDays, HkStatus, READY_HK_STATUSES } from '@hotel/shared';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { requestContext } from '../db/request-context';
import { conflict, isPgError, withSavepoint } from './common';

export interface RoomRow {
  id: string;
  number: string;
  floor: string | null;
  building: string | null;
  roomTypeId: string;
  roomTypeCode: string;
  roomTypeName: string;
  hkStatus: HkStatus;
  isSellable: boolean;
}

const ROOM_COLUMNS = `
  r.id, r.number, r.floor, r.building, r.room_type_id AS "roomTypeId", t.code AS "roomTypeCode", t.name AS "roomTypeName",
  r.hk_status AS "hkStatus", r.is_sellable AS "isSellable"`;

/** A room is sellable on a range if active for all of it. */
const SELLABLE = (alias: string, from: string, to: string) => `
  ${alias}.is_sellable
  AND (${alias}.active_from IS NULL OR ${alias}.active_from <= ${from})
  AND (${alias}.active_to IS NULL OR ${alias}.active_to >= ${to})`;

/**
 * Rooms, housekeeping status, maintenance blocks and availability (CFG-02,
 * HK-01, RES-01, RES-04). Physical allocation is protected by the
 * room_allocations exclusion constraint; this service only chooses rooms and
 * turns constraint failures into clear answers.
 */
@Injectable()
export class RoomsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  releaseExpiredHolds(q: Queryable, propertyId: string): Promise<unknown> {
    return q.query('SELECT release_expired_holds($1)', [propertyId]);
  }

  async room(q: Queryable, propertyId: string, roomId: string): Promise<RoomRow> {
    const { rows } = await q.query<RoomRow>(
      `SELECT ${ROOM_COLUMNS} FROM rooms r JOIN room_types t ON t.id = r.room_type_id WHERE r.property_id = $1 AND r.id = $2`,
      [propertyId, roomId],
    );
    if (!rows[0]) throw new NotFoundException('Room not found at this property');
    return rows[0];
  }

  async roomByNumber(q: Queryable, propertyId: string, number: string): Promise<RoomRow> {
    const { rows } = await q.query<RoomRow>(
      `SELECT ${ROOM_COLUMNS} FROM rooms r JOIN room_types t ON t.id = r.room_type_id WHERE r.property_id = $1 AND r.number = $2`,
      [propertyId, number.toUpperCase()],
    );
    if (!rows[0]) throw new NotFoundException(`Room ${number} not found at this property`);
    return rows[0];
  }

  isReady(room: RoomRow): boolean {
    return READY_HK_STATUSES.includes(room.hkStatus);
  }

  /** Rooms of a type with no active allocation overlapping [arrival, departure); ready rooms first. */
  async freeRooms(q: Queryable, propertyId: string, roomTypeId: string | null, arrival: string, departure: string): Promise<RoomRow[]> {
    const { rows } = await q.query<RoomRow>(
      `SELECT ${ROOM_COLUMNS}
         FROM rooms r JOIN room_types t ON t.id = r.room_type_id
        WHERE r.property_id = $1 AND ($2::uuid IS NULL OR r.room_type_id = $2)
          AND ${SELLABLE('r', '$3::date', '$4::date')}
          AND NOT EXISTS (
            SELECT 1 FROM room_allocations a
             WHERE a.room_id = r.id AND a.released_at IS NULL AND a.during && daterange($3::date, $4::date))
        ORDER BY (r.hk_status IN ('clean', 'inspected')) DESC, t.sort_order, r.number`,
      [propertyId, roomTypeId, arrival, departure],
    );
    return rows;
  }

  /**
   * Allocates a room to a stay for [from, to). With `roomId`, that room or a
   * 409; otherwise the first free room of the type. Two receptionists racing
   * for the last room: the database lets one allocation in and the other gets
   * the exclusion error, which becomes "no room free" (RES-04, AT-08).
   */
  async allocate(
    q: Queryable,
    p: { propertyId: string; stayId: string; roomTypeId: string; roomId?: string | null; from: string; to: string },
  ): Promise<RoomRow> {
    const actor = requestContext.get()?.user?.id ?? null;
    const insert = (roomId: string) =>
      q.query(
        `INSERT INTO room_allocations (property_id, room_id, kind, stay_id, during, created_by)
         VALUES ($1, $2, 'stay', $3, daterange($4::date, $5::date), $6)`,
        [p.propertyId, roomId, p.stayId, p.from, p.to, actor],
      );

    if (p.roomId) {
      const room = await this.room(q, p.propertyId, p.roomId);
      try {
        await withSavepoint(q, 'alloc', () => insert(room.id));
      } catch (err) {
        if (isPgError(err, '23P01')) {
          throw conflict(`Room ${room.number} is not free from ${p.from} to ${p.to}`, 'room_unavailable');
        }
        throw err;
      }
      return room;
    }

    const candidates = await this.freeRooms(q, p.propertyId, p.roomTypeId, p.from, p.to);
    for (const room of candidates) {
      try {
        await withSavepoint(q, 'alloc', () => insert(room.id));
        return room;
      } catch (err) {
        if (!isPgError(err, '23P01')) throw err; // taken by a concurrent booking: try the next room
      }
    }
    const type = await q.query<{ name: string }>('SELECT name FROM room_types WHERE id = $1', [p.roomTypeId]);
    throw conflict(`No ${type.rows[0]?.name ?? 'room'} is free from ${p.from} to ${p.to}`, 'no_availability');
  }

  /** Releases a stay's active allocations (cancel, no-show, hold expiry, reallocation). */
  async releaseStay(q: Queryable, stayId: string, reason: 'cancelled' | 'no_show' | 'amended' | 'moved' | 'checked_out'): Promise<void> {
    await q.query(
      `UPDATE room_allocations SET released_at = now(), release_reason = $2 WHERE stay_id = $1 AND released_at IS NULL`,
      [stayId, reason],
    );
  }

  async activeAllocation(q: Queryable, stayId: string): Promise<{ id: string; roomId: string; from: string; to: string } | undefined> {
    const { rows } = await q.query<{ id: string; roomId: string; from: string; to: string }>(
      `SELECT id, room_id AS "roomId", lower(during)::text AS "from", upper(during)::text AS "to"
         FROM room_allocations WHERE stay_id = $1 AND released_at IS NULL
        ORDER BY lower(during) DESC LIMIT 1`,
      [stayId],
    );
    return rows[0];
  }

  /** Changes the nights of an allocation in place; the exclusion constraint checks the new nights (FD-06). */
  async resizeAllocation(q: Queryable, allocationId: string, from: string, to: string, roomNumber: string): Promise<void> {
    try {
      await withSavepoint(q, 'resize', () =>
        q.query('UPDATE room_allocations SET during = daterange($2::date, $3::date) WHERE id = $1', [allocationId, from, to]),
      );
    } catch (err) {
      if (isPgError(err, '23P01')) throw conflict(`Room ${roomNumber} is not free from ${from} to ${to}`, 'room_unavailable');
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  async freeRoomsFor(propertyId: string, roomTypeCode: string | null, arrival: string, departure: string) {
    if (departure <= arrival) throw new BadRequestException('Departure must be after arrival');
    return this.db.tx(async (q) => {
      await this.releaseExpiredHolds(q, propertyId);
      let typeId: string | null = null;
      if (roomTypeCode) {
        const { rows } = await q.query<{ id: string }>('SELECT id FROM room_types WHERE property_id = $1 AND code = $2', [propertyId, roomTypeCode.toUpperCase()]);
        if (!rows[0]) throw new NotFoundException(`Unknown room type ${roomTypeCode}`);
        typeId = rows[0].id;
      }
      return this.freeRooms(q, propertyId, typeId, arrival, departure);
    });
  }

  async listRoomTypes(propertyId: string) {
    const { rows } = await this.db.query(
      `SELECT t.id, t.code, t.name, t.description, t.base_occupancy AS "baseOccupancy", t.max_adults AS "maxAdults",
              t.max_occupancy AS "maxOccupancy", t.beds, t.amenities,
              count(r.id)::int AS "roomCount"
         FROM room_types t LEFT JOIN rooms r ON r.room_type_id = t.id AND r.is_sellable
        WHERE t.property_id = $1 AND t.is_active
        GROUP BY t.id ORDER BY t.sort_order, t.code`,
      [propertyId],
    );
    return rows;
  }

  /** Rooms with housekeeping status and who is in them on the business date (FD-01, HK-01). */
  async listRooms(propertyId: string, businessDate: string) {
    const { rows } = await this.db.query(
      `SELECT ${ROOM_COLUMNS}, r.hk_updated_at AS "hkUpdatedAt",
              s.id AS "stayId", s.number AS "stayNumber", s.status AS "stayStatus",
              g.first_name || ' ' || g.last_name AS "guestName", s.departure_date AS "departureDate",
              b.id AS "blockId", b.block_reason AS "blockReason"
         FROM rooms r
         JOIN room_types t ON t.id = r.room_type_id
         LEFT JOIN room_allocations a ON a.room_id = r.id AND a.released_at IS NULL AND a.kind = 'stay'
               AND a.during @> $2::date
         LEFT JOIN stays s ON s.id = a.stay_id
         LEFT JOIN guests g ON g.id = s.primary_guest_id
         LEFT JOIN room_allocations b ON b.room_id = r.id AND b.released_at IS NULL AND b.kind = 'block'
               AND b.during @> $2::date
        WHERE r.property_id = $1
        ORDER BY r.building NULLS FIRST, r.number`,
      [propertyId, businessDate],
    );
    return rows;
  }

  async setHkStatus(propertyId: string, roomId: string, status: HkStatus) {
    return this.db.tx(async (q) => {
      const before = await this.room(q, propertyId, roomId);
      await q.query(`UPDATE rooms SET hk_status = $3, hk_updated_at = now() WHERE property_id = $1 AND id = $2`, [propertyId, roomId, status]);
      await this.audit.record({
        action: 'room.hk_status', entityType: 'room', entityId: roomId, propertyId,
        previousValues: { hkStatus: before.hkStatus }, newValues: { hkStatus: status },
      });
      return { ...before, hkStatus: status };
    });
  }

  async markDirty(q: Queryable, roomId: string): Promise<void> {
    await q.query(`UPDATE rooms SET hk_status = 'dirty', hk_updated_at = now() WHERE id = $1`, [roomId]);
  }

  /** Maintenance block (RES-01): takes the room out of inventory for the nights given. */
  async block(propertyId: string, roomId: string, from: string, to: string, reason: string) {
    if (to <= from) throw new BadRequestException('A block ends after it starts');
    return this.db.tx(async (q) => {
      const room = await this.room(q, propertyId, roomId);
      await this.releaseExpiredHolds(q, propertyId);
      try {
        const { rows } = await withSavepoint(q, 'block', () =>
          q.query<{ id: string }>(
            `INSERT INTO room_allocations (property_id, room_id, kind, during, block_reason, created_by)
             VALUES ($1, $2, 'block', daterange($3::date, $4::date), $5, $6) RETURNING id`,
            [propertyId, roomId, from, to, reason, requestContext.get()?.user?.id ?? null],
          ),
        );
        await this.audit.record({ action: 'room.block', entityType: 'room', entityId: roomId, propertyId, newValues: { from, to, reason }, reason });
        return { id: rows[0].id, roomId, roomNumber: room.number, from, to, reason };
      } catch (err) {
        if (isPgError(err, '23P01')) throw conflict(`Room ${room.number} has bookings between ${from} and ${to}; move them first`, 'room_unavailable');
        throw err;
      }
    });
  }

  async releaseBlock(propertyId: string, blockId: string) {
    return this.db.tx(async (q) => {
      const { rowCount } = await q.query(
        `UPDATE room_allocations SET released_at = now(), release_reason = 'block_ended'
          WHERE property_id = $1 AND id = $2 AND kind = 'block' AND released_at IS NULL`,
        [propertyId, blockId],
      );
      if (!rowCount) throw new NotFoundException('No active block with that id');
      await this.audit.record({ action: 'room.unblock', entityType: 'room_allocation', entityId: blockId, propertyId });
      return { id: blockId, released: true };
    });
  }

  /**
   * Availability calendar (RES-01): per room and date, what holds it (stay,
   * hold, maintenance block), plus free rooms per type and arrivals/departures
   * per day. `days` is 1 (day), 7 (week) or up to 31 (month).
   */
  async availability(propertyId: string, from: string, days: number) {
    if (days < 1 || days > 62) throw new BadRequestException('days must be between 1 and 62');
    const to = addDays(from, days);
    return this.db.tx(async (q) => {
      await this.releaseExpiredHolds(q, propertyId);
      const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
      const { rows: rooms } = await q.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS} FROM rooms r JOIN room_types t ON t.id = r.room_type_id
          WHERE r.property_id = $1 AND r.is_sellable ORDER BY t.sort_order, r.number`,
        [propertyId],
      );
      const { rows: allocs } = await q.query<{
        roomId: string; kind: string; from: string; to: string; blockReason: string | null; blockId: string;
        stayId: string | null; stayNumber: string | null; status: string | null; guestName: string | null;
        reservationId: string | null; reservationNumber: string | null; arrival: string | null; departure: string | null;
      }>(
        `SELECT a.room_id AS "roomId", a.kind, lower(a.during)::text AS "from", upper(a.during)::text AS "to",
                a.block_reason AS "blockReason", a.id AS "blockId",
                s.id AS "stayId", s.number AS "stayNumber", s.status::text AS status,
                g.first_name || ' ' || g.last_name AS "guestName", s.reservation_id AS "reservationId",
                res.number AS "reservationNumber", s.arrival_date AS arrival, s.departure_date AS departure
           FROM room_allocations a
           LEFT JOIN stays s ON s.id = a.stay_id
           LEFT JOIN reservations res ON res.id = s.reservation_id
           LEFT JOIN guests g ON g.id = s.primary_guest_id
          WHERE a.property_id = $1 AND a.released_at IS NULL AND a.during && daterange($2::date, $3::date)`,
        [propertyId, from, to],
      );
      const { rows: movement } = await q.query<{ date: string; arrivals: number; departures: number }>(
        `SELECT d::date::text AS date,
                count(*) FILTER (WHERE s.arrival_date = d::date AND s.status IN ('hold', 'confirmed', 'checked_in'))::int AS arrivals,
                count(*) FILTER (WHERE s.departure_date = d::date AND s.status IN ('confirmed', 'checked_in', 'checked_out'))::int AS departures
           FROM generate_series($2::date, $3::date - 1, interval '1 day') d
           LEFT JOIN stays s ON s.property_id = $1 AND (s.arrival_date = d::date OR s.departure_date = d::date)
          GROUP BY d ORDER BY d`,
        [propertyId, from, to],
      );

      const state = (a: (typeof allocs)[number]) =>
        a.kind === 'block' ? 'blocked' : a.status === 'checked_in' ? 'occupied' : a.status === 'hold' ? 'hold' : a.status === 'checked_out' ? 'departed' : 'reserved';

      const grid = rooms.map((room) => ({
        id: room.id,
        number: room.number,
        roomTypeCode: room.roomTypeCode,
        hkStatus: room.hkStatus,
        cells: dates.map((date) => {
          const a = allocs.find((x) => x.roomId === room.id && x.from <= date && date < x.to);
          if (!a) return { date, state: 'free' as const };
          return {
            date,
            state: state(a),
            ...(a.kind === 'block'
              ? { blockId: a.blockId, reason: a.blockReason }
              : {
                  stayId: a.stayId, stayNumber: a.stayNumber, reservationId: a.reservationId, reservationNumber: a.reservationNumber,
                  guestName: a.guestName, isArrival: a.arrival === date, isDeparture: a.departure === addDays(date, 1),
                }),
          };
        }),
      }));

      const types = [...new Map(rooms.map((r) => [r.roomTypeCode, r.roomTypeName])).entries()].map(([code, name]) => ({
        code,
        name,
        total: rooms.filter((r) => r.roomTypeCode === code).length,
        free: dates.map((date) => grid.filter((g) => g.roomTypeCode === code && g.cells.find((c) => c.date === date)!.state === 'free').length),
      }));

      return { from, to, dates, rooms: grid, roomTypes: types, movement };
    });
  }
}
