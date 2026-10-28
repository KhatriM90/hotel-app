import { Injectable } from '@nestjs/common';
import { Money } from '@hotel/shared';
import { DbService, Queryable } from '../db/db.service';
import { outletByCode } from './common';

interface Filter {
  /** SQL predicate on pos_checks aliased `c`, using $1.. */
  where: string;
  params: unknown[];
  /** Predicate on pos_refunds `r` joined to its check `c`. */
  refundWhere: string;
}

/**
 * POS totals (RPT-03 basics, POS day close). Revenue is the lines of closed
 * checks, counted once (§9); house-account consumption is reported apart and
 * is never revenue (POS-18); a room charge is a settlement that moves the
 * amount to the guest ledger (BIL-12), not a second sale.
 */
@Injectable()
export class PosReportsService {
  constructor(private readonly db: DbService) {}

  dayTotals(q: Queryable, dayId: string) {
    return this.totals(q, {
      where: 'c.outlet_day_id = $1',
      params: [dayId],
      refundWhere: `r.business_date = (SELECT business_date FROM pos_outlet_days WHERE id = $1)
                    AND c.outlet_id = (SELECT outlet_id FROM pos_outlet_days WHERE id = $1)`,
    });
  }

  async sales(propertyId: string, input: { from: string; to: string; outletCode?: string }) {
    return this.db.tx(async (q) => {
      const outletId = input.outletCode ? (await outletByCode(q, propertyId, input.outletCode, false)).id : null;
      const totals = await this.totals(q, {
        where: 'c.property_id = $1 AND c.business_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR c.outlet_id = $4)',
        params: [propertyId, input.from, input.to, outletId],
        refundWhere: 'r.property_id = $1 AND r.business_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR c.outlet_id = $4)',
      });
      const { rows: byOutlet } = await q.query(
        `SELECT o.code, o.name, count(DISTINCT c.id)::int AS checks, coalesce(sum(l.amount), 0)::numeric(18,2)::text AS "netSales"
           FROM pos_checks c JOIN outlets o ON o.id = c.outlet_id
           JOIN pos_check_lines l ON l.check_id = c.id AND l.status NOT IN ('cancelled', 'wasted')
          WHERE c.property_id = $1 AND c.business_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR c.outlet_id = $4)
            AND c.status = 'closed' AND c.settlement <> 'house_account'
          GROUP BY o.code, o.name ORDER BY o.code`,
        [propertyId, input.from, input.to, outletId],
      );
      return { from: input.from, to: input.to, outletCode: input.outletCode ?? null, ...totals, byOutlet };
    });
  }

  private async totals(q: Queryable, f: Filter) {
    const p = f.params;
    // Live lines of closed revenue checks (paid, charged to a room, or fully comped).
    const revenue = `FROM pos_checks c JOIN pos_check_lines l ON l.check_id = c.id AND l.status NOT IN ('cancelled', 'wasted')
                     WHERE ${f.where} AND c.status = 'closed' AND c.settlement <> 'house_account'`;

    const { rows: [checks] } = await q.query<Record<string, number>>(
      `SELECT count(*) FILTER (WHERE status = 'closed')::int AS closed, count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status = 'void')::int AS void, count(*) FILTER (WHERE status = 'merged')::int AS merged,
              coalesce(sum(covers) FILTER (WHERE status = 'closed'), 0)::int AS covers
         FROM pos_checks c WHERE ${f.where}`,
      p,
    );
    const { rows: [sales] } = await q.query<Record<string, string>>(
      `SELECT coalesce(sum(round((l.unit_price + l.modifiers_unit_price) * l.quantity, 2)), 0)::numeric(18,2)::text AS gross,
              coalesce(sum(l.rule_discount), 0)::numeric(18,2)::text AS "ruleDiscounts",
              coalesce(sum(l.discount_amount) FILTER (WHERE NOT l.is_comp), 0)::numeric(18,2)::text AS discounts,
              coalesce(sum(l.discount_amount) FILTER (WHERE l.is_comp), 0)::numeric(18,2)::text AS comps,
              coalesce(sum(l.amount), 0)::numeric(18,2)::text AS net,
              coalesce(sum(l.net_amount), 0)::numeric(18,2)::text AS "exTax",
              coalesce(sum(l.tax_amount), 0)::numeric(18,2)::text AS tax
         ${revenue}`,
      p,
    );
    const { rows: taxes } = await q.query(
      `SELECT t->>'code' AS "taxCode", tc.name, (t->>'ratePercent') AS "ratePercent",
              sum((t->>'taxable')::numeric)::numeric(18,2)::text AS "taxableAmount", sum((t->>'amount')::numeric)::numeric(18,2)::text AS "taxAmount"
         ${revenue.replace('WHERE', 'CROSS JOIN LATERAL jsonb_array_elements(l.taxes) t LEFT JOIN tax_codes tc ON tc.sap_code = t->>\'code\' WHERE')}
        GROUP BY 1, 2, 3 ORDER BY 1`,
      p,
    );
    const { rows: payments } = await q.query<{ tender: string; amount: string; count: number }>(
      `SELECT pp.tender::text AS tender, sum(pp.amount)::numeric(18,2)::text AS amount, count(*)::int AS count
         FROM pos_checks c JOIN pos_payments pp ON pp.check_id = c.id AND pp.status = 'confirmed'
        WHERE ${f.where} AND c.status = 'closed' GROUP BY pp.tender ORDER BY pp.tender`,
      p,
    );
    const { rows: [room] } = await q.query<{ amount: string; count: number }>(
      `SELECT coalesce(sum(rc.amount), 0)::numeric(18,2)::text AS amount, count(rc.id)::int AS count
         FROM pos_checks c JOIN pos_room_charges rc ON rc.check_id = c.id WHERE ${f.where}`,
      p,
    );
    const { rows: house } = await q.query<{ code: string; name: string; kind: string; costCentre: string | null; amount: string; checks: number }>(
      `SELECT ha.code, ha.name, ha.kind, ha.cost_centre AS "costCentre", sum(h.amount)::numeric(18,2)::text AS amount, count(*)::int AS checks
         FROM pos_checks c JOIN house_account_charges h ON h.check_id = c.id JOIN house_accounts ha ON ha.id = h.house_account_id
        WHERE ${f.where} GROUP BY ha.code, ha.name, ha.kind, ha.cost_centre ORDER BY ha.code`,
      p,
    );
    const { rows: refunds } = await q.query<{ tender: string; amount: string; count: number }>(
      `SELECT r.tender::text AS tender, sum(r.amount)::numeric(18,2)::text AS amount, count(*)::int AS count
         FROM pos_refunds r JOIN pos_checks c ON c.id = r.check_id WHERE ${f.refundWhere} GROUP BY r.tender ORDER BY r.tender`,
      p,
    );
    const { rows: corrections } = await q.query<{ status: string; lines: number; amount: string }>(
      `SELECT l.status, count(*)::int AS lines, coalesce(sum(round((l.unit_price + l.modifiers_unit_price) * l.quantity, 2)), 0)::numeric(18,2)::text AS amount
         FROM pos_checks c JOIN pos_check_lines l ON l.check_id = c.id
        WHERE ${f.where} AND l.status IN ('cancelled', 'wasted') GROUP BY l.status`,
      p,
    );
    const { rows: byCategory } = await q.query(
      `SELECT mc.code, mc.name, sum(l.quantity)::text AS quantity, sum(l.amount)::numeric(18,2)::text AS amount
         ${revenue.replace('WHERE', 'JOIN menu_items mi ON mi.id = l.item_id JOIN menu_categories mc ON mc.id = mi.category_id WHERE')}
        GROUP BY mc.code, mc.name, mc.sort_order ORDER BY mc.sort_order, mc.code`,
      p,
    );
    const { rows: topItems } = await q.query(
      `SELECT l.name, sum(l.quantity)::text AS quantity, sum(l.amount)::numeric(18,2)::text AS amount
         ${revenue} GROUP BY l.name ORDER BY sum(l.amount) DESC, l.name LIMIT 10`,
      p,
    );
    const { rows: byWaiter } = await q.query(
      `SELECT u.display_name AS waiter, count(DISTINCT c.id)::int AS checks, sum(l.amount)::numeric(18,2)::text AS amount
         ${revenue.replace('WHERE', 'JOIN users u ON u.id = c.waiter_id WHERE')}
        GROUP BY u.display_name ORDER BY u.display_name`,
      p,
    );

    const paid = Money.sum(payments.map((x) => Money.of(x.amount)));
    const settled = paid.add(room.amount);
    const refunded = Money.sum(refunds.map((x) => Money.of(x.amount)));
    const cancelled = corrections.find((c) => c.status === 'cancelled');
    const wasted = corrections.find((c) => c.status === 'wasted');
    return {
      checks,
      grossSales: sales.gross,
      ruleDiscounts: sales.ruleDiscounts,
      discounts: sales.discounts,
      comps: sales.comps,
      netSales: sales.net,
      netExTax: sales.exTax,
      tax: sales.tax,
      taxes,
      settlements: { payments, roomCharges: room, total: settled.toString() },
      houseAccounts: { total: Money.sum(house.map((h) => Money.of(h.amount))).toString(), accounts: house },
      refunds: { total: refunded.toString(), byTender: refunds },
      netAfterRefunds: Money.of(sales.net).subtract(refunded).toString(),
      corrections: {
        cancelled: { lines: cancelled?.lines ?? 0, listValue: cancelled?.amount ?? '0.00' },
        wasted: { lines: wasted?.lines ?? 0, listValue: wasted?.amount ?? '0.00' },
      },
      byCategory,
      topItems,
      byWaiter,
      // Sales must equal what settled them: payments plus room charges (AT-16).
      reconciliation: { netSales: sales.net, settled: settled.toString(), difference: Money.of(sales.net).subtract(settled).toString() },
    };
  }
}
