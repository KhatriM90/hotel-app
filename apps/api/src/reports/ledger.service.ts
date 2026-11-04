import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

/**
 * Money reports for the front office and accounts (RPT-04): the guest ledger
 * (what open folios owe), deposits held, money received by day and method,
 * and POS discounts and complimentaries line by line. All amounts come out
 * of PostgreSQL as decimal strings (§9). Row-level security keeps every query
 * to the caller's property.
 */

export type LedgerRow = {
  folio: string;
  stay: string;
  booking: string;
  guest: string;
  room: string | null;
  arrival: string;
  departure: string;
  stayStatus: string;
  charges: string;
  payments: string;
  pending: string;
  depositsUnapplied: string;
  balance: string;
};

export type DepositRow = {
  receipt: string | null;
  receivedOn: string;
  booking: string;
  stay: string;
  guest: string;
  arrival: string;
  stayStatus: string;
  tender: string;
  reference: string | null;
  amount: string;
};

export type MoneyRow = {
  date: string;
  tender: string;
  frontDesk: string;
  pos: string;
  refunds: string;
  total: string;
};

export type DiscountRow = {
  date: string;
  check: string;
  outlet: string;
  waiter: string;
  item: string;
  quantity: string;
  listValue: string;
  priceRule: string;
  discount: string;
  comp: string;
  reason: string | null;
  charged: string;
};

@Injectable()
export class LedgerReportsService {
  constructor(private readonly db: DbService) {}

  /** Open folios and closed folios that still owe or are owed money, as of now. */
  guestLedger(propertyId: string): Promise<LedgerRow[]> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<LedgerRow>(
        `SELECT f.number AS folio, s.number AS stay, r.number AS booking,
                g.first_name || ' ' || g.last_name AS guest, rm.number AS room,
                s.arrival_date::text AS arrival, s.departure_date::text AS departure, s.status::text AS "stayStatus",
                b.charges_total::text AS charges, b.payments_confirmed::text AS payments,
                b.payments_pending::text AS pending, b.deposits_unapplied::text AS "depositsUnapplied",
                b.balance::text AS balance
           FROM folios f
           JOIN folio_balances b ON b.folio_id = f.id
           JOIN stays s ON s.id = f.stay_id
           JOIN reservations r ON r.id = f.reservation_id
           JOIN guests g ON g.id = s.primary_guest_id
           LEFT JOIN rooms rm ON rm.id = s.room_id
          WHERE f.property_id = $1 AND (f.status = 'open' OR b.balance <> 0)
            AND (b.charges_total <> 0 OR b.payments_confirmed <> 0 OR b.payments_pending <> 0)
          ORDER BY b.balance DESC, f.number`,
        [propertyId],
      );
      return rows;
    });
  }

  /** Confirmed deposits not yet applied to a stay's bill, as of now. */
  depositsHeld(propertyId: string): Promise<DepositRow[]> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<DepositRow>(
        `SELECT p.receipt_number AS receipt, p.business_date::text AS "receivedOn", r.number AS booking, s.number AS stay,
                g.first_name || ' ' || g.last_name AS guest, s.arrival_date::text AS arrival, s.status::text AS "stayStatus",
                p.tender::text AS tender, p.reference, p.amount::text AS amount
           FROM folio_payments p
           JOIN folios f ON f.id = p.folio_id
           JOIN stays s ON s.id = f.stay_id
           JOIN reservations r ON r.id = f.reservation_id
           JOIN guests g ON g.id = s.primary_guest_id
          WHERE p.property_id = $1 AND p.status = 'confirmed' AND p.is_deposit AND p.deposit_applied_at IS NULL
          ORDER BY s.arrival_date, p.business_date, p.receipt_number`,
        [propertyId],
      );
      return rows;
    });
  }

  /**
   * Money received per business date and method: confirmed folio payments and
   * confirmed POS payments, less POS refunds. A charge to a room is not money
   * received; it is collected later on the folio.
   */
  moneyReceived(propertyId: string, from: string, to: string): Promise<MoneyRow[]> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<MoneyRow>(
        `WITH m AS (
           SELECT business_date, tender::text AS tender, amount AS desk, 0::numeric AS pos, 0::numeric AS refund
             FROM folio_payments WHERE property_id = $1 AND status = 'confirmed' AND business_date BETWEEN $2 AND $3
           UNION ALL
           SELECT business_date, tender::text, 0, amount, 0
             FROM pos_payments WHERE property_id = $1 AND status = 'confirmed' AND business_date BETWEEN $2 AND $3
           UNION ALL
           SELECT business_date, tender::text, 0, 0, amount
             FROM pos_refunds WHERE property_id = $1 AND business_date BETWEEN $2 AND $3)
         SELECT business_date::text AS date, tender,
                sum(desk)::numeric(18,2)::text AS "frontDesk", sum(pos)::numeric(18,2)::text AS pos,
                (-sum(refund))::numeric(18,2)::text AS refunds,
                (sum(desk) + sum(pos) - sum(refund))::numeric(18,2)::text AS total
           FROM m GROUP BY business_date, tender ORDER BY business_date, tender`,
        [propertyId, from, to],
      );
      return rows;
    });
  }

  /** Every discounted or complimentary line on closed checks, by trading date. */
  discounts(propertyId: string, from: string, to: string, outletCode?: string): Promise<DiscountRow[]> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<DiscountRow>(
        `SELECT c.business_date::text AS date, c.number AS "check", o.name AS outlet, u.display_name AS waiter,
                l.name AS item, l.quantity::text AS quantity,
                round((l.unit_price + l.modifiers_unit_price) * l.quantity, 2)::text AS "listValue",
                l.rule_discount::text AS "priceRule", l.discount_amount::text AS discount,
                CASE WHEN l.is_comp THEN 'Yes' ELSE '' END AS comp, l.discount_reason AS reason, l.amount::text AS charged
           FROM pos_checks c
           JOIN outlets o ON o.id = c.outlet_id
           JOIN users u ON u.id = c.waiter_id
           JOIN pos_check_lines l ON l.check_id = c.id AND l.status NOT IN ('cancelled', 'wasted')
          WHERE c.property_id = $1 AND c.business_date BETWEEN $2 AND $3 AND c.status = 'closed'
            AND ($4::text IS NULL OR o.code = $4)
            AND (l.discount_amount > 0 OR l.rule_discount > 0 OR l.is_comp)
          ORDER BY c.business_date, c.number, l.name`,
        [propertyId, from, to, outletCode ?? null],
      );
      return rows;
    });
  }
}
