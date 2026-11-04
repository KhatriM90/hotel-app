import { BadRequestException, Injectable } from '@nestjs/common';
import { Money } from '@hotel/shared';
import { DbService } from '../db/db.service';
import { LoyaltyProgrammeService } from './programme.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function range(from?: string, to?: string): { from: string; to: string } {
  const today = new Date().toISOString().slice(0, 10);
  const f = from ?? `${today.slice(0, 7)}-01`;
  const t = to ?? today;
  if (!DATE_RE.test(f) || !DATE_RE.test(t) || f > t) throw new BadRequestException('Give a valid date range (from ≤ to, YYYY-MM-DD)');
  return { from: f, to: t };
}

/**
 * Loyalty reports (LOY19, LOY21, LOY22, CLUB07): ledger movement that must
 * reconcile, outstanding liability with its expiry profile, the cost of
 * rewards by property and outlet, pending entitlement and misuse exceptions.
 * Dates are East Africa time; balances are group-wide because members are.
 */
@Injectable()
export class LoyaltyReportsService {
  constructor(
    private readonly db: DbService,
    private readonly programme: LoyaltyProgrammeService,
  ) {}

  /**
   * LOY19 movement: opening + movements = closing for each unit, and the
   * ledger total must equal what the lots hold. Any difference is shown.
   */
  async movement(fromInput?: string, toInput?: string) {
    const { from, to } = range(fromInput, toInput);
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ unit: string; type: string; opening: string; amount: string; value: string; closing: string }>(
        `WITH b AS (SELECT $1::date::timestamp AT TIME ZONE 'Africa/Nairobi' AS f, ($2::date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi' AS t)
         SELECT u.unit, t.type,
                (SELECT coalesce(sum(amount), 0) FROM loyalty_events, b WHERE unit = u.unit AND created_at < b.f)::text AS opening,
                coalesce(sum(e.amount), 0)::text AS amount, coalesce(sum(e.value), 0)::text AS value,
                (SELECT coalesce(sum(amount), 0) FROM loyalty_events, b WHERE unit = u.unit AND created_at < b.t)::text AS closing
           FROM (VALUES ('points'), ('wallet')) u(unit)
           CROSS JOIN (VALUES ('earn'), ('credit'), ('redeem'), ('restore'), ('reverse'), ('adjust'), ('expire'), ('merge_in'), ('merge_out')) t(type)
           CROSS JOIN b
           LEFT JOIN loyalty_events e ON e.unit = u.unit AND e.type = t.type AND e.created_at >= b.f AND e.created_at < b.t
          GROUP BY u.unit, t.type ORDER BY u.unit, t.type`,
        [from, to],
      );
      const { rows: lots } = await q.query<{ unit: string; held: string; ledger: string }>(
        `SELECT u.unit, (SELECT coalesce(sum(remaining), 0) FROM loyalty_lots WHERE unit = u.unit)::text AS held,
                (SELECT coalesce(sum(amount), 0) FROM loyalty_events WHERE unit = u.unit)::text AS ledger
           FROM (VALUES ('points'), ('wallet')) u(unit)`,
      );
      const units = ['points', 'wallet'].map((unit) => {
        const r = rows.filter((x) => x.unit === unit);
        const movements = Object.fromEntries(r.map((x) => [x.type, { amount: x.amount, value: x.value }]));
        const opening = r[0]?.opening ?? '0';
        const closing = r[0]?.closing ?? '0';
        const net = Money.sum(r.map((x) => Money.of(x.amount)));
        const lot = lots.find((l) => l.unit === unit)!;
        return {
          unit, opening, movements, closing,
          identityDifference: Money.of(opening).add(net).subtract(closing).toString(),
          ledgerTotal: lot.ledger, lotsTotal: lot.held, lotsDifference: Money.of(lot.ledger).subtract(lot.held).toString(),
        };
      });
      return { from, to, units, reconciled: units.every((u) => Money.of(u.identityDifference).isZero() && Money.of(u.lotsDifference).isZero()) };
    });
  }

  /** LOY21 liability: outstanding points (at today's point value) and wallet credit, by property and by expiry month. */
  async liability() {
    return this.db.tx(async (q) => {
      const v = await this.programme.current(q);
      const pv = v.settings.points.pointValue;
      const { rows: byProperty } = await q.query(
        `SELECT coalesce(p.code, 'GROUP') AS property, l.unit, sum(l.remaining)::text AS outstanding,
                (sum(l.remaining) * CASE WHEN l.unit = 'points' THEN $1::numeric ELSE 1 END)::numeric(18,2)::text AS value,
                count(DISTINCT l.member_id)::int AS members
           FROM loyalty_lots l LEFT JOIN properties p ON p.id = l.property_id
          WHERE l.remaining <> 0 GROUP BY 1, l.unit ORDER BY 1, l.unit`,
        [pv],
      );
      const { rows: byExpiry } = await q.query(
        `SELECT coalesce(to_char(l.expires_at AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM'), 'no expiry') AS month, l.unit, sum(l.remaining)::text AS outstanding,
                (sum(l.remaining) * CASE WHEN l.unit = 'points' THEN $1::numeric ELSE 1 END)::numeric(18,2)::text AS value
           FROM loyalty_lots l WHERE l.remaining > 0 GROUP BY 1, l.unit ORDER BY 1, l.unit`,
        [pv],
      );
      const { rows: deficits } = await q.query(
        `SELECT m.number, m.display_name AS name, l.unit, l.remaining::text AS amount FROM loyalty_lots l JOIN loyalty_members m ON m.id = l.member_id
          WHERE l.kind = 'deficit' AND l.remaining < 0 ORDER BY l.remaining`,
      );
      const { rows: [cb] } = await q.query<{ accrued: string }>(
        `SELECT coalesce(sum(a.eligible_amount * a.rate_percent / 100), 0)::numeric(18,2)::text AS accrued FROM cashback_accruals a
          WHERE NOT EXISTS (SELECT 1 FROM cashback_batch_lines bl JOIN cashback_batches b ON b.id = bl.batch_id
                             WHERE b.month = a.settlement_month AND bl.member_id = a.member_id AND b.status = 'posted')`,
      );
      return {
        pointValue: pv, byProperty, byExpiry, deficits, cashbackAccruedNotPosted: cb.accrued,
        totals: {
          points: Money.sum(byProperty.filter((r) => r.unit === 'points').map((r) => Money.of(r.value))).toString(),
          wallet: Money.sum(byProperty.filter((r) => r.unit === 'wallet').map((r) => Money.of(r.value))).toString(),
        },
      };
    });
  }

  /** Cost of the programme by property and outlet: discounts given, rewards used, points earned, cashback accrued. */
  async activity(fromInput?: string, toInput?: string) {
    const { from, to } = range(fromInput, toInput);
    return this.db.tx(async (q) => {
      const { rows } = await q.query(
        `SELECT p.code AS property, o.code AS outlet, o.name AS "outletName", count(DISTINCT c.id)::int AS bills,
                count(DISTINCT c.loyalty_member_id)::int AS members,
                coalesce(sum(lo.member_discount), 0)::text AS "memberDiscount",
                coalesce(sum(lo.points_redeemed), 0)::int AS "pointsRedeemed", coalesce(sum(lo.wallet_redeemed), 0)::text AS "walletRedeemed",
                coalesce(sum(lo.points_earned), 0)::int AS "pointsEarned", coalesce(sum(lo.points_pending), 0)::int AS "pointsPending",
                coalesce(sum(lo.cashback_pending), 0)::text AS "cashbackAccrued"
           FROM pos_checks c JOIN loyalty_check_outcomes lo ON lo.check_id = c.id JOIN outlets o ON o.id = c.outlet_id JOIN properties p ON p.id = c.property_id
          WHERE c.business_date BETWEEN $1 AND $2 GROUP BY p.code, o.code, o.name ORDER BY p.code, o.code`,
        [from, to],
      );
      const { rows: enrolments } = await q.query(
        `SELECT coalesce(p.code, '—') AS property, m.enrolment_channel AS channel, count(*)::int AS members
           FROM loyalty_members m LEFT JOIN properties p ON p.id = m.enrolled_property_id
          WHERE (m.created_at AT TIME ZONE 'Africa/Nairobi')::date BETWEEN $1 AND $2 GROUP BY 1, 2 ORDER BY 1, 2`,
        [from, to],
      );
      return { from, to, outlets: rows, enrolments };
    });
  }

  /** Points and cashback waiting for a folio to settle or a company to pay (S03, LAT08). */
  async pending() {
    const { rows } = await this.db.query(
      `SELECT lp.id, m.number, m.display_name AS name, p.code AS property, lp.source, lp.status, lp.eligible_amount::text AS eligible,
              lp.cashback_percent::text AS "cashbackPercent", lp.sale_date AS "saleDate", lp.folio_id AS "folioId", f.number AS folio, c.number AS "check"
         FROM loyalty_pending lp JOIN loyalty_members m ON m.id = lp.member_id JOIN properties p ON p.id = lp.property_id
         LEFT JOIN folios f ON f.id = lp.folio_id LEFT JOIN pos_checks c ON c.id = lp.check_id
        WHERE lp.status IN ('pending', 'awaiting_company_payment') ORDER BY lp.sale_date, m.number`,
    );
    return rows;
  }

  /**
   * LOY22 exceptions: staff on their own bills, many bills a day, one waiter
   * serving most of a member's bills, manual adjustments, merges, negative
   * balances and rewards released after timing out.
   */
  async exceptions(fromInput?: string, toInput?: string) {
    const { from, to } = range(fromInput, toInput);
    return this.db.tx(async (q) => {
      const s = (await this.programme.current(q)).settings;
      const { rows: staffOwn } = await q.query(
        `SELECT m.number, m.display_name AS name, c.number AS "check", p.code AS property, c.business_date AS date, lo.note
           FROM loyalty_check_outcomes lo JOIN loyalty_members m ON m.id = lo.member_id JOIN pos_checks c ON c.id = lo.check_id JOIN properties p ON p.id = c.property_id
          WHERE m.staff_flagged AND c.business_date BETWEEN $1 AND $2 ORDER BY c.business_date DESC`,
        [from, to],
      );
      const { rows: frequent } = await q.query(
        `SELECT m.number, m.display_name AS name, c.business_date AS date, count(*)::int AS bills
           FROM pos_checks c JOIN loyalty_members m ON m.id = c.loyalty_member_id
          WHERE c.status = 'closed' AND c.business_date BETWEEN $1 AND $2
          GROUP BY m.number, m.display_name, c.business_date HAVING count(*) >= $3 ORDER BY bills DESC`,
        [from, to, s.misuse.billsPerDayAlert],
      );
      const { rows: waiter } = await q.query(
        `WITH x AS (SELECT c.loyalty_member_id AS member_id, c.waiter_id, count(*) AS n, sum(count(*)) OVER (PARTITION BY c.loyalty_member_id) AS total
                      FROM pos_checks c WHERE c.status = 'closed' AND c.loyalty_member_id IS NOT NULL AND c.business_date BETWEEN $1 AND $2
                     GROUP BY c.loyalty_member_id, c.waiter_id)
         SELECT m.number, m.display_name AS name, u.display_name AS waiter, x.n::int AS bills, x.total::int AS "memberBills",
                round(100 * x.n / x.total)::int AS "sharePercent"
           FROM x JOIN loyalty_members m ON m.id = x.member_id JOIN users u ON u.id = x.waiter_id
          WHERE x.total >= 5 AND 100 * x.n / x.total >= $3 ORDER BY "sharePercent" DESC`,
        [from, to, s.misuse.waiterSharePercentAlert],
      );
      const { rows: manual } = await q.query(
        `SELECT e.created_at AS at, m.number, m.display_name AS name, e.type, e.unit, e.amount::text, e.reason, u.display_name AS "by", a.display_name AS "approvedBy"
           FROM loyalty_events e JOIN loyalty_members m ON m.id = e.member_id LEFT JOIN users u ON u.id = e.actor
           LEFT JOIN approvals ap ON ap.id = e.approval_id LEFT JOIN users a ON a.id = ap.approved_by
          WHERE e.type IN ('adjust', 'merge_in', 'merge_out') AND (e.created_at AT TIME ZONE 'Africa/Nairobi')::date BETWEEN $1 AND $2 ORDER BY e.created_at DESC`,
        [from, to],
      );
      const { rows: timeouts } = await q.query(
        `SELECT r.created_at AS at, m.number, c.number AS "check", r.unit, r.amount::text, r.release_reason AS reason
           FROM loyalty_reservations r JOIN loyalty_members m ON m.id = r.member_id JOIN pos_checks c ON c.id = r.check_id
          WHERE r.status = 'released' AND r.release_reason IN ('Timed out', 'Bill voided', 'Bill cancelled') AND (r.created_at AT TIME ZONE 'Africa/Nairobi')::date BETWEEN $1 AND $2
          ORDER BY r.created_at DESC`,
        [from, to],
      );
      const { rows: failedOtp } = await q.query(
        `SELECT v.created_at AS at, m.number, v.attempts FROM loyalty_verifications v JOIN loyalty_members m ON m.id = v.member_id
          WHERE v.verified_at IS NULL AND v.attempts > 1 AND (v.created_at AT TIME ZONE 'Africa/Nairobi')::date BETWEEN $1 AND $2 ORDER BY v.created_at DESC`,
        [from, to],
      );
      return { from, to, thresholds: s.misuse, staffOwn, frequent, waiter, manual, timeouts, failedOtp };
    });
  }
}
