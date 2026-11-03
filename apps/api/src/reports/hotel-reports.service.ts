import { Injectable } from '@nestjs/common';
import { Money } from '@hotel/shared';
import { DbService, Queryable } from '../db/db.service';

/**
 * Hotel reports (RPT-02): daily room sales, occupancy, ADR, RevPAR,
 * cancellations and no-shows, by business date.
 *
 * Definitions (brief §7), so the figures reconcile with the folios:
 * - A room night is sold when the night audit (business-day close) posts its
 *   room charge. Nights of days not yet closed are not counted, and a room
 *   charge later reversed is not counted.
 * - Room revenue is the room charges net of VAT and catering levy.
 * - Complimentary rooms (a room night charged at 0) count as occupied but not
 *   as sold, so they lower occupancy-based RevPAR but not ADR.
 * - Available rooms = sellable, active rooms less rooms blocked for
 *   maintenance that night.
 * - Occupancy = occupied rooms / available rooms.
 * - ADR = room revenue / rooms sold (paid nights).
 * - RevPAR = room revenue / available rooms.
 * - Cancellations are counted on the date they were cancelled; no-shows on
 *   their arrival date.
 */
export const HOTEL_DEFINITIONS = [
  'Room revenue is accommodation charged to folios, net of VAT and catering levy. Only nights posted by the business-day close count; reversed room charges are excluded.',
  'Occupancy = occupied rooms / available rooms. Available rooms exclude unsellable rooms and rooms blocked for maintenance that night.',
  'ADR = room revenue / rooms sold. RevPAR = room revenue / available rooms. Complimentary rooms (charged at 0) count as occupied but not as sold.',
  'Cancellations are counted on the day they were cancelled; no-shows on their arrival date.',
  'Period totals cover closed business days only; a day still open shows no room nights until it is closed.',
];

export interface HotelDay {
  date: string;
  closed: boolean;
  totalRooms: number;
  blockedRooms: number;
  availableRooms: number;
  occupiedRooms: number;
  compRooms: number;
  roomsSold: number;
  roomRevenue: string;
  roomRevenueGross: string;
  occupancy: string;
  adr: string;
  revpar: string;
  arrivals: number;
  departures: number;
  cancellations: number;
  noShows: number;
}

export interface Metrics {
  availableRooms: number;
  occupiedRooms: number;
  compRooms: number;
  roomsSold: number;
  roomRevenue: string;
  roomRevenueGross: string;
  occupancy: string;
  adr: string;
  revpar: string;
}

/** Ratio as a percentage with two decimals, "0.00" when the base is zero. */
export function percent(part: number, whole: number): string {
  return whole > 0 ? Money.of(String(part)).multiply(100).divide(whole).toString() : '0.00';
}

export function metrics(m: { availableRooms: number; occupiedRooms: number; compRooms: number; roomRevenue: string; roomRevenueGross: string }): Metrics {
  const sold = m.occupiedRooms - m.compRooms;
  const revenue = Money.of(m.roomRevenue);
  return {
    ...m,
    roomsSold: sold,
    occupancy: percent(m.occupiedRooms, m.availableRooms),
    adr: sold > 0 ? revenue.divide(sold).toString() : '0.00',
    revpar: m.availableRooms > 0 ? revenue.divide(m.availableRooms).toString() : '0.00',
  };
}

@Injectable()
export class HotelReportsService {
  constructor(private readonly db: DbService) {}

  async daily(q: Queryable, propertyId: string, from: string, to: string): Promise<HotelDay[]> {
    const { rows } = await q.query<{
      date: string; closed: boolean; total: number; blocked: number; occupied: number; comp: number; net: string; gross: string;
      arrivals: number; departures: number; cancellations: number; noShows: number;
    }>(
      `WITH days AS (SELECT d::date AS d FROM generate_series($2::date, $3::date, interval '1 day') d),
            p AS (SELECT id, timezone FROM properties WHERE id = $1),
            nights AS (
              SELECT fc.room_night_date AS d, count(*)::int AS occupied, count(*) FILTER (WHERE fc.amount = 0)::int AS comp,
                     sum(fc.net_amount)::numeric(18,2) AS net, sum(fc.amount)::numeric(18,2) AS gross
                FROM folio_charges fc
               WHERE fc.property_id = $1 AND fc.charge_code = 'ROOM' AND fc.room_night_date BETWEEN $2 AND $3
                 AND NOT EXISTS (SELECT 1 FROM folio_charges r WHERE r.reversal_of = fc.id)
               GROUP BY fc.room_night_date)
       SELECT days.d::text AS date,
              EXISTS (SELECT 1 FROM business_days b WHERE b.property_id = $1 AND b.business_date = days.d) AS closed,
              (SELECT count(*)::int FROM rooms r WHERE r.property_id = $1 AND r.is_sellable
                  AND (r.active_from IS NULL OR r.active_from <= days.d) AND (r.active_to IS NULL OR r.active_to > days.d)) AS total,
              (SELECT count(DISTINCT a.room_id)::int FROM room_allocations a JOIN rooms r ON r.id = a.room_id, p
                WHERE a.property_id = $1 AND a.kind = 'block' AND a.during @> days.d AND r.is_sellable
                  AND (a.released_at IS NULL OR (a.released_at AT TIME ZONE p.timezone)::date > days.d)) AS blocked,
              coalesce(n.occupied, 0) AS occupied, coalesce(n.comp, 0) AS comp,
              coalesce(n.net, 0)::numeric(18,2)::text AS net, coalesce(n.gross, 0)::numeric(18,2)::text AS gross,
              (SELECT count(*)::int FROM stays s WHERE s.property_id = $1 AND s.arrival_date = days.d AND s.status IN ('checked_in', 'checked_out')) AS arrivals,
              (SELECT count(*)::int FROM stays s WHERE s.property_id = $1 AND s.departure_date = days.d AND s.status = 'checked_out') AS departures,
              (SELECT count(*)::int FROM stays s, p WHERE s.property_id = $1 AND s.status = 'cancelled'
                  AND (s.cancelled_at AT TIME ZONE p.timezone)::date = days.d) AS cancellations,
              (SELECT count(*)::int FROM stays s WHERE s.property_id = $1 AND s.status = 'no_show' AND s.arrival_date = days.d) AS "noShows"
         FROM days LEFT JOIN nights n ON n.d = days.d
        ORDER BY days.d`,
      [propertyId, from, to],
    );
    return rows.map((r) => {
      const m = metrics({
        availableRooms: Math.max(r.total - r.blocked, 0), occupiedRooms: r.occupied, compRooms: r.comp, roomRevenue: r.net, roomRevenueGross: r.gross,
      });
      return {
        date: r.date, closed: r.closed, totalRooms: r.total, blockedRooms: r.blocked, ...m,
        arrivals: r.arrivals, departures: r.departures, cancellations: r.cancellations, noShows: r.noShows,
      };
    });
  }

  /**
   * Sums the closed days and recomputes the ratios over them. A day not yet
   * closed has no room nights posted, so counting its rooms as available would
   * understate occupancy; it is left out of the period total.
   */
  static total(all: HotelDay[]) {
    const days = all.filter((d) => d.closed);
    const sum = (k: keyof HotelDay) => days.reduce((a, d) => a + (d[k] as number), 0);
    const m = metrics({
      availableRooms: sum('availableRooms'), occupiedRooms: sum('occupiedRooms'), compRooms: sum('compRooms'),
      roomRevenue: Money.sum(days.map((d) => Money.of(d.roomRevenue))).toString(),
      roomRevenueGross: Money.sum(days.map((d) => Money.of(d.roomRevenueGross))).toString(),
    });
    return { ...m, closedDays: days.length, blockedRooms: sum('blockedRooms'), arrivals: sum('arrivals'), departures: sum('departures'), cancellations: sum('cancellations'), noShows: sum('noShows') };
  }

  async report(propertyId: string, from: string, to: string) {
    return this.db.tx(async (q) => {
      const days = await this.daily(q, propertyId, from, to);
      const nightFilter = `fc.property_id = $1 AND fc.charge_code = 'ROOM' AND fc.room_night_date BETWEEN $2 AND $3
                           AND NOT EXISTS (SELECT 1 FROM folio_charges r WHERE r.reversal_of = fc.id)`;
      const { rows: byRoomType } = await q.query<{ code: string; name: string; occupied: number; comp: number; net: string }>(
        `SELECT rt.code, rt.name, count(*)::int AS occupied, count(*) FILTER (WHERE fc.amount = 0)::int AS comp,
                sum(fc.net_amount)::numeric(18,2)::text AS net
           FROM folio_charges fc JOIN stay_nights n ON n.stay_id = fc.stay_id AND n.night_date = fc.room_night_date
           JOIN room_types rt ON rt.id = n.room_type_id
          WHERE ${nightFilter} GROUP BY rt.code, rt.name, rt.sort_order ORDER BY rt.sort_order, rt.code`,
        [propertyId, from, to],
      );
      const { rows: bySource } = await q.query<{ source: string; occupied: number; comp: number; net: string }>(
        `SELECT rs.source::text AS source, count(*)::int AS occupied, count(*) FILTER (WHERE fc.amount = 0)::int AS comp,
                sum(fc.net_amount)::numeric(18,2)::text AS net
           FROM folio_charges fc JOIN stays s ON s.id = fc.stay_id JOIN reservations rs ON rs.id = s.reservation_id
          WHERE ${nightFilter} GROUP BY rs.source ORDER BY sum(fc.net_amount) DESC`,
        [propertyId, from, to],
      );
      const lost = `SELECT s.number AS "stayNumber", rs.number AS "bookingNumber", g.first_name || ' ' || g.last_name AS guest,
                           rs.source::text AS source, rt.name AS "roomType", s.arrival_date::text AS arrival, s.departure_date::text AS departure,
                           (s.departure_date - s.arrival_date)::int AS nights,
                           coalesce((SELECT sum(n.amount) FROM stay_nights n WHERE n.stay_id = s.id), 0)::numeric(18,2)::text AS "bookedValue",
                           coalesce((SELECT sum(fc.amount) FROM folio_charges fc WHERE fc.stay_id = s.id AND fc.charge_code = $4), 0)::numeric(18,2)::text AS "feeCharged",
                           s.cancel_reason AS reason, u.display_name AS "by",
                           to_char(coalesce(s.cancelled_at, s.no_show_at) AT TIME ZONE p.timezone, 'YYYY-MM-DD HH24:MI') AS "at"
                      FROM stays s JOIN reservations rs ON rs.id = s.reservation_id JOIN guests g ON g.id = s.primary_guest_id
                      JOIN room_types rt ON rt.id = s.room_type_id JOIN properties p ON p.id = s.property_id
                      LEFT JOIN users u ON u.id = s.cancelled_by
                     WHERE s.property_id = $1`;
      const { rows: cancellations } = await q.query(
        `${lost} AND s.status = 'cancelled' AND (s.cancelled_at AT TIME ZONE p.timezone)::date BETWEEN $2 AND $3 ORDER BY s.cancelled_at`,
        [propertyId, from, to, 'CANCEL_FEE'],
      );
      const { rows: noShows } = await q.query(
        `${lost} AND s.status = 'no_show' AND s.arrival_date BETWEEN $2 AND $3 ORDER BY s.arrival_date, s.number`,
        [propertyId, from, to, 'NO_SHOW_FEE'],
      );
      const segment = (r: { occupied: number; comp: number; net: string }) => metrics({ availableRooms: 0, occupiedRooms: r.occupied, compRooms: r.comp, roomRevenue: r.net, roomRevenueGross: '0' });
      return {
        from,
        to,
        days,
        totals: HotelReportsService.total(days),
        byRoomType: byRoomType.map((r) => ({ code: r.code, name: r.name, ...pick(segment(r)) })),
        bySource: bySource.map((r) => ({ source: r.source, ...pick(segment(r)) })),
        cancellations,
        noShows,
        definitions: HOTEL_DEFINITIONS,
      };
    });
  }
}

function pick(m: Metrics) {
  return { occupiedRooms: m.occupiedRooms, compRooms: m.compRooms, roomsSold: m.roomsSold, roomRevenue: m.roomRevenue, adr: m.adr };
}
