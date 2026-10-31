import { BadRequestException, ForbiddenException, forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { addDays, hasPermission, Money, nightsBetween } from '@hotel/shared';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { requestContext } from '../db/request-context';
import { LoyaltyCheckoutService } from '../loyalty/checkout.service';
import { assertNoOpenChecksForStay, assertOutletDaysClosed } from '../pos/common';
import { ApprovalsService } from './approvals.service';
import { ApprovalInputT, businessDate, conflict } from './common';
import { FoliosService, TenderInput } from './folios.service';
import { GuestInput, GuestsService, IdentityInput } from './guests.service';
import { RatesService } from './rates.service';
import { ReservationsService, StayRow } from './reservations.service';
import { RoomsService } from './rooms.service';

export interface CheckInInput {
  roomId?: string | null;
  identity?: IdentityInput;
  occupants?: Array<{ id: string } | GuestInput>;
  roomChargeAllowed: boolean;
  creditLimit?: string | null;
  earlyCheckIn?: boolean;
  waiveFee?: boolean;
  roomNotReadyReason?: string;
  registration?: RegistrationInput;
  approval?: ApprovalInputT;
}

export interface RegistrationInput {
  method: 'paper_signature' | 'digital_signature' | 'staff_verified';
  signedName: string;
  signature?: string | null;
}

export interface CheckOutInput {
  tenders?: TenderInput[];
  creditTransfer?: { companyId: string; reason: string };
  approval?: ApprovalInputT;
}

export interface GuestRequestInput {
  stayId?: string | null;
  roomId?: string | null;
  category: string;
  description: string;
  priority?: string;
  ownerUserId?: string | null;
  dueAt?: string | null;
}

/**
 * Reception (FD-01 … FD-08): dashboard, check-in, registration card, room
 * moves, early arrival / late departure, guest requests and checkout, plus a
 * basic day close that posts room nights and advances the business date.
 */
@Injectable()
export class FrontDeskService {
  constructor(
    private readonly db: DbService,
    private readonly rooms: RoomsService,
    private readonly rates: RatesService,
    private readonly guests: GuestsService,
    private readonly reservations: ReservationsService,
    private readonly folios: FoliosService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    @Inject(forwardRef(() => LoyaltyCheckoutService)) private readonly loyalty: LoyaltyCheckoutService,
  ) {}

  private actor(): string | null {
    return requestContext.get()?.user?.id ?? null;
  }

  private async policyOf(q: Queryable, stay: StayRow) {
    const { rows } = await q.query<{ policy_snapshot: Awaited<ReturnType<RatesService['policy']>> }>(
      'SELECT policy_snapshot FROM reservations WHERE id = $1',
      [stay.reservationId],
    );
    return rows[0].policy_snapshot;
  }

  // -------------------------------------------------------------------------
  // Dashboard (FD-01)
  // -------------------------------------------------------------------------

  async dashboard(propertyId: string) {
    return this.db.tx(async (q) => {
      await this.rooms.releaseExpiredHolds(q, propertyId);
      const bd = await businessDate(q, propertyId);
      const stayCols = `
        s.id, s.number, s.status, s.reservation_id AS "reservationId", r.number AS "reservationNumber",
        g.first_name || ' ' || g.last_name AS "guestName", rm.number AS "roomNumber", rm.hk_status AS "roomHkStatus",
        t.code AS "roomTypeCode", s.arrival_date AS "arrivalDate", s.departure_date AS "departureDate",
        s.adults, s.children, f.id AS "folioId", b.balance, b.payments_pending AS "paymentsPending",
        r.deposit_required AS "depositRequired", s.departure_time AS "departureTime"`;
      const from = `
        FROM stays s JOIN reservations r ON r.id = s.reservation_id JOIN guests g ON g.id = s.primary_guest_id
        JOIN room_types t ON t.id = s.room_type_id LEFT JOIN rooms rm ON rm.id = s.room_id
        LEFT JOIN folios f ON f.stay_id = s.id AND f.is_primary LEFT JOIN folio_balances b ON b.folio_id = f.id`;
      const list = async (where: string) =>
        (await q.query(`SELECT ${stayCols} ${from} WHERE s.property_id = $1 AND ${where} ORDER BY rm.number NULLS LAST, s.number`, [propertyId, bd])).rows;

      const arrivals = await list(`s.status IN ('hold', 'confirmed') AND s.arrival_date <= $2`);
      const departures = await list(`s.status = 'checked_in' AND s.departure_date = $2`);
      const inHouse = await list(`s.status = 'checked_in' AND $2::date IS NOT NULL`);
      const { rows: overdue } = await q.query(
        `SELECT ${stayCols} ${from} JOIN properties p ON p.id = s.property_id JOIN booking_policies bp ON bp.property_id = s.property_id
          WHERE s.property_id = $1 AND s.status = 'checked_in'
            AND (s.departure_date < $2
                 OR (s.departure_date = $2 AND (now() AT TIME ZONE p.timezone)::date >= s.departure_date
                     AND (now() AT TIME ZONE p.timezone)::time > coalesce(s.departure_time, bp.check_out_time)))
          ORDER BY s.departure_date`,
        [propertyId, bd],
      );
      const { rows: readiness } = await q.query(
        `SELECT r.hk_status AS status, count(*)::int AS rooms,
                count(*) FILTER (WHERE a.id IS NOT NULL)::int AS occupied
           FROM rooms r LEFT JOIN room_allocations a ON a.room_id = r.id AND a.released_at IS NULL AND a.kind = 'stay'
                AND a.during @> $2::date AND EXISTS (SELECT 1 FROM stays s WHERE s.id = a.stay_id AND s.status = 'checked_in')
          WHERE r.property_id = $1 AND r.is_sellable GROUP BY r.hk_status ORDER BY r.hk_status`,
        [propertyId, bd],
      );
      const { rows: blocked } = await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM room_allocations WHERE property_id = $1 AND kind = 'block' AND released_at IS NULL AND during @> $2::date`,
        [propertyId, bd],
      );
      const { rows: requests } = await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM guest_requests WHERE property_id = $1 AND status IN ('open', 'in_progress')`,
        [propertyId],
      );
      const total = readiness.reduce((a, r) => a + (r.rooms as number), 0);
      const occupied = inHouse.length;
      return {
        businessDate: bd,
        counts: {
          arrivals: arrivals.length, departures: departures.length, inHouse: occupied, overdueCheckouts: overdue.length,
          rooms: total, vacant: total - occupied - blocked[0].n, blocked: blocked[0].n, openRequests: requests[0].n,
        },
        arrivals,
        departures,
        inHouse,
        overdueCheckouts: overdue,
        outstandingBalances: inHouse.filter((s) => Money.of((s.balance as string) ?? '0').compare(0) > 0),
        roomReadiness: readiness,
        arrivalsRoomNotReady: arrivals.filter((s) => s.roomNumber && !['clean', 'inspected'].includes(s.roomHkStatus as string)),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Check-in (FD-03, FD-04, FD-06, RES-07)
  // -------------------------------------------------------------------------

  async checkIn(propertyId: string, stayId: string, input: CheckInInput) {
    return this.db.tx(async (q) => {
      await this.rooms.releaseExpiredHolds(q, propertyId);
      const bd = await businessDate(q, propertyId, true);
      const stay = await this.reservations.stay(q, propertyId, stayId, true);
      if (stay.status !== 'confirmed') {
        throw conflict(`Stay ${stay.number} is ${stay.status}; only confirmed bookings can be checked in`, 'invalid_transition');
      }
      if (stay.arrivalDate !== bd) {
        throw conflict(
          stay.arrivalDate > bd
            ? `Stay ${stay.number} arrives ${stay.arrivalDate}; amend the arrival to ${bd} first (early arrival needs availability)`
            : `Stay ${stay.number} was due ${stay.arrivalDate}; amend the dates or mark it a no-show`,
          'wrong_arrival_date',
        );
      }

      // Identity (FD-03, FD-02): verified now, or already on file and in date.
      if (input.identity) {
        const user = requestContext.get()?.user;
        if (!user || !hasPermission(user.roles, 'guest.identity')) throw new ForbiddenException('Missing permission guest.identity');
        await this.guests.addIdentity(q, stay.primaryGuestId, input.identity, propertyId);
      } else if (!(await this.guests.hasValidIdentity(q, stay.primaryGuestId, bd))) {
        throw conflict('Record and verify the guest’s identity document before check-in', 'identity_required');
      }

      // Room (FD-03): the allocated room, or another free one, and it must be ready.
      let alloc = await this.rooms.activeAllocation(q, stay.id);
      if (input.roomId && input.roomId !== alloc?.roomId) {
        await this.rooms.releaseStay(q, stay.id, 'amended');
        const room = await this.rooms.allocate(q, { propertyId, stayId: stay.id, roomTypeId: stay.roomTypeId, roomId: input.roomId, from: stay.arrivalDate, to: stay.departureDate });
        alloc = { id: '', roomId: room.id, from: stay.arrivalDate, to: stay.departureDate };
      }
      if (!alloc) throw conflict('The stay has no room allocated', 'no_room');
      const room = await this.rooms.room(q, propertyId, alloc.roomId);
      if (!this.rooms.isReady(room)) {
        if (!input.roomNotReadyReason) {
          throw conflict(`Room ${room.number} is ${room.hkStatus.replace('_', ' ')}; choose a ready room or get approval`, 'room_not_ready');
        }
        await this.approvals.approve({
          permission: 'approve.room_not_ready', propertyId, action: 'stay.check_in_room_not_ready', entityType: 'stay', entityId: stay.id,
          reason: input.roomNotReadyReason, approval: input.approval, details: { room: room.number, hkStatus: room.hkStatus },
        });
      }

      // Occupants (FD-03): named guests in the room; the primary guest is already one.
      for (const o of input.occupants ?? []) {
        const guestId = 'id' in o ? o.id : (await this.guests.create(q, o)).id;
        await q.query(
          `INSERT INTO stay_occupants (stay_id, property_id, guest_id, is_primary, added_by) VALUES ($1, $2, $3, false, $4) ON CONFLICT DO NOTHING`,
          [stay.id, propertyId, guestId, this.actor()],
        );
      }
      const { rows: occ } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM stay_occupants WHERE stay_id = $1', [stay.id]);
      if (occ[0].n > stay.adults + stay.children) {
        throw new BadRequestException(`The booking is for ${stay.adults + stay.children} guests but ${occ[0].n} occupants were recorded`);
      }

      await q.query(
        `UPDATE stays SET status = 'checked_in', room_id = $2, checked_in_at = now(), checked_in_by = $3,
                room_charge_allowed = $4, credit_limit = $5 WHERE id = $1`,
        [stay.id, room.id, this.actor(), input.roomChargeAllowed, input.creditLimit ?? null],
      );

      const folio = await this.folios.lockPrimaryForStay(q, propertyId, stay.id);
      // Deposits now count against this stay's charges (RES-07).
      await q.query(
        `UPDATE folio_payments SET deposit_applied_at = now() WHERE folio_id = $1 AND is_deposit AND status = 'confirmed' AND deposit_applied_at IS NULL`,
        [folio.id],
      );
      if (input.earlyCheckIn) {
        const policy = await this.policyOf(q, stay);
        await this.fee(q, { ...folio, stayStatus: 'checked_in' }, stay, 'EARLY_CHECKIN', policy.earlyCheckInFee, `Early check-in, room ${room.number}`, input, bd);
      }
      if (input.registration) await this.acknowledge(q, stay.id, input.registration);

      await this.audit.record({
        action: 'stay.check_in', entityType: 'stay', entityId: stay.id, propertyId,
        newValues: { room: room.number, roomChargeAllowed: input.roomChargeAllowed, creditLimit: input.creditLimit ?? null, earlyCheckIn: !!input.earlyCheckIn },
      });
      return this.reservations.detail(q, propertyId, stay.reservationId);
    });
  }

  private async fee(
    q: Queryable,
    folio: Awaited<ReturnType<FoliosService['lock']>>,
    stay: StayRow,
    code: 'EARLY_CHECKIN' | 'LATE_CHECKOUT',
    amount: string,
    description: string,
    input: { waiveFee?: boolean; approval?: ApprovalInputT; waiveReason?: string },
    bd: string,
  ): Promise<void> {
    if (Money.of(amount).isZero()) return;
    if (input.waiveFee) {
      await this.approvals.approve({
        permission: 'approve.fee_waiver', propertyId: stay.propertyId, action: `stay.${code.toLowerCase()}_waiver`, entityType: 'stay',
        entityId: stay.id, reason: input.waiveReason ?? `${description} waived`, approval: input.approval, details: { amount },
      });
      return;
    }
    await this.folios.postCharge(q, { folio, chargeCode: code, description, quantity: '1', unitPrice: amount, serviceDate: bd });
  }

  // -------------------------------------------------------------------------
  // Registration card (FD-04)
  // -------------------------------------------------------------------------

  private async acknowledge(q: Queryable, stayId: string, r: RegistrationInput): Promise<void> {
    if (r.method === 'digital_signature' && !r.signature) throw new BadRequestException('A digital signature needs the signature image');
    if (r.signature && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(r.signature)) {
      throw new BadRequestException('The signature must be a PNG, JPEG or WebP data URL');
    }
    await q.query(
      `UPDATE stays SET registration_acknowledged_at = now(), registration_method = $2, registration_signed_name = $3,
              registration_signature = $4 WHERE id = $1`,
      [stayId, r.method, r.signedName, r.signature ?? null],
    );
  }

  async acknowledgeRegistration(propertyId: string, stayId: string, r: RegistrationInput) {
    return this.db.tx(async (q) => {
      const stay = await this.reservations.stay(q, propertyId, stayId, true);
      if (!['confirmed', 'checked_in'].includes(stay.status)) throw conflict(`Stay ${stay.number} is ${stay.status}`, 'invalid_transition');
      await this.acknowledge(q, stayId, r);
      await this.audit.record({ action: 'stay.registration_ack', entityType: 'stay', entityId: stayId, propertyId, newValues: { method: r.method, signedName: r.signedName } });
      return { stayId, acknowledged: true, method: r.method };
    });
  }

  async registrationCard(propertyId: string, stayId: string) {
    return this.db.tx(async (q) => {
      const stay = await this.reservations.stay(q, propertyId, stayId);
      const detail = await this.reservations.detail(q, propertyId, stay.reservationId);
      const s = detail.stays.find((x) => x.id === stayId)!;
      const { rows: [guest] } = await q.query(
        `SELECT g.first_name || ' ' || g.last_name AS name, g.phone, g.email, g.nationality, g.address, c.name AS company
           FROM guests g LEFT JOIN companies c ON c.id = g.company_id WHERE g.id = $1`,
        [stay.primaryGuestId],
      );
      const { rows: docs } = await q.query<{ documentType: string; documentNumber: string; issuingCountry: string }>(
        `SELECT document_type AS "documentType", document_number AS "documentNumber", issuing_country AS "issuingCountry"
           FROM guest_identity_documents WHERE guest_id = $1 ORDER BY verified_at DESC NULLS LAST LIMIT 1`,
        [stay.primaryGuestId],
      );
      const { rows: [reg] } = await q.query(
        `SELECT registration_acknowledged_at AS "acknowledgedAt", registration_method AS method, registration_signed_name AS "signedName",
                registration_signature AS signature FROM stays WHERE id = $1`,
        [stayId],
      );
      return {
        property: await this.folios.header(q, propertyId),
        reservationNumber: detail.number,
        stay: s,
        guest,
        identity: docs[0]
          ? { documentType: docs[0].documentType, documentNumber: `${'*'.repeat(Math.max(0, docs[0].documentNumber.length - 3))}${docs[0].documentNumber.slice(-3)}`, issuingCountry: docs[0].issuingCountry }
          : null,
        policy: detail.policy,
        registration: reg,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Room move (FD-05, AT-05)
  // -------------------------------------------------------------------------

  /**
   * Moves an in-house guest. The stay, its number and its folio do not change;
   * only the physical allocation does. Nights already spent stay recorded on
   * the old room; the new room is allocated from today to departure.
   */
  async move(propertyId: string, stayId: string, input: { toRoomId: string; reason: string; roomNotReadyReason?: string; approval?: ApprovalInputT }) {
    return this.db.tx(async (q) => {
      const bd = await businessDate(q, propertyId, true);
      const stay = await this.reservations.stay(q, propertyId, stayId, true);
      if (stay.status !== 'checked_in') throw conflict(`Stay ${stay.number} is ${stay.status}; only in-house guests are moved`, 'invalid_transition');
      if (bd >= stay.departureDate) throw conflict(`Stay ${stay.number} is due out today; extend the stay before moving rooms`, 'due_out');
      const alloc = await this.rooms.activeAllocation(q, stay.id);
      if (!alloc) throw conflict('The stay has no current room', 'no_room');
      if (alloc.roomId === input.toRoomId) throw new BadRequestException('The guest is already in that room');
      const from = await this.rooms.room(q, propertyId, alloc.roomId);
      const to = await this.rooms.room(q, propertyId, input.toRoomId);
      if (!this.rooms.isReady(to)) {
        if (!input.roomNotReadyReason) throw conflict(`Room ${to.number} is ${to.hkStatus.replace('_', ' ')}`, 'room_not_ready');
        await this.approvals.approve({
          permission: 'approve.room_not_ready', propertyId, action: 'stay.move_room_not_ready', entityType: 'stay', entityId: stay.id,
          reason: input.roomNotReadyReason, approval: input.approval, details: { room: to.number, hkStatus: to.hkStatus },
        });
      }
      const moveFrom = bd;
      if (alloc.from < moveFrom) {
        await this.rooms.resizeAllocation(q, alloc.id, alloc.from, moveFrom, from.number);
      } else {
        await q.query(`UPDATE room_allocations SET released_at = now(), release_reason = 'moved' WHERE id = $1`, [alloc.id]);
      }
      await this.rooms.allocate(q, { propertyId, stayId: stay.id, roomTypeId: to.roomTypeId, roomId: to.id, from: moveFrom, to: stay.departureDate });
      await q.query('UPDATE stays SET room_id = $2 WHERE id = $1', [stay.id, to.id]);
      await this.rooms.markDirty(q, from.id);
      await q.query(
        `INSERT INTO room_moves (property_id, stay_id, from_room_id, to_room_id, move_date, reason, moved_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [propertyId, stay.id, from.id, to.id, moveFrom, input.reason, this.actor()],
      );
      await this.audit.record({
        action: 'stay.room_move', entityType: 'stay', entityId: stay.id, propertyId,
        previousValues: { room: from.number }, newValues: { room: to.number, from: moveFrom }, reason: input.reason,
      });
      return { stayId: stay.id, stayNumber: stay.number, fromRoom: from.number, toRoom: to.number, moveDate: moveFrom };
    });
  }

  async moves(propertyId: string, stayId: string) {
    const { rows } = await this.db.query(
      `SELECT m.id, f.number AS "fromRoom", t.number AS "toRoom", m.move_date AS "moveDate", m.reason, u.display_name AS "movedBy", m.moved_at AS "movedAt"
         FROM room_moves m JOIN rooms f ON f.id = m.from_room_id JOIN rooms t ON t.id = m.to_room_id LEFT JOIN users u ON u.id = m.moved_by
        WHERE m.property_id = $1 AND m.stay_id = $2 ORDER BY m.moved_at`,
      [propertyId, stayId],
    );
    return rows;
  }

  // -------------------------------------------------------------------------
  // Late departure (FD-06)
  // -------------------------------------------------------------------------

  async lateCheckout(propertyId: string, stayId: string, input: { departureTime: string; waiveFee?: boolean; reason?: string; approval?: ApprovalInputT }) {
    return this.db.tx(async (q) => {
      const stay = await this.reservations.stay(q, propertyId, stayId, true);
      if (stay.status !== 'checked_in') throw conflict(`Stay ${stay.number} is ${stay.status}`, 'invalid_transition');
      const bd = await businessDate(q, propertyId);
      const policy = await this.policyOf(q, stay);
      if (input.departureTime <= policy.checkOutTime) throw new BadRequestException(`Standard check-out is ${policy.checkOutTime}; nothing to extend`);
      // Someone arriving into the same room on the departure day needs it by check-in time.
      const { rows: next } = await q.query<{ number: string }>(
        `SELECT s.number FROM room_allocations a JOIN stays s ON s.id = a.stay_id
          WHERE a.room_id = $1 AND a.released_at IS NULL AND lower(a.during) = $2::date AND a.stay_id <> $3`,
        [stay.roomId, stay.departureDate, stay.id],
      );
      if (next[0] && input.departureTime > policy.checkInTime) {
        throw conflict(`Booking ${next[0].number} arrives in this room on ${stay.departureDate} at ${policy.checkInTime}; move it first`, 'room_unavailable');
      }
      const folio = await this.folios.lockPrimaryForStay(q, propertyId, stay.id);
      await this.fee(q, folio, stay, 'LATE_CHECKOUT', policy.lateCheckOutFee, `Late check-out until ${input.departureTime}`, { ...input, waiveReason: input.reason }, bd);
      await q.query('UPDATE stays SET departure_time = $2 WHERE id = $1', [stay.id, input.departureTime]);
      await this.audit.record({ action: 'stay.late_checkout', entityType: 'stay', entityId: stay.id, propertyId, newValues: { departureTime: input.departureTime, waived: !!input.waiveFee } });
      return this.reservations.detail(q, propertyId, stay.reservationId);
    });
  }

  // -------------------------------------------------------------------------
  // Checkout (FD-08)
  // -------------------------------------------------------------------------

  /** Room nights due and not yet posted: nights before the business date, at least one night. */
  private async postDueNights(q: Queryable, stay: StayRow, folio: Awaited<ReturnType<FoliosService['lock']>>, upTo: string): Promise<number> {
    const { rows } = await q.query<{ date: string; amount: string; room: string | null }>(
      `SELECT n.night_date AS date, n.amount, r.number AS room
         FROM stay_nights n
         LEFT JOIN room_allocations a ON a.stay_id = n.stay_id AND a.during @> n.night_date AND a.released_at IS NULL
         LEFT JOIN rooms r ON r.id = a.room_id
        WHERE n.stay_id = $1 AND n.night_date < $2
          AND NOT EXISTS (SELECT 1 FROM folio_charges c WHERE c.stay_id = n.stay_id AND c.room_night_date = n.night_date)
        ORDER BY n.night_date`,
      [stay.id, upTo],
    );
    for (const n of rows) {
      await this.folios.postCharge(q, {
        folio, chargeCode: 'ROOM', description: `Accommodation${n.room ? `, room ${n.room}` : ''}, night of ${n.date}`,
        quantity: '1', unitPrice: n.amount, serviceDate: n.date, roomNightDate: n.date,
      });
    }
    return rows.length;
  }

  /**
   * Checkout. Locks the stay and folio (§9 freeze), posts any room nights still
   * due, refuses while payments are pending, takes the final tenders or an
   * approved credit transfer, requires a zero balance, issues the final invoice,
   * closes the folio and frees the room.
   */
  async checkOut(propertyId: string, stayId: string, input: CheckOutInput) {
    return this.db.tx(async (q) => {
      const bd = await businessDate(q, propertyId, true);
      const stay = await this.reservations.stay(q, propertyId, stayId, true);
      if (stay.status !== 'checked_in') throw conflict(`Stay ${stay.number} is ${stay.status}; only in-house guests check out`, 'invalid_transition');
      if (bd > stay.departureDate) {
        throw conflict(`Stay ${stay.number} was due out ${stay.departureDate}; extend it to ${bd} first so the extra nights are priced`, 'overstay');
      }
      const folio = await this.folios.lockPrimaryForStay(q, propertyId, stay.id);

      // Early departure: nights from today on are not stayed and not charged.
      const leaving = bd > stay.arrivalDate ? bd : addDays(stay.arrivalDate, 1);
      if (leaving < stay.departureDate) {
        const removed = nightsBetween(leaving, stay.departureDate);
        await q.query('DELETE FROM stay_nights WHERE stay_id = $1 AND night_date >= $2', [stay.id, leaving]);
        await q.query('UPDATE stays SET departure_date = $2 WHERE id = $1', [stay.id, leaving]);
        await q.query(
          `INSERT INTO reservation_amendments (property_id, reservation_id, stay_id, kind, previous_values, new_values, price_difference, reason, created_by)
           SELECT $1, $2, $3, 'early_departure', $4, $5, 0, 'Checked out early', $6`,
          [propertyId, stay.reservationId, stay.id, JSON.stringify({ departure: stay.departureDate }), JSON.stringify({ departure: leaving, nightsRemoved: removed }), this.actor()],
        );
      }
      const posted = await this.postDueNights(q, stay, folio, leaving);

      const { rows: pending } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM folio_payments WHERE folio_id = $1 AND status = 'pending'`, [folio.id]);
      if (pending[0].n) throw conflict(`${pending[0].n} payment(s) on folio ${folio.number} are still pending; confirm or fail them first`, 'pending_payments');
      await assertNoOpenChecksForStay(q, stay.id);

      if (input.tenders?.length) await this.folios.recordTenders(q, folio, input.tenders);
      let balance = Money.of((await this.folios.balance(q, folio.id)).balance);
      const cityLedger = !!input.creditTransfer && balance.compare(0) > 0;
      if (input.creditTransfer && balance.compare(0) > 0) {
        const approvalId = await this.approvals.approve({
          permission: 'approve.credit_transfer', propertyId, action: 'folio.credit_transfer', entityType: 'folio', entityId: folio.id,
          reason: input.creditTransfer.reason, approval: input.approval, details: { amount: balance.toString(), companyId: input.creditTransfer.companyId },
        });
        await this.folios.recordTenders(q, folio, [{ tender: 'city_ledger', amount: balance.toString() }], { companyId: input.creditTransfer.companyId, approvalId });
        balance = Money.of((await this.folios.balance(q, folio.id)).balance);
      }
      if (!balance.isZero()) {
        throw conflict(
          balance.isNegative()
            ? `The guest has paid ${balance.negate().format()} more than the charges; refunds arrive with BIL-07`
            : `Balance of ${balance.format()} is still due; take payment or approve a credit transfer`,
          'balance_not_zero',
          { balance: balance.toString(), roomNightsPosted: posted },
        );
      }

      const lines = await this.folios.folioLines(q, folio.id);
      const totals = await this.folios.balance(q, folio.id);
      const { rows: [info] } = await q.query(
        `SELECT g.first_name || ' ' || g.last_name AS guest, g.address, c.name AS company, c.kra_pin AS "companyPin", r.number AS "reservationNumber",
                rm.number AS room, s.arrival_date AS arrival, s.departure_date AS departure
           FROM stays s JOIN guests g ON g.id = s.primary_guest_id JOIN reservations r ON r.id = s.reservation_id
           LEFT JOIN companies c ON c.id = r.company_id LEFT JOIN rooms rm ON rm.id = s.room_id
          WHERE s.id = $1`,
        [stay.id],
      );
      const invoice = await this.folios.issueDocument(q, {
        propertyId, type: 'INVOICE', folioId: folio.id, stayId: stay.id, reservationId: stay.reservationId, total: totals.chargesTotal,
        content: {
          property: await this.folios.header(q, propertyId), folioNumber: folio.number, stayNumber: stay.number, ...info,
          charges: lines.charges, payments: lines.payments.filter((p) => p.status === 'confirmed'), taxSummary: lines.taxSummary, totals,
          fiscal: { status: 'not_submitted', note: 'KRA TIMS submission is not yet integrated (INT-02)' },
        },
      });
      await q.query(`UPDATE folios SET status = 'closed', closed_at = now(), closed_by = $2, finalised_at = now() WHERE id = $1`, [folio.id, this.actor()]);
      // Points or cashback on room-charged bills and the stay itself are awarded once the folio is settled;
      // a company bill waits until finance confirms the company paid (S03, LAT08).
      await this.loyalty.onFolioSettled(q, { propertyId, folioId: folio.id, stayId: stay.id, cityLedger, businessDate: bd });
      await q.query(`UPDATE stays SET status = 'checked_out', checked_out_at = now(), checked_out_by = $2 WHERE id = $1`, [stay.id, this.actor()]);
      // Free tonight onward on the current room; past nights stay on record.
      const alloc = await this.rooms.activeAllocation(q, stay.id);
      if (alloc && alloc.from >= leaving) {
        await this.rooms.releaseStay(q, stay.id, 'checked_out');
      } else if (alloc && alloc.to > leaving) {
        await this.rooms.resizeAllocation(q, alloc.id, alloc.from, leaving, '');
      }
      if (stay.roomId) await this.rooms.markDirty(q, stay.roomId);
      await this.audit.record({
        action: 'stay.check_out', entityType: 'stay', entityId: stay.id, propertyId,
        newValues: { invoice: invoice.number, total: totals.chargesTotal, roomNightsPosted: posted },
      });
      return { stayId: stay.id, stayNumber: stay.number, folioNumber: folio.number, invoice, totals };
    });
  }

  // -------------------------------------------------------------------------
  // Basic day close (BIL-10 stand-in)
  // -------------------------------------------------------------------------

  /**
   * Posts tonight's room charge once for every in-house stay, records the day
   * as closed and advances the business date. The full night audit (BIL-10:
   * unresolved transactions, reconciliation, locked dates) is still to come.
   */
  async closeDay(propertyId: string, expectedDate: string) {
    return this.db.tx(async (q) => {
      const { rows: [p] } = await q.query<{ d: string }>(
        'SELECT current_business_date::text AS d FROM properties WHERE id = $1 FOR NO KEY UPDATE',
        [propertyId],
      );
      if (p.d !== expectedDate) throw conflict(`The business date is ${p.d}, not ${expectedDate}; it may already have been closed`, 'stale_business_date');
      await assertOutletDaysClosed(q, propertyId, p.d);
      const { rows: stays } = await q.query<{ id: string }>(`SELECT id FROM stays WHERE property_id = $1 AND status = 'checked_in' ORDER BY number`, [propertyId]);
      let posted = 0;
      for (const { id } of stays) {
        const stay = await this.reservations.stay(q, propertyId, id, true);
        const folio = await this.folios.lockPrimaryForStay(q, propertyId, id);
        posted += await this.postDueNights(q, stay, folio, addDays(p.d, 1));
      }
      const { rows: notArrived } = await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM stays WHERE property_id = $1 AND status IN ('hold', 'confirmed') AND arrival_date <= $2`,
        [propertyId, p.d],
      );
      await q.query('INSERT INTO business_days (property_id, business_date, room_charges_posted, closed_by) VALUES ($1, $2, $3, $4)', [
        propertyId, p.d, posted, this.actor(),
      ]);
      const next = addDays(p.d, 1);
      await q.query('UPDATE properties SET current_business_date = $2 WHERE id = $1', [propertyId, next]);
      await this.audit.record({ action: 'business_day.close', entityType: 'property', entityId: propertyId, propertyId, businessDate: p.d, newValues: { posted, next } });
      return { closedDate: p.d, businessDate: next, roomChargesPosted: posted, arrivalsNotCheckedIn: notArrived[0].n };
    });
  }

  // -------------------------------------------------------------------------
  // Guest requests (FD-07)
  // -------------------------------------------------------------------------

  async listRequests(propertyId: string, status?: string) {
    const { rows } = await this.db.query(
      `SELECT r.id, r.category, r.description, r.priority, r.status, r.due_at AS "dueAt", r.created_at AS "createdAt",
              r.completed_at AS "completedAt", rm.number AS "roomNumber", s.number AS "stayNumber", s.id AS "stayId",
              g.first_name || ' ' || g.last_name AS "guestName", o.display_name AS "owner", r.owner_user_id AS "ownerUserId",
              c.display_name AS "createdBy",
              coalesce((SELECT json_agg(json_build_object('note', n.note, 'by', nu.display_name, 'at', n.created_at) ORDER BY n.id)
                          FROM guest_request_notes n LEFT JOIN users nu ON nu.id = n.created_by WHERE n.request_id = r.id), '[]') AS notes
         FROM guest_requests r
         LEFT JOIN stays s ON s.id = r.stay_id
         LEFT JOIN rooms rm ON rm.id = coalesce(r.room_id, s.room_id)
         LEFT JOIN guests g ON g.id = s.primary_guest_id
         LEFT JOIN users o ON o.id = r.owner_user_id
         LEFT JOIN users c ON c.id = r.created_by
        WHERE r.property_id = $1 AND ($2::text IS NULL OR r.status = $2)
        ORDER BY (r.status IN ('done', 'cancelled')), r.priority = 'urgent' DESC, r.due_at NULLS LAST, r.created_at`,
      [propertyId, status ?? null],
    );
    return rows;
  }

  private async checkOwner(q: Queryable, propertyId: string, ownerUserId: string | null | undefined): Promise<void> {
    if (!ownerUserId) return;
    const { rowCount } = await q.query(
      `SELECT 1 FROM users u WHERE u.id = $1 AND u.is_active
          AND (u.all_properties OR EXISTS (SELECT 1 FROM user_property_access a WHERE a.user_id = u.id AND a.property_id = $2))`,
      [ownerUserId, propertyId],
    );
    if (!rowCount) throw new BadRequestException('The owner must be an active user at this property');
  }

  async createRequest(propertyId: string, input: GuestRequestInput) {
    return this.db.tx(async (q) => {
      if (input.stayId) await this.reservations.stay(q, propertyId, input.stayId);
      if (input.roomId) await this.rooms.room(q, propertyId, input.roomId);
      await this.checkOwner(q, propertyId, input.ownerUserId);
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO guest_requests (property_id, stay_id, room_id, category, description, priority, owner_user_id, due_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [propertyId, input.stayId ?? null, input.roomId ?? null, input.category, input.description, input.priority ?? 'normal',
         input.ownerUserId ?? null, input.dueAt ?? null, this.actor()],
      );
      await this.audit.record({ action: 'guest_request.create', entityType: 'guest_request', entityId: rows[0].id, propertyId, newValues: input });
      return { id: rows[0].id };
    });
  }

  async updateRequest(propertyId: string, id: string, input: { status?: string; ownerUserId?: string | null; note?: string }) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ status: string; owner_user_id: string | null }>(
        'SELECT status, owner_user_id FROM guest_requests WHERE property_id = $1 AND id = $2 FOR UPDATE',
        [propertyId, id],
      );
      if (!rows[0]) throw new NotFoundException('Request not found at this property');
      if (input.ownerUserId !== undefined) await this.checkOwner(q, propertyId, input.ownerUserId);
      if (input.status || input.ownerUserId !== undefined) {
        await q.query(
          `UPDATE guest_requests SET status = coalesce($3, status), owner_user_id = CASE WHEN $4 THEN $5::uuid ELSE owner_user_id END,
                  completed_at = CASE WHEN coalesce($3, status) = 'done' THEN coalesce(completed_at, now()) ELSE NULL END
            WHERE id = $1 AND property_id = $2`,
          [id, propertyId, input.status ?? null, input.ownerUserId !== undefined, input.ownerUserId ?? null],
        );
      }
      if (input.note) {
        await q.query('INSERT INTO guest_request_notes (request_id, property_id, note, created_by) VALUES ($1, $2, $3, $4)', [id, propertyId, input.note, this.actor()]);
      }
      await this.audit.record({ action: 'guest_request.update', entityType: 'guest_request', entityId: id, propertyId, previousValues: rows[0], newValues: input });
      return { id };
    });
  }

  /** Active staff with access to the property, for assigning requests. */
  async staff(propertyId: string) {
    const { rows } = await this.db.query(
      `SELECT u.id, u.display_name AS "displayName", coalesce(array_agg(r.role_code ORDER BY r.role_code) FILTER (WHERE r.role_code IS NOT NULL), '{}') AS roles
         FROM users u LEFT JOIN user_roles r ON r.user_id = u.id
        WHERE u.is_active AND EXISTS (SELECT 1 FROM user_property_access a WHERE a.user_id = u.id AND a.property_id = $1)
        GROUP BY u.id ORDER BY u.display_name`,
      [propertyId],
    );
    return rows;
  }
}
