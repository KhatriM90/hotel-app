import { Injectable, NotFoundException } from '@nestjs/common';
import { addMonths, LoyaltyUnit, Money } from '@hotel/shared';
import Decimal from 'decimal.js';
import { DbService, Queryable } from '../db/db.service';
import { requestContext, SYSTEM_SCOPE } from '../db/request-context';
import { conflict } from '../frontoffice/common';

export interface MemberRow {
  id: string;
  number: string;
  kind: 'individual' | 'corporate';
  displayName: string;
  status: string;
  guestId: string | null;
  companyId: string | null;
  phone: string | null;
  staffUserId: string | null;
  staffFlagged: boolean;
  mergedIntoId: string | null;
}

export const MEMBER_COLUMNS = `id, number, kind, display_name AS "displayName", status, guest_id AS "guestId", company_id AS "companyId", phone,
  staff_user_id AS "staffUserId", staff_flagged AS "staffFlagged", merged_into_id AS "mergedIntoId"`;

export interface EventContext {
  propertyId?: string | null;
  outletId?: string | null;
  businessDate?: string | null;
  checkId?: string | null;
  folioId?: string | null;
  stayId?: string | null;
  returnId?: string | null;
  batchId?: string | null;
  programmeVersionId?: string | null;
  originalEventId?: string | null;
  reason?: string | null;
  approvalId?: string | null;
  details?: Record<string, unknown> | null;
}

export interface PostInput extends EventContext {
  key: string;
  memberId: string;
  unit: LoyaltyUnit;
  type: 'earn' | 'credit' | 'redeem' | 'restore' | 'reverse' | 'adjust' | 'expire' | 'merge_in' | 'merge_out';
  /** Signed change: positive adds to the balance, negative takes from it. */
  amount: string;
  /** KES value of the change (points × point value; the amount itself for the wallet). */
  value: string;
  /** For additions: when the new lot expires (null = never). */
  expiresAt?: string | null;
  lotKind?: 'earned' | 'credited' | 'restored' | 'adjustment' | 'merged';
  /** For takings: let the balance go negative into a deficit (S17, CLUB06). */
  allowDeficit?: boolean;
  /** For takings: draw from this event's lots first (a reversal takes back its own earning). */
  preferSourceEventId?: string | null;
}

export interface Posted {
  eventId: string;
  duplicate: boolean;
}

export interface UnitBalance {
  /** Spendable now: unexpired lots less active reservations; negative while in deficit. */
  available: string;
  reserved: string;
  pending: string;
  deficit: string;
  total: string;
  expiring: Array<{ date: string; amount: string }>;
}

/**
 * The append-only loyalty ledger (LOY16). Balances live in lots with their own
 * expiry; every change is an event with a unique business key, so a retried
 * request returns the original result without moving the balance again (S22).
 * Callers lock the member row first (lockMember), which serialises tills
 * redeeming the same balance (S20, LAT06, CAT10).
 */
@Injectable()
export class LoyaltyLedgerService {
  constructor(private readonly db: DbService) {}

  async member(q: Queryable, memberId: string, lock = false): Promise<MemberRow> {
    const { rows } = await q.query<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM loyalty_members WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [memberId]);
    if (!rows[0]) throw new NotFoundException('Member not found');
    return rows[0];
  }

  lockMember(q: Queryable, memberId: string): Promise<MemberRow> {
    return this.member(q, memberId, true);
  }

  private actor() {
    const user = requestContext.get()?.user;
    return { id: user?.id ?? null, roles: user?.roles ?? null };
  }

  /** Appends one event and moves the lots. Idempotent on `key`. */
  async post(q: Queryable, p: PostInput): Promise<Posted> {
    const amount = new Decimal(p.amount);
    if (amount.isZero()) throw new Error('A loyalty event must change the balance');
    if (p.unit === 'points' && !amount.isInteger()) throw new Error('Points are whole numbers');
    const actor = this.actor();
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO loyalty_events (event_key, member_id, unit, type, amount, value, property_id, outlet_id, business_date, check_id, folio_id, stay_id,
                                   return_id, batch_id, programme_version_id, original_event_id, actor, actor_roles, reason, approval_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       ON CONFLICT (event_key) DO NOTHING RETURNING id::text`,
      [p.key, p.memberId, p.unit, p.type, amount.toFixed(2), Money.of(p.value).toString(), p.propertyId ?? null, p.outletId ?? null,
       p.businessDate ?? null, p.checkId ?? null, p.folioId ?? null, p.stayId ?? null, p.returnId ?? null, p.batchId ?? null,
       p.programmeVersionId ?? null, p.originalEventId ?? null, actor.id, actor.roles, p.reason ?? null, p.approvalId ?? null,
       p.details ? JSON.stringify(p.details) : null],
    );
    if (!rows[0]) {
      const { rows: [existing] } = await q.query<{ id: string }>('SELECT id::text FROM loyalty_events WHERE event_key = $1', [p.key]);
      return { eventId: existing.id, duplicate: true };
    }
    const eventId = rows[0].id;
    if (amount.isPositive()) await this.add(q, p, eventId, amount);
    else await this.take(q, p, eventId, amount.negated());
    return { eventId, duplicate: false };
  }

  private async move(q: Queryable, lotId: string, eventId: string, amount: Decimal) {
    await q.query('UPDATE loyalty_lots SET remaining = remaining + $2 WHERE id = $1', [lotId, amount.toFixed(2)]);
    await q.query('INSERT INTO loyalty_lot_movements (lot_id, event_id, amount) VALUES ($1, $2, $3)', [lotId, eventId, amount.toFixed(2)]);
  }

  /** New value pays off a deficit first; the rest becomes a lot with its expiry. */
  private async add(q: Queryable, p: PostInput, eventId: string, amount: Decimal) {
    let left = amount;
    const { rows: [deficit] } = await q.query<{ id: string; remaining: string }>(
      `SELECT id, remaining::text FROM loyalty_lots WHERE member_id = $1 AND unit = $2 AND kind = 'deficit' AND remaining < 0 FOR UPDATE`,
      [p.memberId, p.unit],
    );
    if (deficit) {
      const pay = Decimal.min(left, new Decimal(deficit.remaining).negated());
      await this.move(q, deficit.id, eventId, pay);
      left = left.minus(pay);
    }
    if (left.lte(0)) return;
    const { rows: [lot] } = await q.query<{ id: string }>(
      `INSERT INTO loyalty_lots (member_id, unit, kind, original, remaining, expires_at, property_id, source_event_id)
       VALUES ($1, $2, $3, $4, 0, $5, $6, $7) RETURNING id`,
      [p.memberId, p.unit, p.lotKind ?? 'earned', left.toFixed(2), p.expiresAt ?? null, p.propertyId ?? null, eventId],
    );
    await this.move(q, lot.id, eventId, left);
  }

  /**
   * Takes from unexpired lots, the event's own lots first when asked, then the
   * earliest expiry (LOY13). What cannot be covered goes into the deficit lot
   * when allowed (S17); otherwise it is refused.
   */
  private async take(q: Queryable, p: PostInput, eventId: string, amount: Decimal) {
    const { rows: lots } = await q.query<{ id: string; remaining: string }>(
      `SELECT id, remaining::text FROM loyalty_lots
        WHERE member_id = $1 AND unit = $2 AND kind <> 'deficit' AND remaining > 0 AND (expires_at IS NULL OR expires_at > now())
        ORDER BY (source_event_id = $3::bigint) DESC NULLS LAST, expires_at ASC NULLS LAST, created_at, id
        FOR UPDATE`,
      [p.memberId, p.unit, p.preferSourceEventId ?? null],
    );
    let left = amount;
    for (const lot of lots) {
      if (left.lte(0)) break;
      const use = Decimal.min(left, new Decimal(lot.remaining));
      await this.move(q, lot.id, eventId, use.negated());
      left = left.minus(use);
    }
    if (left.lte(0)) return;
    if (!p.allowDeficit) throw conflict(`Not enough ${p.unit === 'points' ? 'points' : 'wallet credit'} available`, 'insufficient_balance');
    const { rows: [deficit] } = await q.query<{ id: string }>(
      `SELECT id FROM loyalty_lots WHERE member_id = $1 AND unit = $2 AND kind = 'deficit' FOR UPDATE`,
      [p.memberId, p.unit],
    );
    let lotId = deficit?.id;
    if (!lotId) {
      const { rows: [created] } = await q.query<{ id: string }>(
        `INSERT INTO loyalty_lots (member_id, unit, kind, original, remaining, expires_at, property_id, source_event_id)
         VALUES ($1, $2, 'deficit', 0, 0, NULL, $3, $4) RETURNING id`,
        [p.memberId, p.unit, p.propertyId ?? null, eventId],
      );
      lotId = created.id;
    }
    await this.move(q, lotId, eventId, left.negated());
  }

  /**
   * Restores what an event took, back into the lots it came from (LOY14): a
   * lot still valid keeps its expiry; one that has expired since gets a new lot
   * with the configured grace period.
   */
  async restore(q: Queryable, p: Omit<PostInput, 'type' | 'expiresAt' | 'lotKind'> & { fromEventId: string; graceDays: number }): Promise<Posted> {
    const amount = new Decimal(p.amount);
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO loyalty_events (event_key, member_id, unit, type, amount, value, property_id, outlet_id, business_date, check_id, folio_id, stay_id,
                                   return_id, batch_id, programme_version_id, original_event_id, actor, actor_roles, reason, approval_id, details)
       VALUES ($1, $2, $3, 'restore', $4, $5, $6, $7, $8, $9, NULL, NULL, $10, $11, $12, $13, $14, $15, $16, NULL, $17)
       ON CONFLICT (event_key) DO NOTHING RETURNING id::text`,
      [p.key, p.memberId, p.unit, amount.toFixed(2), Money.of(p.value).toString(), p.propertyId ?? null, p.outletId ?? null, p.businessDate ?? null,
       p.checkId ?? null, p.returnId ?? null, p.batchId ?? null, p.programmeVersionId ?? null, p.fromEventId, this.actor().id, this.actor().roles,
       p.reason ?? null, p.details ? JSON.stringify(p.details) : null],
    );
    if (!rows[0]) {
      const { rows: [existing] } = await q.query<{ id: string }>('SELECT id::text FROM loyalty_events WHERE event_key = $1', [p.key]);
      return { eventId: existing.id, duplicate: true };
    }
    const eventId = rows[0].id;
    // Lots the original event drew from, minus what earlier restorations already put back.
    const { rows: sources } = await q.query<{ lotId: string; taken: string; expiresAt: string | null; valid: boolean }>(
      `SELECT m.lot_id AS "lotId",
              (-sum(m.amount) - coalesce((SELECT sum(r.amount) FROM loyalty_lot_movements r JOIN loyalty_events e ON e.id = r.event_id
                                          WHERE r.lot_id = m.lot_id AND e.type = 'restore' AND e.original_event_id = $1), 0))::text AS taken,
              l.expires_at AS "expiresAt", (l.expires_at IS NULL OR l.expires_at > now()) AND l.expired_event_id IS NULL AS valid
         FROM loyalty_lot_movements m JOIN loyalty_lots l ON l.id = m.lot_id
        WHERE m.event_id = $1 AND m.amount < 0 AND l.kind <> 'deficit'
        GROUP BY m.lot_id, l.expires_at, l.expired_event_id ORDER BY l.expires_at DESC NULLS FIRST`,
      [p.fromEventId],
    );
    let left = amount;
    let graceNeeded = new Decimal(0);
    for (const s of sources) {
      if (left.lte(0)) break;
      const back = Decimal.min(left, Decimal.max(new Decimal(s.taken), 0));
      if (back.lte(0)) continue;
      if (s.valid) await this.move(q, s.lotId, eventId, back);
      else graceNeeded = graceNeeded.plus(back);
      left = left.minus(back);
    }
    graceNeeded = graceNeeded.plus(Decimal.max(left, 0));
    if (graceNeeded.gt(0)) {
      const expires = new Date(Date.now() + p.graceDays * 86_400_000).toISOString();
      await this.add(q, { ...p, type: 'restore', lotKind: 'restored', expiresAt: expires }, eventId, graceNeeded);
    }
    return { eventId, duplicate: false };
  }

  /**
   * Records expiry of lots past their date (LOY14) as events, never by
   * overwriting a balance. A member with an active reservation is left until it
   * ends, so a valid hold at checkout is protected (S24).
   */
  async expireDue(q: Queryable, memberId?: string): Promise<number> {
    const { rows } = await q.query<{ id: string; memberId: string; unit: LoyaltyUnit; remaining: string; propertyId: string | null }>(
      `SELECT l.id, l.member_id AS "memberId", l.unit, l.remaining::text, l.property_id AS "propertyId" FROM loyalty_lots l
        WHERE l.kind <> 'deficit' AND l.remaining > 0 AND l.expires_at <= now() AND l.expired_event_id IS NULL
          AND ($1::uuid IS NULL OR l.member_id = $1)
          AND NOT EXISTS (SELECT 1 FROM loyalty_reservations r WHERE r.member_id = l.member_id AND r.status = 'active' AND r.expires_at > now())
        ORDER BY l.expires_at LIMIT 500 FOR UPDATE OF l`,
      [memberId ?? null],
    );
    for (const lot of rows) {
      const value = lot.unit === 'points' ? await this.pointsValueNow(q, lot.remaining) : lot.remaining;
      const { rows: [ev] } = await q.query<{ id: string }>(
        `INSERT INTO loyalty_events (event_key, member_id, unit, type, amount, value, property_id, reason)
         VALUES ($1, $2, $3, 'expire', $4, $5, $6, 'Expired') ON CONFLICT (event_key) DO NOTHING RETURNING id::text`,
        [`expire:${lot.id}`, lot.memberId, lot.unit, new Decimal(lot.remaining).negated().toFixed(2), Money.of(value).negate().toString(), lot.propertyId],
      );
      if (!ev) continue;
      await this.move(q, lot.id, ev.id, new Decimal(lot.remaining).negated());
      await q.query('UPDATE loyalty_lots SET expired_event_id = $2 WHERE id = $1', [lot.id, ev.id]);
    }
    return rows.length;
  }

  private async pointsValueNow(q: Queryable, points: string): Promise<string> {
    const { rows: [v] } = await q.query<{ pv: string | null }>(
      `SELECT settings #>> '{points,pointValue}' AS pv FROM loyalty_programme_versions WHERE effective_from <= now() ORDER BY effective_from DESC, version DESC LIMIT 1`,
    );
    return new Decimal(points).times(v?.pv ?? '1').toFixed(2);
  }

  /** Group-wide expiry sweep for the maintenance job. */
  async expireAll(): Promise<number> {
    return this.db.tx((q) => this.expireDue(q), SYSTEM_SCOPE);
  }

  async balance(q: Queryable, memberId: string, unit: LoyaltyUnit, excludeCheckId?: string | null): Promise<UnitBalance> {
    const { rows: [b] } = await q.query<{ lots: string; deficit: string; reserved: string; pending: string; total: string }>(
      `SELECT coalesce(sum(remaining) FILTER (WHERE kind <> 'deficit' AND (expires_at IS NULL OR expires_at > now())), 0)::text AS lots,
              coalesce(sum(remaining) FILTER (WHERE kind = 'deficit'), 0)::text AS deficit,
              (SELECT coalesce(sum(amount), 0) FROM loyalty_reservations r
                WHERE r.member_id = $1 AND r.unit = $2 AND r.status = 'active' AND r.expires_at > now()
                  AND ($3::uuid IS NULL OR r.check_id <> $3))::text AS reserved,
              (SELECT coalesce(sum(amount), 0) FROM loyalty_events e WHERE e.member_id = $1 AND e.unit = $2)::text AS total,
              '0' AS pending
         FROM loyalty_lots WHERE member_id = $1 AND unit = $2`,
      [memberId, unit, excludeCheckId ?? null],
    );
    const { rows: expiring } = await q.query<{ date: string; amount: string }>(
      `SELECT (expires_at AT TIME ZONE 'Africa/Nairobi')::date::text AS date, sum(remaining)::text AS amount FROM loyalty_lots
        WHERE member_id = $1 AND unit = $2 AND kind <> 'deficit' AND remaining > 0 AND expires_at > now()
        GROUP BY 1 ORDER BY 1 LIMIT 6`,
      [memberId, unit],
    );
    const fmt = (v: Decimal) => (unit === 'points' ? v.toFixed(0) : v.toFixed(2));
    const available = new Decimal(b.lots).plus(b.deficit).minus(b.reserved);
    return {
      available: fmt(available),
      reserved: fmt(new Decimal(b.reserved)),
      pending: fmt(new Decimal(0)),
      deficit: fmt(new Decimal(b.deficit).negated()),
      total: fmt(new Decimal(b.total)),
      expiring: expiring.map((e) => ({ date: e.date, amount: fmt(new Decimal(e.amount)) })),
    };
  }

  /** Points and wallet balances, with pending entitlement and pending cashback shown apart (LOY13, CLUB05). */
  async balances(q: Queryable, memberId: string, excludeCheckId?: string | null) {
    const points = await this.balance(q, memberId, 'points', excludeCheckId);
    const wallet = await this.balance(q, memberId, 'wallet', excludeCheckId);
    const { rows: [pend] } = await q.query<{ eligible: string; cashback: string }>(
      `SELECT coalesce(sum(eligible_amount) FILTER (WHERE cashback_percent IS NULL), 0)::text AS eligible,
              coalesce(sum(eligible_amount * cashback_percent / 100) FILTER (WHERE cashback_percent IS NOT NULL), 0)::numeric(18,2)::text AS cashback
         FROM loyalty_pending WHERE member_id = $1 AND status IN ('pending', 'awaiting_company_payment')`,
      [memberId],
    );
    // Estimated cashback for months not yet posted (CLUB05 "pending estimated cashback").
    const { rows: [est] } = await q.query<{ estimate: string }>(
      `SELECT coalesce(sum(a.eligible_amount * a.rate_percent / 100), 0)::numeric(18,2)::text AS estimate FROM cashback_accruals a
        WHERE a.member_id = $1 AND NOT EXISTS (
          SELECT 1 FROM cashback_batch_lines bl JOIN cashback_batches b ON b.id = bl.batch_id
           WHERE bl.member_id = a.member_id AND b.month = a.settlement_month AND b.status = 'posted' AND b.created_at >= a.created_at)`,
      [memberId],
    );
    return {
      points: { ...points, pendingEligible: pend.eligible },
      wallet: { ...wallet, pendingCashback: Money.of(est.estimate).add(pend.cashback).toString() },
    };
  }

  /** Lot expiry for a new earning or credit. */
  expiry(months: number, from = new Date().toISOString()): string {
    return addMonths(from, months);
  }
}
