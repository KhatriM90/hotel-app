import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { allocateMoney, Money, monthlyCashback } from '@hotel/shared';
import Decimal from 'decimal.js';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { ApprovalsService } from '../frontoffice/approvals.service';
import { ApprovalInputT, conflict } from '../frontoffice/common';
import { actorId } from '../pos/common';
import { LoyaltyCheckoutService } from './checkout.service';
import { LoyaltyLedgerService } from './ledger.service';
import { LoyaltyProgrammeService } from './programme.service';

/** A batch line as calculated: what the member is owed for the month (CLUB03). */
export interface Line {
  memberId: string;
  number: string;
  name: string;
  spend: string;
  returns: string;
  raw: string;
  entitlement: string;
  previouslyCredited: string;
  amount: string;
  flags: string[];
  rates: Array<{ rate: string; eligible: string; source: string }>;
  byProperty: Record<string, string>;
}

const HIGH_CREDIT = '20000.00';

function monthStart(month: string): string {
  if (!/^\d{4}-\d{2}(-01)?$/.test(month)) throw new BadRequestException('Month must be YYYY-MM');
  return `${month.slice(0, 7)}-01`;
}

/**
 * Month-end club cashback (CLUB03, CLUB04, CLUB06, CLUB07): a draft batch
 * from the month's settled accruals at each sale's own rate, reviewed and
 * approved by finance, then posted to members' wallets once. Late returns and
 * late settlements after posting go into an adjustment batch for the same
 * month; the posted batch is never edited.
 */
@Injectable()
export class CashbackService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LoyaltyLedgerService,
    private readonly programme: LoyaltyProgrammeService,
    private readonly checkout: LoyaltyCheckoutService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  /** What a batch for the month would credit now, per member, net of anything already posted. */
  private async calculate(q: Queryable, month: string): Promise<{ lines: Line[]; pending: unknown[] }> {
    const s = (await this.programme.current(q)).settings;
    const { rows: acc } = await q.query<{
      memberId: string; number: string; name: string; status: string; staffFlagged: boolean; kind: string;
      eligible: string; rate: string; source: string; propertyCode: string;
    }>(
      `SELECT a.member_id AS "memberId", m.number, m.display_name AS name, m.status, m.staff_flagged AS "staffFlagged", a.kind,
              a.eligible_amount::text AS eligible, a.rate_percent::text AS rate, a.rate_source AS source, p.code AS "propertyCode"
         FROM cashback_accruals a JOIN loyalty_members m ON m.id = a.member_id JOIN properties p ON p.id = a.property_id
        WHERE a.settlement_month = $1 ORDER BY m.number, a.id`,
      [month],
    );
    const { rows: prev } = await q.query<{ memberId: string; credited: string }>(
      `SELECT l.member_id AS "memberId", sum(l.amount)::text AS credited FROM cashback_batch_lines l JOIN cashback_batches b ON b.id = l.batch_id
        WHERE b.month = $1 AND b.status = 'posted' AND l.status = 'posted' GROUP BY l.member_id`,
      [month],
    );
    const credited = new Map(prev.map((p) => [p.memberId, p.credited]));
    const byMember = new Map<string, typeof acc>();
    for (const a of acc) byMember.set(a.memberId, [...(byMember.get(a.memberId) ?? []), a]);
    for (const id of credited.keys()) if (!byMember.has(id)) byMember.set(id, []);

    const lines: Line[] = [];
    for (const [memberId, items] of byMember) {
      const result = monthlyCashback(items.map((i) => ({ eligible: i.eligible, ratePercent: i.rate })), s.club.minMonthlySpend, s.club.monthlyCap);
      const previouslyCredited = credited.get(memberId) ?? '0.00';
      const amount = Money.of(result.credit).subtract(previouslyCredited).toString();
      const rates = new Map<string, { rate: string; eligible: Decimal; source: string }>();
      const byProp = new Map<string, Decimal>();
      for (const i of items) {
        const k = `${i.rate}|${i.source}`;
        const r = rates.get(k) ?? { rate: i.rate, eligible: new Decimal(0), source: i.source };
        r.eligible = r.eligible.plus(i.eligible);
        rates.set(k, r);
        byProp.set(i.propertyCode, (byProp.get(i.propertyCode) ?? new Decimal(0)).plus(new Decimal(i.eligible).times(i.rate).dividedBy(100)));
      }
      // The posting amount split by property, in proportion to each property's share of the credit (CLUB07).
      const codes = [...byProp.keys()];
      const weights = codes.map((c) => Decimal.max(0, byProp.get(c)!).toFixed(6));
      const split = weights.some((w) => new Decimal(w).gt(0)) ? allocateMoney(Money.of(amount).toString().replace('-', ''), weights) : codes.map(() => '0.00');
      const sign = Money.of(amount).isNegative() ? '-' : '';
      const first = items[0];
      const flags: string[] = [];
      if (first?.staffFlagged) flags.push('staff member');
      if (first && first.status !== 'active') flags.push(`member ${first.status}`);
      if (result.belowMinimum && items.length) flags.push('below minimum monthly spend');
      if (result.capped) flags.push('monthly cap applied');
      if (items.some((i) => i.kind === 'return')) flags.push('includes returns');
      if (Money.of(amount).isNegative()) flags.push('reduces wallet (return after posting)');
      if (Money.of(amount).compare(HIGH_CREDIT) > 0) flags.push('unusually high');
      const m = first ?? (await q.query<{ number: string; name: string }>('SELECT number, display_name AS name FROM loyalty_members WHERE id = $1', [memberId])).rows[0];
      lines.push({
        memberId, number: m.number, name: m.name,
        spend: Money.sum(items.filter((i) => i.kind === 'sale').map((i) => Money.of(i.eligible))).toString(),
        returns: Money.sum(items.filter((i) => i.kind === 'return').map((i) => Money.of(i.eligible))).toString(),
        raw: result.raw, entitlement: result.credit, previouslyCredited, amount, flags,
        rates: [...rates.values()].map((r) => ({ rate: r.rate, eligible: r.eligible.toFixed(2), source: r.source })),
        byProperty: Object.fromEntries(codes.map((c, i) => [c, `${sign}${split[i]}`])),
      });
    }
    // Sales still waiting on a folio or company payment: they join the month they settle in (S03).
    const { rows: pending } = await q.query(
      `SELECT m.number, m.display_name AS name, p.code AS property, lp.source, lp.status, lp.eligible_amount::text AS eligible,
              lp.cashback_percent::text AS rate, lp.sale_date AS "saleDate"
         FROM loyalty_pending lp JOIN loyalty_members m ON m.id = lp.member_id JOIN properties p ON p.id = lp.property_id
        WHERE lp.status IN ('pending', 'awaiting_company_payment') AND lp.cashback_percent IS NOT NULL AND date_trunc('month', lp.sale_date) <= $1::date
        ORDER BY lp.sale_date`,
      [month],
    );
    return { lines: lines.filter((l) => !Money.of(l.amount).isZero() || l.flags.length || !Money.of(l.spend).isZero()), pending };
  }

  private totals(lines: Line[]) {
    return {
      members: lines.length,
      spend: Money.sum(lines.map((l) => Money.of(l.spend))).toString(),
      returns: Money.sum(lines.map((l) => Money.of(l.returns))).toString(),
      amount: Money.sum(lines.map((l) => Money.of(l.amount))).toString(),
      flagged: lines.filter((l) => l.flags.length).length,
    };
  }

  /** CLUB03 preview: nothing is saved. */
  async preview(monthInput: string) {
    const month = monthStart(monthInput);
    return this.db.tx(async (q) => {
      const { lines, pending } = await this.calculate(q, month);
      const { rows: batches } = await q.query(
        `SELECT id, kind, status, totals, created_at AS "createdAt", posted_at AS "postedAt" FROM cashback_batches WHERE month = $1 ORDER BY created_at`,
        [month],
      );
      const posted = batches.some((b) => b.kind === 'regular' && b.status === 'posted');
      return {
        month, nextBatch: posted ? 'adjustment' : 'regular', monthEnded: new Date(month).getTime() < Date.now() && month.slice(0, 7) < new Date().toISOString().slice(0, 7),
        totals: this.totals(lines), lines, pending, batches,
      };
    });
  }

  async list() {
    const { rows } = await this.db.query(
      `SELECT b.id, to_char(b.month, 'YYYY-MM') AS month, b.kind, b.status, b.totals, b.note, b.created_at AS "createdAt", c.display_name AS "createdBy",
              b.approved_at AS "approvedAt", a.display_name AS "approvedBy", b.posted_at AS "postedAt"
         FROM cashback_batches b LEFT JOIN users c ON c.id = b.created_by LEFT JOIN users a ON a.id = b.approved_by
        ORDER BY b.month DESC, b.created_at DESC LIMIT 100`,
    );
    return rows;
  }

  async get(batchId: string) {
    return this.db.tx(async (q) => {
      const { rows: [b] } = await q.query(
        `SELECT b.id, to_char(b.month, 'YYYY-MM') AS month, b.kind, b.status, b.totals, b.note, b.created_at AS "createdAt", c.display_name AS "createdBy",
                b.approved_at AS "approvedAt", a.display_name AS "approvedBy", b.posted_at AS "postedAt"
           FROM cashback_batches b LEFT JOIN users c ON c.id = b.created_by LEFT JOIN users a ON a.id = b.approved_by WHERE b.id = $1`,
        [batchId],
      );
      if (!b) throw new NotFoundException('Cashback batch not found');
      const { rows: lines } = await q.query(
        `SELECT l.member_id AS "memberId", m.number, m.display_name AS name, l.qualifying_spend::text AS spend, l.returns::text AS returns,
                l.rate_breakdown AS breakdown, l.raw_credit::text AS raw, l.entitlement::text AS entitlement, l.previously_credited::text AS "previouslyCredited",
                l.amount::text AS amount, l.flags, l.status, l.error
           FROM cashback_batch_lines l JOIN loyalty_members m ON m.id = l.member_id WHERE l.batch_id = $1 ORDER BY m.number`,
        [batchId],
      );
      return { ...b, lines };
    });
  }

  /**
   * Saves the preview as a draft batch (CLUB03). The first batch for a month
   * is the regular one; once that is posted, later changes form an adjustment.
   */
  async generate(monthInput: string, note: string | null) {
    const month = monthStart(monthInput);
    return this.db.tx(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cashback:${month}`]);
      const { rows: live } = await q.query<{ id: string; kind: string; status: string }>(
        `SELECT id, kind, status FROM cashback_batches WHERE month = $1 AND status <> 'discarded'`,
        [month],
      );
      const open = live.find((b) => b.status !== 'posted');
      if (open) throw conflict(`A ${open.kind} batch for this month is already ${open.status}; finish or discard it first`, 'batch_open', { batchId: open.id });
      const kind = live.some((b) => b.kind === 'regular') ? 'adjustment' : 'regular';
      const { lines } = await this.calculate(q, month);
      const toPost = kind === 'adjustment' ? lines.filter((l) => !Money.of(l.amount).isZero()) : lines;
      if (kind === 'adjustment' && !toPost.length) throw conflict('Nothing has changed since the month was posted', 'nothing_to_adjust');
      const v = await this.programme.current(q);
      const { rows: [b] } = await q.query<{ id: string }>(
        `INSERT INTO cashback_batches (month, kind, programme_version_id, totals, created_by, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [month, kind, v.id, JSON.stringify(this.totals(toPost)), actorId(), note],
      );
      for (const l of toPost) {
        await q.query(
          `INSERT INTO cashback_batch_lines (batch_id, member_id, qualifying_spend, returns, rate_breakdown, raw_credit, entitlement, previously_credited, amount, flags, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [b.id, l.memberId, l.spend, l.returns, JSON.stringify({ rates: l.rates, byProperty: l.byProperty }), l.raw, l.entitlement, l.previouslyCredited, l.amount,
           l.flags, Money.of(l.amount).isZero() ? 'skipped' : 'pending'],
        );
      }
      await this.audit.record({ action: 'loyalty.cashback_generated', entityType: 'cashback_batch', entityId: b.id, reason: note, newValues: { month, kind, ...this.totals(toPost) } });
      return this.get(b.id);
    });
  }

  async discard(batchId: string, reason: string) {
    return this.db.tx(async (q) => {
      const { rows: [b] } = await q.query<{ status: string }>('SELECT status FROM cashback_batches WHERE id = $1 FOR UPDATE', [batchId]);
      if (!b) throw new NotFoundException('Cashback batch not found');
      if (!['draft', 'approved'].includes(b.status)) throw conflict(`A ${b.status} batch cannot be discarded`, 'batch_final');
      await q.query(`UPDATE cashback_batches SET status = 'discarded', note = coalesce(note || ' · ', '') || $2 WHERE id = $1`, [batchId, `Discarded: ${reason}`]);
      await this.audit.record({ action: 'loyalty.cashback_discarded', entityType: 'cashback_batch', entityId: batchId, reason });
      return this.get(batchId);
    });
  }

  /**
   * Finance approval (CLUB04): the batch must still match a fresh calculation,
   * so nothing settled after the draft slips through unreviewed.
   */
  async approve(batchId: string, input: { reason: string; approval?: ApprovalInputT }) {
    return this.db.tx(async (q) => {
      const { rows: [b] } = await q.query<{ status: string; month: string; kind: string; totals: { amount: string } }>(
        `SELECT status, month::text AS month, kind, totals FROM cashback_batches WHERE id = $1 FOR UPDATE`,
        [batchId],
      );
      if (!b) throw new NotFoundException('Cashback batch not found');
      if (b.status !== 'draft') throw conflict(`This batch is already ${b.status}`, 'batch_not_draft');
      const fresh = await this.calculate(q, b.month);
      const freshAmount = this.totals(b.kind === 'adjustment' ? fresh.lines.filter((l) => !Money.of(l.amount).isZero()) : fresh.lines).amount;
      if (!Money.of(freshAmount).equals(b.totals.amount)) {
        throw conflict(`Sales or returns settled since this draft (now KES ${freshAmount}); discard it and generate again`, 'batch_stale', { now: freshAmount });
      }
      // Group-wide batches are approved against the head office (one legal entity).
      const { rows: [hq] } = await q.query<{ id: string }>('SELECT id FROM properties WHERE is_head_office ORDER BY code LIMIT 1');
      if (!hq) throw conflict('No head office property is visible to you', 'no_head_office');
      const approvalId = await this.approvals.approve({
        permission: 'approve.cashback_batch', propertyId: hq.id, action: 'loyalty.cashback_batch', entityType: 'cashback_batch', entityId: batchId,
        reason: input.reason, approval: input.approval, details: { month: b.month, kind: b.kind, amount: b.totals.amount },
      });
      const { rows: [a] } = await q.query<{ approvedBy: string }>('SELECT approved_by AS "approvedBy" FROM approvals WHERE id = $1', [approvalId]);
      await q.query(`UPDATE cashback_batches SET status = 'approved', approved_at = now(), approved_by = $2, approval_id = $3 WHERE id = $1`, [batchId, a?.approvedBy ?? actorId(), approvalId]);
      return this.get(batchId);
    });
  }

  /**
   * Credits each member's wallet once (event key per batch and member, S22)
   * and sends one expense/liability journal per property to SAP (CLUB07).
   * A member that fails is marked and the batch goes to exception; posting
   * again finishes only what is left.
   */
  async post(batchId: string) {
    return this.db.tx(async (q) => {
      const { rows: [b] } = await q.query<{ status: string; month: string; kind: string; versionId: string }>(
        `SELECT status, month::text AS month, kind, programme_version_id AS "versionId" FROM cashback_batches WHERE id = $1 FOR UPDATE`,
        [batchId],
      );
      if (!b) throw new NotFoundException('Cashback batch not found');
      if (!['approved', 'exception'].includes(b.status)) throw conflict(b.status === 'posted' ? 'This batch is already posted' : 'Approve the batch before posting', 'batch_not_approved');
      await q.query(`UPDATE cashback_batches SET status = 'posting' WHERE id = $1`, [batchId]);
      const v = await this.programme.byId(q, b.versionId);
      const { rows: lines } = await q.query<{ memberId: string; amount: string; breakdown: { byProperty: Record<string, string> } }>(
        `SELECT member_id AS "memberId", amount::text, rate_breakdown AS breakdown FROM cashback_batch_lines WHERE batch_id = $1 AND status IN ('pending', 'exception')`,
        [batchId],
      );
      let failed = 0;
      const byProperty = new Map<string, Money>();
      for (const l of lines) {
        try {
          await q.query('SAVEPOINT cashback_line');
          try {
              await this.ledger.lockMember(q, l.memberId);
              const credit = !Money.of(l.amount).isNegative();
              const posted = await this.ledger.post(q, {
                key: `cashback:${batchId}:${l.memberId}`, memberId: l.memberId, unit: 'wallet', type: credit ? 'credit' : 'reverse', amount: l.amount, value: l.amount,
                batchId, programmeVersionId: v.id, lotKind: 'credited', expiresAt: credit ? this.ledger.expiry(v.settings.club.walletExpiryMonths) : null,
                allowDeficit: true, reason: `Club cashback ${b.month.slice(0, 7)}${b.kind === 'adjustment' ? ' (adjustment)' : ''}`,
                details: { month: b.month.slice(0, 7), kind: b.kind },
              });
              await q.query(`UPDATE cashback_batch_lines SET status = 'posted', wallet_event_id = $3, error = NULL WHERE batch_id = $1 AND member_id = $2`, [batchId, l.memberId, posted.eventId]);
            await q.query('RELEASE SAVEPOINT cashback_line');
          } catch (e) {
            await q.query('ROLLBACK TO SAVEPOINT cashback_line');
            throw e;
          }
          for (const [code, amt] of Object.entries(l.breakdown.byProperty ?? {})) byProperty.set(code, (byProperty.get(code) ?? Money.zero()).add(amt));
        } catch (e) {
          failed++;
          await q.query(`UPDATE cashback_batch_lines SET status = 'exception', error = $3 WHERE batch_id = $1 AND member_id = $2`, [batchId, l.memberId, (e as Error).message]);
        }
      }
      for (const [code, amount] of byProperty) {
        if (amount.isZero()) continue;
        const { rows: [p] } = await q.query<{ id: string }>('SELECT id FROM properties WHERE code = $1', [code]);
        const ref = `CB-${b.month.slice(0, 7).replace('-', '')}-${batchId.slice(0, 8)}-${code}`;
        const { rows: [n] } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM integration_outbox WHERE external_ref LIKE $1', [`${ref}%`]);
        await this.checkout.journal(q, v.settings, {
          propertyId: p.id, ref: n.n ? `${ref}-${n.n + 1}` : ref, kind: 'CASHBACK', amount: amount.isNegative() ? amount.negate().toString() : amount.toString(),
          date: new Date().toISOString().slice(0, 10), memo: `Club cashback ${b.month.slice(0, 7)} ${b.kind} ${code}`, reverse: amount.isNegative(),
        });
      }
      const status = failed ? 'exception' : 'posted';
      await q.query(`UPDATE cashback_batches SET status = $2, posted_at = CASE WHEN $2 = 'posted' THEN now() ELSE posted_at END WHERE id = $1`, [batchId, status]);
      await this.audit.record({ action: 'loyalty.cashback_posted', entityType: 'cashback_batch', entityId: batchId, newValues: { status, failed } });
      return this.get(batchId);
    });
  }
}
