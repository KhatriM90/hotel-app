import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  BookingSource,
  cancellationCharge,
  depositDueDate,
  depositFor,
  firstNightsCharge,
  Money,
  nightsBetween,
  StayStatus,
} from '@hotel/shared';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { requestContext } from '../db/request-context';
import { NumberingService } from '../numbering/numbering.service';
import { ApprovalsService } from './approvals.service';
import { ApprovalInputT, businessDate, conflict, CurrentPropertyT } from './common';
import { FoliosService } from './folios.service';
import { GuestInput, GuestsService } from './guests.service';
import { PolicySnapshot, PricedNight, RatePlanRow, RatesService } from './rates.service';
import { RoomsService } from './rooms.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRow = Record<string, any>;

export type ReservationDetail = AnyRow & {
  stays: AnyRow[];
  total: string;
  deposit: { required: string; received: string; outstanding: string; dueDate: string | null };
};

export type GuestRef = { id: string } | GuestInput;

export interface RateOverride {
  amountPerNight: string;
  reason: string;
}

export interface CreateReservationInput {
  source: BookingSource;
  agentId?: string | null;
  agentReference?: string | null;
  companyId?: string | null;
  notes?: string | null;
  guest: GuestRef;
  arrival: string;
  departure: string;
  status: 'enquiry' | 'hold' | 'confirmed';
  holdMinutes?: number;
  rooms: Array<{
    roomTypeCode: string;
    ratePlanCode: string;
    adults: number;
    children: number;
    roomId?: string | null;
    guest?: GuestRef;
    rateOverride?: RateOverride;
    notes?: string | null;
  }>;
  approval?: ApprovalInputT;
}

export interface AmendInput {
  arrival?: string;
  departure?: string;
  roomTypeCode?: string;
  ratePlanCode?: string;
  adults?: number;
  children?: number;
  roomId?: string | null;
  rateOverride?: RateOverride;
  reason: string;
  approval?: ApprovalInputT;
}

export type LifecycleAction = 'confirm' | 'hold' | 'cancel' | 'no_show';

export interface LifecycleInput {
  stayIds?: string[];
  holdMinutes?: number;
  reason?: string;
  waiveFee?: boolean;
  approval?: ApprovalInputT;
}

export interface StayRow {
  id: string;
  number: string;
  propertyId: string;
  reservationId: string;
  status: StayStatus;
  roomTypeId: string;
  ratePlanId: string;
  roomId: string | null;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  primaryGuestId: string;
  holdExpiresAt: string | null;
}

const STAY_COLUMNS = `
  s.id, s.number, s.property_id AS "propertyId", s.reservation_id AS "reservationId", s.status, s.room_type_id AS "roomTypeId",
  s.rate_plan_id AS "ratePlanId", s.room_id AS "roomId", s.arrival_date AS "arrivalDate", s.departure_date AS "departureDate",
  s.adults, s.children, s.primary_guest_id AS "primaryGuestId", s.hold_expires_at AS "holdExpiresAt"`;

/**
 * Reservations (RES-02 … RES-08). Each room line is a stay with a permanent
 * number, agreed night prices, a physical allocation (when held or confirmed)
 * and its own folio. All changes happen in one transaction with the audit
 * record; numbers are allocated inside it, so a failed booking burns none.
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly db: DbService,
    private readonly numbering: NumberingService,
    private readonly rates: RatesService,
    private readonly rooms: RoomsService,
    private readonly guests: GuestsService,
    private readonly folios: FoliosService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  async stay(q: Queryable, propertyId: string, stayId: string, lock = false): Promise<StayRow> {
    const { rows } = await q.query<StayRow>(
      `SELECT ${STAY_COLUMNS} FROM stays s WHERE s.property_id = $1 AND s.id = $2 ${lock ? 'FOR NO KEY UPDATE' : ''}`,
      [propertyId, stayId],
    );
    if (!rows[0]) throw new NotFoundException('Stay not found at this property');
    return rows[0];
  }

  private async resolveGuest(q: Queryable, ref: GuestRef): Promise<string> {
    if ('id' in ref) {
      const { rowCount } = await q.query('SELECT 1 FROM guests WHERE id = $1', [ref.id]);
      if (!rowCount) throw new UnprocessableEntityException('Guest not found');
      return ref.id;
    }
    return (await this.guests.create(q, ref)).id;
  }

  private checkPlanAllowed(plan: RatePlanRow, companyId: string | null | undefined, agentId: string | null | undefined): void {
    if (plan.isNegotiated && plan.companyId !== companyId && plan.companyId !== agentId) {
      throw new UnprocessableEntityException(`${plan.name} is a negotiated rate for ${plan.companyName}; book it under that company or agent`);
    }
  }

  private async overrideApproval(
    propertyId: string,
    entityId: string | null,
    override: RateOverride,
    approval: ApprovalInputT,
    nights: PricedNight[],
  ): Promise<string> {
    return this.approvals.approve({
      permission: 'approve.rate_override',
      propertyId,
      action: 'reservation.rate_override',
      entityType: 'stay',
      entityId,
      reason: override.reason,
      approval,
      details: { amountPerNight: override.amountPerNight, offered: nights.map((n) => ({ date: n.date, amount: n.amount })) },
    });
  }

  private applyOverride(nights: PricedNight[], override?: RateOverride): PricedNight[] {
    if (!override) return nights;
    const amount = Money.of(override.amountPerNight).toString();
    return nights.map((n) => ({ ...n, base: amount, supplement: '0.00', amount }));
  }

  private async insertNights(
    q: Queryable,
    stay: { id: string; propertyId: string; ratePlanId: string; roomTypeId: string },
    nights: Array<PricedNight & { isOverride?: boolean; approvalId?: string | null }>,
  ): Promise<void> {
    for (const n of nights) {
      await q.query(
        `INSERT INTO stay_nights (stay_id, property_id, night_date, rate_plan_id, room_type_id, base_amount, supplement_amount,
                                  amount, season_name, is_override, approval_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [stay.id, stay.propertyId, n.date, stay.ratePlanId, stay.roomTypeId, n.base, n.supplement, n.amount, n.seasonName,
         n.isOverride ?? false, n.approvalId ?? null],
      );
    }
  }

  async nightAmounts(q: Queryable, stayId: string): Promise<string[]> {
    const { rows } = await q.query<{ amount: string }>('SELECT amount FROM stay_nights WHERE stay_id = $1 ORDER BY night_date', [stayId]);
    return rows.map((r) => r.amount);
  }

  private async recomputeDeposit(q: Queryable, reservationId: string): Promise<void> {
    const { rows } = await q.query<{ policy_snapshot: PolicySnapshot }>('SELECT policy_snapshot FROM reservations WHERE id = $1', [reservationId]);
    const { rows: stays } = await q.query<{ id: string }>(
      `SELECT id FROM stays WHERE reservation_id = $1 AND status NOT IN ('cancelled', 'no_show')`,
      [reservationId],
    );
    let total = Money.zero();
    for (const s of stays) total = total.add(depositFor(rows[0].policy_snapshot, await this.nightAmounts(q, s.id)));
    await q.query('UPDATE reservations SET deposit_required = $2 WHERE id = $1', [reservationId, total.toString()]);
  }

  // -------------------------------------------------------------------------
  // Create (RES-02, RES-04, RES-05, RES-07, RES-08)
  // -------------------------------------------------------------------------

  async create(property: CurrentPropertyT, input: CreateReservationInput) {
    if (input.departure <= input.arrival) throw new BadRequestException('Departure must be after arrival');
    if (!input.rooms.length) throw new BadRequestException('A reservation needs at least one room');
    const actor = requestContext.get()?.user?.id ?? null;

    return this.db.tx(async (q) => {
      const bd = await businessDate(q, property.id);
      if (input.arrival < bd) throw new UnprocessableEntityException(`Arrival ${input.arrival} is before the business date ${bd}`);
      await this.rooms.releaseExpiredHolds(q, property.id);
      const policy = await this.rates.policy(q, property.id);
      const bookerId = await this.resolveGuest(q, input.guest);
      const nights = nightsBetween(input.arrival, input.departure);
      const holdMinutes = input.holdMinutes ?? policy.holdMinutes;

      const number = await this.numbering.next(property.id, 'BOOKING');
      const { rows: [res] } = await q.query<{ id: string }>(
        `INSERT INTO reservations (property_id, number, source, booker_guest_id, company_id, agent_id, agent_reference, notes,
                                   policy_snapshot, deposit_due_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [property.id, number, input.source, bookerId, input.companyId ?? null, input.agentId ?? null, input.agentReference ?? null,
         input.notes ?? null, JSON.stringify(policy), depositDueDate(policy, bd, input.arrival), actor],
      );

      for (const line of input.rooms) {
        const type = await this.rates.roomType(q, property.id, line.roomTypeCode);
        const plan = await this.rates.ratePlan(q, property.id, line.ratePlanCode);
        this.checkPlanAllowed(plan, input.companyId, input.agentId);
        this.rates.checkOccupancy(type, line.adults, line.children);
        const offered = await this.rates.priceNights(q, plan, type, nights, line.adults, line.children);
        const guestId = line.guest ? await this.resolveGuest(q, line.guest) : bookerId;

        const stayNumber = await this.numbering.next(property.id, 'STAY');
        const { rows: [stay] } = await q.query<{ id: string }>(
          `INSERT INTO stays (property_id, number, reservation_id, room_type_id, rate_plan_id, status, arrival_date, departure_date,
                              adults, children, primary_guest_id, hold_expires_at, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6::stay_status, $7, $8, $9, $10, $11,
                   CASE WHEN $6::text = 'hold' THEN now() + make_interval(mins => $12) END, $13, $14)
           RETURNING id`,
          [property.id, stayNumber, res.id, type.id, plan.id, input.status, input.arrival, input.departure, line.adults, line.children,
           guestId, holdMinutes, line.notes ?? null, actor],
        );
        const approvalId = line.rateOverride ? await this.overrideApproval(property.id, stay.id, line.rateOverride, input.approval, offered) : null;
        const agreed = this.applyOverride(offered, line.rateOverride).map((n) => ({ ...n, isOverride: !!line.rateOverride, approvalId }));
        await this.insertNights(q, { id: stay.id, propertyId: property.id, ratePlanId: plan.id, roomTypeId: type.id }, agreed);
        await q.query('INSERT INTO stay_occupants (stay_id, property_id, guest_id, is_primary, added_by) VALUES ($1, $2, $3, true, $4)', [
          stay.id, property.id, guestId, actor,
        ]);

        if (input.status !== 'enquiry') {
          const room = await this.rooms.allocate(q, {
            propertyId: property.id, stayId: stay.id, roomTypeId: type.id, roomId: line.roomId, from: input.arrival, to: input.departure,
          });
          if (room.roomTypeId !== type.id) throw new UnprocessableEntityException(`Room ${room.number} is a ${room.roomTypeName}, not ${type.name}`);
          await q.query('UPDATE stays SET room_id = $2 WHERE id = $1', [stay.id, room.id]);
        }

        const folioNumber = await this.numbering.next(property.id, 'FOLIO');
        await q.query('INSERT INTO folios (property_id, number, stay_id, reservation_id) VALUES ($1, $2, $3, $4)', [
          property.id, folioNumber, stay.id, res.id,
        ]);
      }

      await this.recomputeDeposit(q, res.id);
      await this.audit.record({
        action: 'reservation.create', entityType: 'reservation', entityId: res.id, propertyId: property.id,
        newValues: { number, status: input.status, arrival: input.arrival, departure: input.departure, rooms: input.rooms.length, source: input.source },
      });
      return this.detail(q, property.id, res.id);
    });
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  async list(propertyId: string, f: { from?: string; to?: string; status?: StayStatus; q?: string }) {
    const { rows } = await this.db.query(
      `SELECT r.id, r.number, r.source, r.created_at AS "createdAt", g.first_name || ' ' || g.last_name AS "bookerName",
              c.name AS "companyName", a.name AS "agentName",
              min(s.arrival_date) AS arrival, max(s.departure_date) AS departure, count(s.id)::int AS rooms,
              array_agg(DISTINCT s.status::text) AS statuses,
              string_agg(DISTINCT rm.number, ', ') AS "roomNumbers",
              r.deposit_required AS "depositRequired"
         FROM reservations r
         JOIN guests g ON g.id = r.booker_guest_id
         JOIN stays s ON s.reservation_id = r.id
         LEFT JOIN rooms rm ON rm.id = s.room_id
         LEFT JOIN companies c ON c.id = r.company_id
         LEFT JOIN companies a ON a.id = r.agent_id
        WHERE r.property_id = $1
          AND ($2::date IS NULL OR s.departure_date > $2::date)
          AND ($3::date IS NULL OR s.arrival_date <= $3::date)
          AND ($4::stay_status IS NULL OR s.status = $4::stay_status)
          AND ($5::text IS NULL OR r.number ILIKE '%' || $5 || '%' OR g.first_name || ' ' || g.last_name ILIKE '%' || $5 || '%'
               OR coalesce(r.agent_reference, '') ILIKE '%' || $5 || '%')
        GROUP BY r.id, g.id, c.name, a.name
        ORDER BY min(s.arrival_date), r.number
        LIMIT 200`,
      [propertyId, f.from ?? null, f.to ?? null, f.status ?? null, f.q?.trim() || null],
    );
    return rows;
  }

  get(propertyId: string, id: string) {
    return this.db.tx((q) => this.detail(q, propertyId, id));
  }

  async detail(q: Queryable, propertyId: string, id: string): Promise<ReservationDetail> {
    const { rows } = await q.query<AnyRow & { depositRequired: string }>(
      `SELECT r.id, r.number, r.source, r.agent_reference AS "agentReference", r.notes, r.created_at AS "createdAt",
              r.deposit_required AS "depositRequired", r.deposit_due_date AS "depositDueDate", r.policy_snapshot AS policy,
              json_build_object('id', g.id, 'name', g.first_name || ' ' || g.last_name, 'phone', g.phone, 'email', g.email) AS booker,
              CASE WHEN c.id IS NOT NULL THEN json_build_object('id', c.id, 'name', c.name) END AS company,
              CASE WHEN a.id IS NOT NULL THEN json_build_object('id', a.id, 'name', a.name) END AS agent,
              u.display_name AS "createdBy"
         FROM reservations r JOIN guests g ON g.id = r.booker_guest_id
         LEFT JOIN companies c ON c.id = r.company_id LEFT JOIN companies a ON a.id = r.agent_id
         LEFT JOIN users u ON u.id = r.created_by
        WHERE r.property_id = $1 AND r.id = $2`,
      [propertyId, id],
    );
    if (!rows[0]) throw new NotFoundException('Reservation not found at this property');
    const { rows: stays } = await q.query<AnyRow & { id: string; folioId: string }>(
      `SELECT s.id, s.number, s.status, s.arrival_date AS "arrivalDate", s.departure_date AS "departureDate",
              s.adults, s.children, s.hold_expires_at AS "holdExpiresAt", s.notes,
              t.code AS "roomTypeCode", t.name AS "roomTypeName", rp.code AS "ratePlanCode", rp.name AS "ratePlanName",
              rm.id AS "roomId", rm.number AS "roomNumber", rm.hk_status AS "roomHkStatus",
              json_build_object('id', g.id, 'name', g.first_name || ' ' || g.last_name) AS guest,
              s.checked_in_at AS "checkedInAt", s.checked_out_at AS "checkedOutAt", s.cancelled_at AS "cancelledAt",
              s.cancel_reason AS "cancelReason", s.room_charge_allowed AS "roomChargeAllowed", s.credit_limit AS "creditLimit",
              s.departure_time AS "departureTime", s.registration_acknowledged_at AS "registrationAcknowledgedAt",
              f.id AS "folioId", f.number AS "folioNumber", f.status AS "folioStatus"
         FROM stays s
         JOIN room_types t ON t.id = s.room_type_id JOIN rate_plans rp ON rp.id = s.rate_plan_id
         JOIN guests g ON g.id = s.primary_guest_id
         LEFT JOIN rooms rm ON rm.id = s.room_id
         LEFT JOIN folios f ON f.stay_id = s.id AND f.is_primary
        WHERE s.reservation_id = $1 ORDER BY s.number`,
      [id],
    );
    let depositReceived = Money.zero();
    const out: AnyRow[] = [];
    for (const s of stays) {
      const { rows: nights } = await q.query(
        `SELECT night_date AS date, base_amount AS base, supplement_amount AS supplement, amount, season_name AS "seasonName",
                is_override AS "isOverride" FROM stay_nights WHERE stay_id = $1 ORDER BY night_date`,
        [s.id],
      );
      const { rows: occupants } = await q.query(
        `SELECT g.id, g.first_name || ' ' || g.last_name AS name, o.is_primary AS "isPrimary"
           FROM stay_occupants o JOIN guests g ON g.id = o.guest_id WHERE o.stay_id = $1 ORDER BY o.is_primary DESC, o.added_at`,
        [s.id],
      );
      const balance = await this.folios.balance(q, s.folioId);
      const { rows: dep } = await q.query<{ received: string }>(
        `SELECT coalesce(sum(amount), 0)::numeric(18,2)::text AS received FROM folio_payments WHERE folio_id = $1 AND is_deposit AND status = 'confirmed'`,
        [s.folioId],
      );
      depositReceived = depositReceived.add(dep[0].received);
      out.push({
        ...s,
        nights,
        total: Money.sum((nights as Array<{ amount: string }>).map((n) => Money.of(n.amount))).toString(),
        occupants,
        balance,
      });
    }
    const { rows: amendments } = await q.query(
      `SELECT a.id, s.number AS "stayNumber", a.kind, a.previous_values AS "previous", a.new_values AS "new",
              a.price_difference AS "priceDifference", a.reason, u.display_name AS "by", ap.display_name AS "approvedBy", a.created_at AS "at"
         FROM reservation_amendments a JOIN stays s ON s.id = a.stay_id
         LEFT JOIN users u ON u.id = a.created_by
         LEFT JOIN approvals x ON x.id = a.approval_id LEFT JOIN users ap ON ap.id = x.approved_by
        WHERE a.reservation_id = $1 ORDER BY a.created_at`,
      [id],
    );
    const { rows: documents } = await q.query(
      `SELECT id, document_type AS "documentType", number, total, issued_at AS "issuedAt" FROM documents
        WHERE reservation_id = $1 OR folio_id IN (SELECT id FROM folios WHERE reservation_id = $1) ORDER BY issued_at`,
      [id],
    );
    const statuses = new Set(out.map((s) => s.status as string));
    const required = Money.of(rows[0].depositRequired);
    const outstanding = required.subtract(depositReceived);
    return {
      ...rows[0],
      status: statuses.size === 1 ? [...statuses][0] : 'mixed',
      stays: out,
      deposit: {
        required: required.toString(),
        received: depositReceived.toString(),
        outstanding: outstanding.isNegative() ? '0.00' : outstanding.toString(),
        dueDate: rows[0].depositDueDate,
      },
      total: Money.sum(out.filter((s) => !['cancelled', 'no_show'].includes(s.status as string)).map((s) => Money.of(s.total))).toString(),
      amendments,
      documents,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle (RES-03, RES-07)
  // -------------------------------------------------------------------------

  async lifecycle(propertyId: string, reservationId: string, action: LifecycleAction, input: LifecycleInput) {
    return this.db.tx(async (q) => {
      await this.rooms.releaseExpiredHolds(q, propertyId);
      const { rows } = await q.query<{ id: string }>(
        `SELECT id FROM stays WHERE property_id = $1 AND reservation_id = $2 AND ($3::uuid[] IS NULL OR id = ANY($3)) ORDER BY number`,
        [propertyId, reservationId, input.stayIds ?? null],
      );
      if (!rows.length) throw new NotFoundException('No matching stays on this reservation');
      const eligible: Record<LifecycleAction, StayStatus[]> = {
        confirm: ['enquiry', 'hold'],
        hold: ['enquiry'],
        cancel: ['enquiry', 'hold', 'confirmed'],
        no_show: ['confirmed'],
      };
      let changed = 0;
      for (const { id } of rows) {
        const stay = await this.stay(q, propertyId, id, true);
        if (!eligible[action].includes(stay.status)) {
          if (input.stayIds) throw conflict(`Stay ${stay.number} is ${stay.status}; cannot ${action.replace('_', '-')}`, 'invalid_transition');
          continue; // reservation-wide action: skip stays it does not apply to
        }
        await this[action](q, stay, input);
        changed++;
      }
      if (!changed) throw conflict(`No stay on this reservation can be ${action === 'no_show' ? 'marked no-show' : `${action}ed`}`, 'invalid_transition');
      await this.recomputeDeposit(q, reservationId);
      return this.detail(q, propertyId, reservationId);
    });
  }

  private async confirm(q: Queryable, stay: StayRow, _input: LifecycleInput): Promise<void> {
    if (stay.status === 'enquiry') await this.allocateFor(q, stay);
    await q.query(`UPDATE stays SET status = 'confirmed', hold_expires_at = NULL WHERE id = $1`, [stay.id]);
    await this.audit.record({ action: 'stay.confirm', entityType: 'stay', entityId: stay.id, propertyId: stay.propertyId, previousValues: { status: stay.status } });
  }

  private async hold(q: Queryable, stay: StayRow, input: LifecycleInput): Promise<void> {
    const policy = await this.snapshot(q, stay.reservationId);
    await this.allocateFor(q, stay);
    await q.query(`UPDATE stays SET status = 'hold', hold_expires_at = now() + make_interval(mins => $2) WHERE id = $1`, [
      stay.id,
      input.holdMinutes ?? policy.holdMinutes,
    ]);
    await this.audit.record({ action: 'stay.hold', entityType: 'stay', entityId: stay.id, propertyId: stay.propertyId });
  }

  private async allocateFor(q: Queryable, stay: StayRow): Promise<void> {
    const bd = await businessDate(q, stay.propertyId);
    if (stay.arrivalDate < bd) throw conflict(`Stay ${stay.number} arrives ${stay.arrivalDate}, before the business date; amend the dates first`, 'past_arrival');
    const room = await this.rooms.allocate(q, {
      propertyId: stay.propertyId, stayId: stay.id, roomTypeId: stay.roomTypeId, roomId: null, from: stay.arrivalDate, to: stay.departureDate,
    });
    await q.query('UPDATE stays SET room_id = $2 WHERE id = $1', [stay.id, room.id]);
  }

  private async snapshot(q: Queryable, reservationId: string): Promise<PolicySnapshot> {
    const { rows } = await q.query<{ policy_snapshot: PolicySnapshot }>('SELECT policy_snapshot FROM reservations WHERE id = $1', [reservationId]);
    return rows[0].policy_snapshot;
  }

  /** Posts a cancellation or no-show charge, or records an approved waiver (RES-07). */
  private async policyFee(q: Queryable, stay: StayRow, code: 'CANCEL_FEE' | 'NO_SHOW_FEE', amount: string, input: LifecycleInput): Promise<string> {
    if (Money.of(amount).isZero()) return '0.00';
    if (input.waiveFee) {
      await this.approvals.approve({
        permission: 'approve.fee_waiver', propertyId: stay.propertyId, action: `stay.${code.toLowerCase()}_waiver`, entityType: 'stay',
        entityId: stay.id, reason: input.reason ?? 'Fee waived', approval: input.approval, details: { amount },
      });
      return '0.00';
    }
    const folio = await this.folios.lockPrimaryForStay(q, stay.propertyId, stay.id);
    await this.folios.postCharge(q, {
      folio, chargeCode: code, description: code === 'CANCEL_FEE' ? `Cancellation charge, ${stay.number}` : `No-show charge, ${stay.number}`,
      quantity: '1', unitPrice: amount, serviceDate: await businessDate(q, stay.propertyId),
    });
    return amount;
  }

  private async cancel(q: Queryable, stay: StayRow, input: LifecycleInput): Promise<void> {
    if (!input.reason) throw new BadRequestException('A cancellation needs a reason');
    let fee = '0.00';
    if (stay.status === 'confirmed') {
      const policy = await this.snapshot(q, stay.reservationId);
      const { rows } = await q.query<{ at: Date }>(
        `SELECT (($1::date + $2::time) AT TIME ZONE p.timezone) AS at FROM properties p WHERE p.id = $3`,
        [stay.arrivalDate, policy.checkInTime, stay.propertyId],
      );
      fee = await this.policyFee(q, stay, 'CANCEL_FEE', cancellationCharge(policy, await this.nightAmounts(q, stay.id), new Date(), rows[0].at), input);
    }
    await this.rooms.releaseStay(q, stay.id, 'cancelled');
    await q.query(
      `UPDATE stays SET status = 'cancelled', hold_expires_at = NULL, cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1`,
      [stay.id, requestContext.get()?.user?.id ?? null, input.reason],
    );
    await this.audit.record({
      action: 'stay.cancel', entityType: 'stay', entityId: stay.id, propertyId: stay.propertyId,
      previousValues: { status: stay.status }, newValues: { fee, waived: !!input.waiveFee }, reason: input.reason,
    });
  }

  private async no_show(q: Queryable, stay: StayRow, input: LifecycleInput): Promise<void> {
    const bd = await businessDate(q, stay.propertyId);
    if (bd < stay.arrivalDate) throw conflict(`Stay ${stay.number} is not due until ${stay.arrivalDate}`, 'not_due');
    const policy = await this.snapshot(q, stay.reservationId);
    const fee = await this.policyFee(q, stay, 'NO_SHOW_FEE', firstNightsCharge(policy.noShowNights, await this.nightAmounts(q, stay.id)), input);
    await this.rooms.releaseStay(q, stay.id, 'no_show');
    await q.query(`UPDATE stays SET status = 'no_show', no_show_at = now(), cancel_reason = $2 WHERE id = $1`, [stay.id, input.reason ?? null]);
    await this.audit.record({
      action: 'stay.no_show', entityType: 'stay', entityId: stay.id, propertyId: stay.propertyId,
      newValues: { fee, waived: !!input.waiveFee }, reason: input.reason ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // Amendments (RES-06, FD-06 extensions)
  // -------------------------------------------------------------------------

  async amend(propertyId: string, stayId: string, input: AmendInput) {
    return this.db.tx(async (q) => {
      await this.rooms.releaseExpiredHolds(q, propertyId);
      const bd = await businessDate(q, propertyId, true);
      const stay = await this.stay(q, propertyId, stayId, true);
      if (!['enquiry', 'hold', 'confirmed', 'checked_in'].includes(stay.status)) {
        throw conflict(`Stay ${stay.number} is ${stay.status} and can no longer be amended`, 'invalid_transition');
      }
      const inHouse = stay.status === 'checked_in';
      const arrival = input.arrival ?? stay.arrivalDate;
      const departure = input.departure ?? stay.departureDate;
      if (departure <= arrival) throw new BadRequestException('Departure must be after arrival');
      if (inHouse) {
        if (arrival !== stay.arrivalDate) throw conflict('The guest is in house; the arrival date cannot change', 'in_house');
        if (input.roomTypeCode || input.roomId) throw conflict('The guest is in house; use a room move to change rooms (FD-05)', 'in_house');
        if (departure <= bd) throw conflict(`Departure must be after the business date ${bd}; check the guest out instead`, 'in_house');
      } else if (arrival < bd) {
        throw new UnprocessableEntityException(`Arrival ${arrival} is before the business date ${bd}`);
      }

      const oldType = await this.rates.roomTypeById(q, stay.roomTypeId);
      const oldPlan = await this.rates.ratePlanById(q, stay.ratePlanId);
      const type = input.roomTypeCode ? await this.rates.roomType(q, propertyId, input.roomTypeCode) : oldType;
      const plan = input.ratePlanCode ? await this.rates.ratePlan(q, propertyId, input.ratePlanCode) : oldPlan;
      const adults = input.adults ?? stay.adults;
      const children = input.children ?? stay.children;
      this.rates.checkOccupancy(type, adults, children);
      if (plan.id !== oldPlan.id) {
        const { rows } = await q.query<{ company_id: string | null; agent_id: string | null }>('SELECT company_id, agent_id FROM reservations WHERE id = $1', [stay.reservationId]);
        this.checkPlanAllowed(plan, rows[0].company_id, rows[0].agent_id);
      }

      // Agreed prices are kept for nights that stay the same; added or changed nights use current rates (RES-05/06).
      const reprice = type.id !== oldType.id || plan.id !== oldPlan.id || adults !== stay.adults || children !== stay.children || !!input.rateOverride;
      const { rows: oldNights } = await q.query<PricedNight & { isOverride: boolean; approvalId: string | null; ratePlanId: string; roomTypeId: string }>(
        `SELECT night_date AS date, base_amount AS base, supplement_amount AS supplement, amount, season_name AS "seasonName",
                false AS weekend, is_override AS "isOverride", approval_id AS "approvalId",
                rate_plan_id AS "ratePlanId", room_type_id AS "roomTypeId"
           FROM stay_nights WHERE stay_id = $1 ORDER BY night_date`,
        [stay.id],
      );
      const kept = new Map(oldNights.map((n) => [n.date, n]));
      const wanted = nightsBetween(arrival, departure);
      const keep = (d: string) => kept.has(d) && (!reprice || (inHouse && d < bd));
      const toPrice = wanted.filter((d) => !keep(d));
      const offered = await this.rates.priceNights(q, plan, type, toPrice, adults, children);
      const approvalId = input.rateOverride ? await this.overrideApproval(propertyId, stay.id, input.rateOverride, input.approval, offered) : null;
      const priced = new Map(this.applyOverride(offered, input.rateOverride).map((n) => [n.date, { ...n, isOverride: !!input.rateOverride, approvalId }]));
      const newNights = wanted.map((d) => (keep(d) ? kept.get(d)! : priced.get(d)!));

      // Physical allocation follows the new dates; the exclusion constraint has the final say (RES-04, FD-06).
      const alloc = await this.rooms.activeAllocation(q, stay.id);
      let roomId = stay.roomId;
      if (alloc) {
        const currentRoom = await this.rooms.room(q, propertyId, alloc.roomId);
        const sameRoom = type.id === oldType.id && (!input.roomId || input.roomId === alloc.roomId);
        if (inHouse) {
          await this.rooms.resizeAllocation(q, alloc.id, alloc.from, departure, currentRoom.number);
        } else if (sameRoom) {
          try {
            await this.rooms.resizeAllocation(q, alloc.id, arrival, departure, currentRoom.number);
          } catch (err) {
            if (input.roomId) throw err;
            await this.rooms.releaseStay(q, stay.id, 'amended');
            roomId = (await this.rooms.allocate(q, { propertyId, stayId: stay.id, roomTypeId: type.id, from: arrival, to: departure })).id;
          }
        } else {
          await this.rooms.releaseStay(q, stay.id, 'amended');
          const room = await this.rooms.allocate(q, { propertyId, stayId: stay.id, roomTypeId: type.id, roomId: input.roomId, from: arrival, to: departure });
          if (room.roomTypeId !== type.id) throw new UnprocessableEntityException(`Room ${room.number} is a ${room.roomTypeName}, not ${type.name}`);
          roomId = room.id;
        }
      }

      const oldTotal = Money.sum(oldNights.map((n) => Money.of(n.amount)));
      const newTotal = Money.sum(newNights.map((n) => Money.of(n.amount)));
      await q.query('DELETE FROM stay_nights WHERE stay_id = $1', [stay.id]);
      await q.query(
        `UPDATE stays SET arrival_date = $2, departure_date = $3, room_type_id = $4, rate_plan_id = $5, adults = $6, children = $7, room_id = $8
          WHERE id = $1`,
        [stay.id, arrival, departure, type.id, plan.id, adults, children, roomId],
      );
      // Kept nights keep their own plan and type; only repriced ones take the new ones.
      for (const n of newNights) {
        const old = keep(n.date) ? kept.get(n.date)! : null;
        await this.insertNights(
          q,
          { id: stay.id, propertyId, ratePlanId: old ? old.ratePlanId : plan.id, roomTypeId: old ? old.roomTypeId : type.id },
          [n],
        );
      }
      const previous = { arrival: stay.arrivalDate, departure: stay.departureDate, roomType: oldType.code, ratePlan: oldPlan.code, adults: stay.adults, children: stay.children, total: oldTotal.toString() };
      const next = { arrival, departure, roomType: type.code, ratePlan: plan.code, adults, children, total: newTotal.toString() };
      const difference = newTotal.subtract(oldTotal).toString();
      await q.query(
        `INSERT INTO reservation_amendments (property_id, reservation_id, stay_id, kind, previous_values, new_values, price_difference,
                                             reason, approval_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [propertyId, stay.reservationId, stay.id, inHouse && departure !== stay.departureDate ? 'extension' : 'amendment',
         JSON.stringify(previous), JSON.stringify(next), difference, input.reason, approvalId, requestContext.get()?.user?.id ?? null],
      );
      await this.recomputeDeposit(q, stay.reservationId);
      await this.audit.record({ action: 'stay.amend', entityType: 'stay', entityId: stay.id, propertyId, previousValues: previous, newValues: next, reason: input.reason });
      return { priceDifference: difference, reservation: await this.detail(q, propertyId, stay.reservationId) };
    });
  }

  // -------------------------------------------------------------------------
  // Pro forma (BIL-09)
  // -------------------------------------------------------------------------

  async proforma(propertyId: string, reservationId: string) {
    return this.db.tx(async (q) => {
      const r = await this.detail(q, propertyId, reservationId);
      const stays = r.stays.filter((s) => !['cancelled', 'no_show'].includes(s.status as string));
      if (!stays.length) throw conflict('Nothing to quote: every stay is cancelled', 'nothing_to_quote');
      const doc = await this.folios.issueDocument(q, {
        propertyId, type: 'PROFORMA', reservationId, total: r.total,
        content: {
          property: await this.folios.header(q, propertyId),
          reservationNumber: r.number,
          booker: r.booker,
          company: r.company,
          agent: r.agent,
          stays: stays.map((s) => ({
            number: s.number, roomType: s.roomTypeName, ratePlan: s.ratePlanName, arrival: s.arrivalDate, departure: s.departureDate,
            adults: s.adults, children: s.children, nights: s.nights, total: s.total,
          })),
          total: r.total,
          deposit: r.deposit,
          policy: r.policy,
        },
      });
      await this.audit.record({ action: 'document.proforma', entityType: 'reservation', entityId: reservationId, propertyId, newValues: doc });
      return doc;
    });
  }
}

