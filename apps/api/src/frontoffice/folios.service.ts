import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Money, PaymentTender, REFERENCED_TENDERS, splitInclusiveTax, TaxSplit } from '@hotel/shared';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { requestContext } from '../db/request-context';
import { NumberingService } from '../numbering/numbering.service';
import { ApprovalsService } from './approvals.service';
import { ApprovalInputT, businessDate, conflict, isPgError, withSavepoint } from './common';

export interface LockedFolio {
  id: string;
  number: string;
  propertyId: string;
  status: 'open' | 'closed';
  stayId: string;
  stayNumber: string;
  stayStatus: string;
  reservationId: string;
  roomChargeAllowed: boolean;
  creditLimit: string | null;
}

export interface ChargeInput {
  folio: LockedFolio;
  chargeCode: string;
  description?: string | null;
  quantity: string;
  unitPrice: string;
  discount?: string;
  outletId?: string | null;
  serviceDate: string;
  roomNightDate?: string | null;
  reference?: string | null;
  reason?: string | null;
  approvalId?: string | null;
  /** Set when the charge is a POS check moved to the room (POS-09, BIL-12). */
  posCheckId?: string | null;
}

export interface TenderInput {
  tender: PaymentTender;
  amount: string;
  reference?: string | null;
  status?: 'pending' | 'confirmed';
}

interface ChargeCodeRow {
  code: string;
  name: string;
  manual_posting: boolean;
  prices_include_tax: boolean;
  tax_codes: string[];
}

/**
 * The guest folio (BIL-01), payments (BIL-06) and documents (BIL-09).
 * Every write locks the folio row first, so a charge racing a checkout either
 * lands before settlement or is rejected because the folio closed (§9 freeze).
 */
@Injectable()
export class FoliosService {
  constructor(
    private readonly db: DbService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Locks the folio's stay, then the folio. Lock order everywhere is
   * property (business date) → stay → folio, so posting, payment, checkout and
   * day close serialise on the same rows without deadlocking.
   */
  async lock(q: Queryable, propertyId: string, folioId: string): Promise<LockedFolio> {
    await q.query(
      `SELECT 1 FROM stays WHERE id = (SELECT stay_id FROM folios WHERE property_id = $1 AND id = $2) FOR NO KEY UPDATE`,
      [propertyId, folioId],
    );
    const { rows } = await q.query<LockedFolio>(
      `SELECT f.id, f.number, f.property_id AS "propertyId", f.status, f.stay_id AS "stayId", s.number AS "stayNumber",
              s.status::text AS "stayStatus", f.reservation_id AS "reservationId",
              s.room_charge_allowed AS "roomChargeAllowed", s.credit_limit AS "creditLimit"
         FROM folios f JOIN stays s ON s.id = f.stay_id
        WHERE f.property_id = $1 AND f.id = $2
        FOR NO KEY UPDATE OF f`,
      [propertyId, folioId],
    );
    if (!rows[0]) throw new NotFoundException('Folio not found at this property');
    return rows[0];
  }

  async lockPrimaryForStay(q: Queryable, propertyId: string, stayId: string): Promise<LockedFolio> {
    const { rows } = await q.query<{ id: string }>('SELECT id FROM folios WHERE stay_id = $1 AND is_primary', [stayId]);
    if (!rows[0]) throw new NotFoundException('Stay has no folio');
    return this.lock(q, propertyId, rows[0].id);
  }

  async balance(q: Queryable, folioId: string) {
    const { rows } = await q.query<{
      chargesTotal: string; paymentsConfirmed: string; paymentsPending: string; depositsUnapplied: string; balance: string;
    }>(
      `SELECT charges_total AS "chargesTotal", payments_confirmed AS "paymentsConfirmed", payments_pending AS "paymentsPending",
              deposits_unapplied AS "depositsUnapplied", balance
         FROM folio_balances WHERE folio_id = $1`,
      [folioId],
    );
    return rows[0];
  }

  private async taxSplit(q: Queryable, code: ChargeCodeRow, gross: Money): Promise<TaxSplit> {
    const { rows } = await q.query<{ code: string; ratePercent: string }>(
      `SELECT sap_code AS code, rate_percent::text AS "ratePercent" FROM tax_codes
        WHERE sap_code = ANY($1) AND is_active ORDER BY array_position($1, sap_code)`,
      [code.tax_codes],
    );
    if (rows.length !== code.tax_codes.length) {
      throw new UnprocessableEntityException(`Charge code ${code.code} refers to an inactive or unknown tax code`);
    }
    if (code.prices_include_tax) return splitInclusiveTax(gross.toString(), rows);
    // Exclusive pricing: taxes on top of the net amount.
    const lines = rows.map((r) => ({ code: r.code, ratePercent: Money.of(r.ratePercent).toString(), taxable: gross.toString(), amount: gross.multiply(r.ratePercent).divide(100).toString() }));
    const tax = Money.sum(lines.map((l) => Money.of(l.amount)));
    return { gross: gross.add(tax).toString(), net: gross.toString(), tax: tax.toString(), lines };
  }

  /** Posts one charge with its tax lines. The folio must already be locked by the caller. */
  async postCharge(q: Queryable, c: ChargeInput): Promise<{ id: string; amount: string }> {
    if (c.folio.status !== 'open') throw conflict(`Folio ${c.folio.number} is closed; no further charges`, 'folio_closed');
    const { rows: codes } = await q.query<ChargeCodeRow>(
      'SELECT code, name, manual_posting, prices_include_tax, tax_codes FROM charge_codes WHERE code = $1 AND is_active',
      [c.chargeCode],
    );
    const code = codes[0];
    if (!code) throw new UnprocessableEntityException(`Unknown charge code ${c.chargeCode}`);
    const discount = Money.of(c.discount ?? '0');
    const gross = Money.of(c.unitPrice).multiply(c.quantity).subtract(discount);
    if (gross.isNegative()) throw new BadRequestException('The discount is larger than the charge');
    const split = await this.taxSplit(q, code, gross);
    const actor = requestContext.get()?.user?.id ?? null;
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO folio_charges (property_id, folio_id, stay_id, charge_code, description, outlet_id, service_date, quantity,
                                  unit_price, discount_amount, amount, net_amount, tax_amount, room_night_date, reference,
                                  reason, approval_id, posted_by, pos_check_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
      [
        c.folio.propertyId, c.folio.id, c.folio.stayId, code.code, c.description?.trim() || code.name, c.outletId ?? null,
        c.serviceDate, c.quantity, c.unitPrice, discount.toString(), split.gross, split.net, split.tax, c.roomNightDate ?? null,
        c.reference ?? null, c.reason ?? null, c.approvalId ?? null, actor, c.posCheckId ?? null,
      ],
    );
    for (const line of split.lines) {
      await q.query(
        `INSERT INTO folio_charge_taxes (charge_id, property_id, tax_code, rate_percent, taxable_amount, tax_amount)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rows[0].id, c.folio.propertyId, line.code, line.ratePercent, line.taxable, line.amount],
      );
    }
    return { id: rows[0].id, amount: split.gross };
  }

  /**
   * Manual posting at the desk (BIL-01). Charges from an outlet need an
   * in-house stay that allows room charges, within its credit limit, at the
   * same property (BIL-02, BIL-17); rechecked here under the folio lock.
   */
  async postManualCharge(
    propertyId: string,
    folioId: string,
    input: { chargeCode: string; description?: string; quantity: string; unitPrice: string; discount?: string; outletCode?: string; reference?: string },
  ) {
    return this.db.tx(async (q) => {
      const folio = await this.lock(q, propertyId, folioId);
      const { rows: codes } = await q.query<{ manual_posting: boolean }>('SELECT manual_posting FROM charge_codes WHERE code = $1', [input.chargeCode]);
      if (codes[0] && !codes[0].manual_posting) {
        throw new UnprocessableEntityException(`${input.chargeCode} is posted by the system, not by hand`);
      }
      if (folio.stayStatus !== 'checked_in') {
        throw conflict(`Stay ${folio.stayNumber} is ${folio.stayStatus}; charges post only to in-house stays`, 'stay_not_in_house');
      }
      let outletId: string | null = null;
      if (input.outletCode) {
        const { rows } = await q.query<{ id: string }>('SELECT id FROM outlets WHERE property_id = $1 AND code = $2 AND is_active', [
          propertyId,
          input.outletCode.toUpperCase(),
        ]);
        if (!rows[0]) throw new UnprocessableEntityException(`Outlet ${input.outletCode} is not an active outlet of this property (BIL-17)`);
        outletId = rows[0].id;
        if (!folio.roomChargeAllowed) {
          throw conflict(`Room charges are not allowed for stay ${folio.stayNumber}`, 'room_charge_blocked');
        }
      }
      const bd = await businessDate(q, propertyId);
      const amount = Money.of(input.unitPrice).multiply(input.quantity).subtract(input.discount ?? '0');
      if (outletId && folio.creditLimit !== null) {
        const bal = await this.balance(q, folio.id);
        if (Money.of(bal.balance).add(amount).compare(folio.creditLimit) > 0) {
          throw conflict(`This charge would take the balance over the credit limit of ${Money.of(folio.creditLimit).format()}`, 'credit_limit');
        }
      }
      const charge = await this.postCharge(q, {
        folio, chargeCode: input.chargeCode, description: input.description, quantity: input.quantity, unitPrice: input.unitPrice,
        discount: input.discount, outletId, serviceDate: bd, reference: input.reference,
      });
      await this.audit.record({ action: 'folio.charge', entityType: 'folio', entityId: folio.id, propertyId, newValues: { chargeId: charge.id, ...input } });
      return this.charge(q, charge.id);
    });
  }

  /** Linked reversal (BIL-07): the original stays; a negated copy with approver and reason is added. */
  async reverseCharge(propertyId: string, folioId: string, chargeId: string, reason: string, approval: ApprovalInputT) {
    return this.db.tx(async (q) => {
      const folio = await this.lock(q, propertyId, folioId);
      if (folio.status !== 'open') throw conflict(`Folio ${folio.number} is closed; use a credit note`, 'folio_closed');
      const { rows } = await q.query<{ id: string; amount: string; reversal_of: string | null }>(
        `SELECT id, amount, reversal_of FROM folio_charges WHERE id = $1 AND folio_id = $2`,
        [chargeId, folio.id],
      );
      const orig = rows[0];
      if (!orig) throw new NotFoundException('Charge not found on this folio');
      if (orig.reversal_of) throw conflict('A reversal cannot itself be reversed', 'invalid_reversal');
      const approvalId = await this.approvals.approve({
        permission: 'approve.charge_reversal', propertyId, action: 'folio.charge_reversal', entityType: 'folio_charge',
        entityId: chargeId, reason, approval, details: { amount: orig.amount, folio: folio.number },
      });
      const bd = await businessDate(q, propertyId);
      let inserted: { id: string };
      try {
        ({ rows: [inserted] } = await withSavepoint(q, 'reverse', () =>
          q.query<{ id: string }>(
            `INSERT INTO folio_charges (property_id, folio_id, stay_id, charge_code, description, outlet_id, service_date, quantity,
                                        unit_price, discount_amount, amount, net_amount, tax_amount, reference, reversal_of,
                                        reason, approval_id, posted_by, pos_check_id)
             SELECT property_id, folio_id, stay_id, charge_code, 'Reversal: ' || description, outlet_id, $2, -quantity,
                    unit_price, -discount_amount, -amount, -net_amount, -tax_amount, reference, id, $3, $4, $5, pos_check_id
               FROM folio_charges WHERE id = $1
             RETURNING id`,
            [orig.id, bd, reason, approvalId, requestContext.get()?.user?.id ?? null],
          ),
        ));
      } catch (err) {
        if (isPgError(err, '23505')) throw conflict('This charge has already been reversed', 'already_reversed');
        throw err;
      }
      await q.query(
        `INSERT INTO folio_charge_taxes (charge_id, property_id, tax_code, rate_percent, taxable_amount, tax_amount)
         SELECT $1, property_id, tax_code, rate_percent, -taxable_amount, -tax_amount FROM folio_charge_taxes WHERE charge_id = $2`,
        [inserted.id, orig.id],
      );
      await this.audit.record({ action: 'folio.charge_reversed', entityType: 'folio_charge', entityId: orig.id, propertyId, reason, newValues: { reversalId: inserted.id, approvalId } });
      return this.charge(q, inserted.id);
    });
  }

  async charge(q: Queryable, id: string) {
    const { rows } = await q.query(
      `SELECT c.id, c.charge_code AS "chargeCode", c.description, o.code AS "outletCode", o.name AS "outletName",
              c.service_date AS "serviceDate", c.quantity::text AS quantity, c.unit_price::numeric(18,2)::text AS "unitPrice",
              c.discount_amount AS "discountAmount", c.amount, c.net_amount AS "netAmount", c.tax_amount AS "taxAmount",
              c.room_night_date AS "roomNightDate", c.reference, c.reversal_of AS "reversalOf", c.reason, c.pos_check_id AS "posCheckId",
              u.display_name AS "postedBy", c.posted_at AS "postedAt",
              coalesce((SELECT json_agg(json_build_object('taxCode', t.tax_code, 'ratePercent', t.rate_percent::text,
                                                          'taxableAmount', t.taxable_amount::text, 'taxAmount', t.tax_amount::text)
                                        ORDER BY t.rate_percent DESC)
                          FROM folio_charge_taxes t WHERE t.charge_id = c.id), '[]') AS taxes,
              EXISTS (SELECT 1 FROM folio_charges r WHERE r.reversal_of = c.id) AS "isReversed"
         FROM folio_charges c
         LEFT JOIN outlets o ON o.id = c.outlet_id
         LEFT JOIN users u ON u.id = c.posted_by
        WHERE c.id = $1`,
      [id],
    );
    return rows[0];
  }

  // -------------------------------------------------------------------------
  // Payments (BIL-06)
  // -------------------------------------------------------------------------

  /**
   * Records one or more tenders (split tender) in one transaction. Cash is
   * always confirmed; other tenders may be recorded as pending until verified.
   * Before check-in a payment is a deposit (RES-07). Provider references are
   * unique, so a resent M-PESA confirmation cannot be recorded twice (AT-03).
   */
  async takePayments(propertyId: string, folioId: string, tenders: TenderInput[]) {
    return this.db.tx(async (q) => {
      const folio = await this.lock(q, propertyId, folioId);
      const ids = await this.recordTenders(q, folio, tenders);
      await this.audit.record({ action: 'folio.payment', entityType: 'folio', entityId: folio.id, propertyId, newValues: { tenders } });
      return { folioId: folio.id, payments: await Promise.all(ids.map((id) => this.payment(q, id))), balance: await this.balance(q, folio.id) };
    });
  }

  async recordTenders(q: Queryable, folio: LockedFolio, tenders: TenderInput[], extra: { companyId?: string; approvalId?: string } = {}): Promise<string[]> {
    if (folio.status !== 'open') throw conflict(`Folio ${folio.number} is closed`, 'folio_closed');
    if (['cancelled', 'no_show', 'checked_out'].includes(folio.stayStatus)) {
      throw conflict(`Stay ${folio.stayNumber} is ${folio.stayStatus}; refunds and adjustments need BIL-07`, 'stay_closed');
    }
    const bd = await businessDate(q, folio.propertyId);
    const isDeposit = folio.stayStatus !== 'checked_in';
    const actor = requestContext.get()?.user?.id ?? null;
    const ids: string[] = [];
    for (const [i, t] of tenders.entries()) {
      if (t.tender === 'city_ledger' && !extra.approvalId) {
        throw new BadRequestException('Credit transfers to a company account are made at checkout with approval');
      }
      if (REFERENCED_TENDERS.includes(t.tender) && !t.reference) throw new BadRequestException(`${t.tender} needs a reference`);
      const status = t.tender === 'cash' || t.tender === 'city_ledger' ? 'confirmed' : (t.status ?? 'confirmed');
      try {
        const { rows } = await withSavepoint(q, `tender${i}`, () =>
          q.query<{ id: string }>(
            `INSERT INTO folio_payments (property_id, folio_id, tender, amount, reference, status, is_deposit, company_id, approval_id,
                                         business_date, received_by, confirmed_by, confirmed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $6 = 'confirmed' THEN $11::uuid END,
                     CASE WHEN $6 = 'confirmed' THEN now() END)
             RETURNING id`,
            [folio.propertyId, folio.id, t.tender, Money.of(t.amount).toString(), t.reference?.trim() || null, status, isDeposit,
             extra.companyId ?? null, extra.approvalId ?? null, bd, actor],
          ),
        );
        ids.push(rows[0].id);
        if (status === 'confirmed' && t.tender !== 'city_ledger') await this.issueReceipt(q, rows[0].id);
      } catch (err) {
        if (isPgError(err, '23505')) throw conflict(`${t.tender} reference ${t.reference} is already recorded`, 'duplicate_payment');
        throw err;
      }
    }
    return ids;
  }

  async confirmPayment(propertyId: string, paymentId: string) {
    return this.db.tx(async (q) => {
      const p = await this.lockPayment(q, propertyId, paymentId);
      if (p.status !== 'pending') throw conflict(`Payment is already ${p.status}`, 'payment_final');
      await q.query(`UPDATE folio_payments SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2 WHERE id = $1`, [
        paymentId,
        requestContext.get()?.user?.id ?? null,
      ]);
      await this.issueReceipt(q, paymentId);
      await this.audit.record({ action: 'payment.confirm', entityType: 'payment', entityId: paymentId, propertyId });
      return this.payment(q, paymentId);
    });
  }

  async failPayment(propertyId: string, paymentId: string, reason: string) {
    return this.db.tx(async (q) => {
      const p = await this.lockPayment(q, propertyId, paymentId);
      if (p.status !== 'pending') throw conflict(`Payment is already ${p.status}`, 'payment_final');
      await q.query(`UPDATE folio_payments SET status = 'failed', failed_reason = $2 WHERE id = $1`, [paymentId, reason]);
      await this.audit.record({ action: 'payment.fail', entityType: 'payment', entityId: paymentId, propertyId, reason });
      return this.payment(q, paymentId);
    });
  }

  private async lockPayment(q: Queryable, propertyId: string, paymentId: string) {
    const { rows } = await q.query<{ status: string; folio_id: string }>(
      'SELECT status, folio_id FROM folio_payments WHERE property_id = $1 AND id = $2',
      [propertyId, paymentId],
    );
    if (!rows[0]) throw new NotFoundException('Payment not found at this property');
    await this.lock(q, propertyId, rows[0].folio_id); // same lock order as postings and checkout
    const { rows: again } = await q.query<{ status: string }>('SELECT status FROM folio_payments WHERE id = $1', [paymentId]);
    return again[0];
  }

  async payment(q: Queryable, id: string) {
    const { rows } = await q.query(
      `SELECT p.id, p.tender, p.amount, p.reference, p.status, p.is_deposit AS "isDeposit", p.deposit_applied_at AS "depositAppliedAt",
              p.receipt_number AS "receiptNumber", p.business_date AS "businessDate", p.received_at AS "receivedAt",
              p.confirmed_at AS "confirmedAt", p.failed_reason AS "failedReason", u.display_name AS "receivedBy",
              c.name AS "companyName", d.id AS "receiptDocumentId"
         FROM folio_payments p
         LEFT JOIN users u ON u.id = p.received_by
         LEFT JOIN companies c ON c.id = p.company_id
         LEFT JOIN documents d ON d.payment_id = p.id AND d.document_type = 'RECEIPT'
        WHERE p.id = $1`,
      [id],
    );
    return rows[0];
  }

  // -------------------------------------------------------------------------
  // Documents (BIL-09)
  // -------------------------------------------------------------------------

  async header(q: Queryable, propertyId: string) {
    const { rows } = await q.query<Record<string, unknown>>(
      `SELECT p.code, p.name, p.location, p.address, p.contact_phone AS phone, p.contact_email AS email, p.currency,
              le.name AS "legalName", le.kra_pin AS "kraPin"
         FROM properties p CROSS JOIN legal_entity le WHERE p.id = $1`,
      [propertyId],
    );
    return rows[0];
  }

  headerFor(propertyId: string) {
    return this.db.tx((q) => this.header(q, propertyId));
  }

  async issueDocument(
    q: Queryable,
    d: { propertyId: string; type: 'PROFORMA' | 'INVOICE' | 'RECEIPT'; reservationId?: string; stayId?: string; folioId?: string; paymentId?: string; total: string; content: Record<string, unknown> },
  ): Promise<{ id: string; number: string }> {
    const number = await this.numbering.next(d.propertyId, d.type);
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO documents (property_id, document_type, number, reservation_id, stay_id, folio_id, payment_id, total, content, issued_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [d.propertyId, d.type, number, d.reservationId ?? null, d.stayId ?? null, d.folioId ?? null, d.paymentId ?? null, d.total,
       JSON.stringify({ ...d.content, number, issuedAt: new Date().toISOString(), issuedBy: requestContext.get()?.user?.displayName ?? null }),
       requestContext.get()?.user?.id ?? null],
    );
    return { id: rows[0].id, number };
  }

  private async issueReceipt(q: Queryable, paymentId: string): Promise<void> {
    const { rows } = await q.query<{
      property_id: string; folio_id: string; folio_number: string; stay_id: string; stay_number: string; reservation_number: string;
      guest: string; tender: string; amount: string; reference: string | null; is_deposit: boolean; business_date: string;
    }>(
      `SELECT p.property_id, p.folio_id, f.number AS folio_number, s.id AS stay_id, s.number AS stay_number, r.number AS reservation_number,
              g.first_name || ' ' || g.last_name AS guest, p.tender, p.amount, p.reference, p.is_deposit, p.business_date
         FROM folio_payments p JOIN folios f ON f.id = p.folio_id JOIN stays s ON s.id = f.stay_id
         JOIN reservations r ON r.id = s.reservation_id JOIN guests g ON g.id = s.primary_guest_id
        WHERE p.id = $1`,
      [paymentId],
    );
    const p = rows[0];
    const doc = await this.issueDocument(q, {
      propertyId: p.property_id, type: 'RECEIPT', folioId: p.folio_id, stayId: p.stay_id, paymentId, total: p.amount,
      content: {
        property: await this.header(q, p.property_id), folioNumber: p.folio_number, stayNumber: p.stay_number,
        reservationNumber: p.reservation_number, guest: p.guest, tender: p.tender, reference: p.reference, amount: p.amount,
        isDeposit: p.is_deposit, businessDate: p.business_date,
      },
    });
    await q.query('UPDATE folio_payments SET receipt_number = $2 WHERE id = $1', [paymentId, doc.number]);
  }

  async folioLines(q: Queryable, folioId: string) {
    const { rows: ids } = await q.query<{ id: string }>('SELECT id FROM folio_charges WHERE folio_id = $1 ORDER BY service_date, posted_at', [folioId]);
    const charges = await Promise.all(ids.map((r) => this.charge(q, r.id)));
    const { rows: pids } = await q.query<{ id: string }>('SELECT id FROM folio_payments WHERE folio_id = $1 ORDER BY received_at', [folioId]);
    const payments = await Promise.all(pids.map((r) => this.payment(q, r.id)));
    const { rows: taxSummary } = await q.query(
      `SELECT t.tax_code AS "taxCode", tc.name, t.rate_percent::text AS "ratePercent",
              sum(t.taxable_amount)::numeric(18,2)::text AS "taxableAmount", sum(t.tax_amount)::numeric(18,2)::text AS "taxAmount"
         FROM folio_charge_taxes t JOIN folio_charges c ON c.id = t.charge_id JOIN tax_codes tc ON tc.sap_code = t.tax_code
        WHERE c.folio_id = $1 GROUP BY t.tax_code, tc.name, t.rate_percent ORDER BY t.rate_percent DESC`,
      [folioId],
    );
    return { charges, payments, taxSummary };
  }

  /** Folio with charges, taxes, payments, balance and documents (BIL-01, FD-08 preview). */
  async get(propertyId: string, folioId: string) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query(
        `SELECT f.id, f.number, f.status, f.closed_at AS "closedAt", f.stay_id AS "stayId", s.number AS "stayNumber",
                s.status AS "stayStatus", f.reservation_id AS "reservationId", res.number AS "reservationNumber",
                g.id AS "guestId", g.first_name || ' ' || g.last_name AS "guestName", rm.number AS "roomNumber",
                s.arrival_date AS "arrivalDate", s.departure_date AS "departureDate",
                s.room_charge_allowed AS "roomChargeAllowed", s.credit_limit AS "creditLimit"
           FROM folios f JOIN stays s ON s.id = f.stay_id JOIN reservations res ON res.id = f.reservation_id
           JOIN guests g ON g.id = s.primary_guest_id LEFT JOIN rooms rm ON rm.id = s.room_id
          WHERE f.property_id = $1 AND f.id = $2`,
        [propertyId, folioId],
      );
      if (!rows[0]) throw new NotFoundException('Folio not found at this property');
      const { rows: documents } = await q.query(
        `SELECT id, document_type AS "documentType", number, total, issued_at AS "issuedAt" FROM documents
          WHERE folio_id = $1 OR (document_type = 'PROFORMA' AND reservation_id = $2) ORDER BY issued_at`,
        [folioId, (rows[0] as { reservationId: string }).reservationId],
      );
      return { ...rows[0], ...(await this.folioLines(q, folioId)), balance: await this.balance(q, folioId), documents };
    });
  }

  async document(propertyId: string, id: string) {
    const { rows } = await this.db.query<{ id: string; documentType: string; number: string; total: string; content: Record<string, unknown>; issuedAt: string }>(
      `SELECT id, document_type AS "documentType", number, total, content, issued_at AS "issuedAt"
         FROM documents WHERE property_id = $1 AND id = $2`,
      [propertyId, id],
    );
    if (!rows[0]) throw new NotFoundException('Document not found at this property');
    return rows[0];
  }
}
