import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Money, PosTender, spreadOverLines } from '@hotel/shared';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { ApprovalsService } from '../frontoffice/approvals.service';
import { ApprovalInputT, businessDate, conflict, isPgError, withSavepoint } from '../frontoffice/common';
import { FoliosService } from '../frontoffice/folios.service';
import { OutboxService } from '../integration/outbox.service';
import { NumberingService } from '../numbering/numbering.service';
import { PosChecksService, LockedCheck } from './checks.service';
import { actorId, event, outletById } from './common';
import { PosDaysService } from './days.service';

export interface PosTenderInput {
  tender: PosTender;
  amount: string;
  tendered?: string | null;
  reference?: string | null;
  status?: 'pending' | 'confirmed';
}

export interface RoomChargeInput {
  stayId: string;
  acknowledgement: { method: 'guest_signature' | 'staff_verified'; signedName: string; signature?: string | null };
}

interface Totals {
  total: string;
  paid: string;
  pending: string;
  roomCharged: string;
  houseCharged: string;
  balance: string;
}

/**
 * Settling checks (POS-08 split settlement, POS-09 room charge, POS-10
 * immediate payment, POS-11 refunds, POS-18 house accounts). A check closes
 * the moment it is fully settled by confirmed tenders, the room charge of the
 * unpaid remainder, or a house account, never twice (§9, AT-02).
 */
@Injectable()
export class PosSettlementService {
  constructor(
    private readonly db: DbService,
    private readonly checks: PosChecksService,
    private readonly days: PosDaysService,
    private readonly folios: FoliosService,
    private readonly approvals: ApprovalsService,
    private readonly numbering: NumberingService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async totals(q: Queryable, checkId: string): Promise<Totals> {
    const { rows } = await q.query<Totals>(
      `SELECT total, paid, pending, room_charged AS "roomCharged", house_charged AS "houseCharged", balance FROM pos_check_totals WHERE check_id = $1`,
      [checkId],
    );
    return rows[0];
  }

  private async openShift(q: Queryable, propertyId: string): Promise<string | null> {
    const { rows } = await q.query<{ id: string }>(
      `SELECT id FROM cashier_shifts WHERE property_id = $1 AND user_id = $2 AND status = 'open' FOR SHARE`,
      [propertyId, actorId()],
    );
    return rows[0]?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Payments (POS-10)
  // -------------------------------------------------------------------------

  async pay(propertyId: string, checkId: string, tenders: PosTenderInput[]) {
    return this.db.tx(async (q) => {
      const check = await this.checks.lock(q, propertyId, checkId);
      await this.checks.sendDrafts(q, check); // paying finalises the order
      const t = await this.totals(q, check.id);
      let remaining = Money.of(t.balance).subtract(t.pending);
      if (remaining.compare(0) <= 0) {
        throw conflict(Money.of(t.pending).isZero() ? `Nothing is due on ${check.number}` : `The rest of ${check.number} is awaiting a pending payment`, 'nothing_due');
      }
      const shiftId = tenders.some((x) => x.tender === 'cash') ? await this.openShift(q, propertyId) : null;
      if (tenders.some((x) => x.tender === 'cash') && !shiftId) {
        throw conflict('Open your cashier shift before taking cash (POS-13)', 'no_open_shift');
      }
      let change = Money.zero();
      for (const [i, x] of tenders.entries()) {
        const amount = Money.of(x.amount);
        if (amount.compare(remaining) > 0) {
          throw conflict(`${x.tender} ${amount.format()} is more than the ${remaining.format()} still due; enter the cash given as "tendered" for change`, 'overpayment');
        }
        if (x.tendered && x.tender !== 'cash') throw new BadRequestException('Only cash is tendered with change');
        if (x.tendered && Money.of(x.tendered).compare(amount) < 0) throw new BadRequestException('Cash tendered is less than the amount');
        if (['mpesa', 'card', 'bank_transfer'].includes(x.tender) && !x.reference) throw new BadRequestException(`${x.tender} needs a reference`);
        const status = x.tender === 'cash' ? 'confirmed' : (x.status ?? 'confirmed');
        try {
          await withSavepoint(q, `pos_tender${i}`, () =>
            q.query(
              `INSERT INTO pos_payments (property_id, check_id, shift_id, tender, amount, tendered, reference, status, business_date, received_by,
                                         confirmed_by, confirmed_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $8 = 'confirmed' THEN $10::uuid END, CASE WHEN $8 = 'confirmed' THEN now() END)`,
              [propertyId, check.id, x.tender === 'cash' ? shiftId : null, x.tender, amount.toString(), x.tendered ?? null, x.reference?.trim() || null,
               status, check.businessDate, actorId()],
            ),
          );
        } catch (err) {
          if (isPgError(err, '23505')) throw conflict(`${x.tender} reference ${x.reference} is already recorded`, 'duplicate_payment');
          throw err;
        }
        if (x.tendered) change = change.add(Money.of(x.tendered).subtract(amount));
        remaining = remaining.subtract(amount);
      }
      await event(q, propertyId, check.id, 'paid', { tenders: tenders.map((x) => ({ tender: x.tender, amount: x.amount, status: x.status ?? 'confirmed' })) });
      await this.closeIfSettled(q, check);
      return { ...(await this.checks.view(q, propertyId, check.id)), change: change.toString() };
    });
  }

  /** Confirms or fails a pending (e.g. M-PESA) payment; the check closes once nothing is pending (AT-15). */
  async resolvePayment(propertyId: string, paymentId: string, outcome: 'confirmed' | 'failed', reason?: string) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ checkId: string }>('SELECT check_id AS "checkId" FROM pos_payments WHERE property_id = $1 AND id = $2', [propertyId, paymentId]);
      if (!rows[0]) throw new NotFoundException('Payment not found at this property');
      const check = await this.checks.lock(q, propertyId, rows[0].checkId, false);
      const { rows: [p] } = await q.query<{ status: string }>('SELECT status FROM pos_payments WHERE id = $1 FOR UPDATE', [paymentId]);
      if (p.status !== 'pending') throw conflict(`Payment is already ${p.status}`, 'payment_final');
      if (outcome === 'confirmed') {
        await q.query(`UPDATE pos_payments SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2 WHERE id = $1`, [paymentId, actorId()]);
      } else {
        await q.query(`UPDATE pos_payments SET status = 'failed', failed_reason = $2 WHERE id = $1`, [paymentId, reason ?? 'Not received']);
      }
      await event(q, propertyId, check.id, outcome === 'confirmed' ? 'payment_confirmed' : 'payment_failed', { paymentId, reason: reason ?? null });
      if (check.status === 'open') await this.closeIfSettled(q, check);
      return this.checks.view(q, propertyId, check.id);
    });
  }

  /** Closes a check whose total is zero (everything comped or cancelled). */
  async closeZero(propertyId: string, checkId: string) {
    return this.db.tx(async (q) => {
      const check = await this.checks.lock(q, propertyId, checkId);
      await this.checks.sendDrafts(q, check);
      if (!(await this.closeIfSettled(q, check))) {
        const t = await this.totals(q, check.id);
        throw conflict(`${Money.of(t.balance).format()} is still due on ${check.number}`, 'balance_not_zero');
      }
      return this.checks.view(q, propertyId, check.id);
    });
  }

  private async closeIfSettled(q: Queryable, check: LockedCheck): Promise<boolean> {
    const t = await this.totals(q, check.id);
    if (!Money.of(t.pending).isZero() || !Money.of(t.balance).isZero()) return false;
    const settlement = !Money.of(t.roomCharged).isZero()
      ? 'room_charge'
      : !Money.of(t.houseCharged).isZero() || (await this.hasHouseCharge(q, check.id))
        ? 'house_account'
        : !Money.of(t.paid).isZero()
          ? 'payment'
          : 'zero';
    await q.query(
      `UPDATE pos_checks SET status = 'closed', settlement = $2, closed_at = now(), closed_by = $3, finalised_at = now() WHERE id = $1`,
      [check.id, settlement, actorId()],
    );
    await event(q, check.propertyId, check.id, 'closed', { settlement, total: t.total });
    if (settlement === 'payment') await this.enqueueSapSale(q, check);
    return true;
  }

  private async hasHouseCharge(q: Queryable, checkId: string): Promise<boolean> {
    const { rowCount } = await q.query('SELECT 1 FROM house_account_charges WHERE check_id = $1', [checkId]);
    return Boolean(rowCount);
  }

  /**
   * Immediate-payment sales go to SAP as an A/R invoice plus an incoming
   * payment (brief §13 recommended start; SAP-04, SAP-05). Room-charged checks
   * are invoiced with the folio at checkout, so a sale is never invoiced twice.
   */
  private async enqueueSapSale(q: Queryable, check: LockedCheck): Promise<void> {
    const outlet = await outletById(q, check.outletId);
    const { rows: lines } = await q.query<{ name: string; quantity: string; amount: string; sapItemCode: string | null; chargeCode: string; vat: string | null }>(
      `SELECT l.name, l.quantity::text AS quantity, l.amount, mi.sap_item_code AS "sapItemCode", l.charge_code AS "chargeCode",
              (SELECT code FROM unnest(cc.tax_codes) AS code WHERE code LIKE 'O%' LIMIT 1) AS vat
         FROM pos_check_lines l JOIN menu_items mi ON mi.id = l.item_id JOIN charge_codes cc ON cc.code = l.charge_code
        WHERE l.check_id = $1 AND l.status NOT IN ('cancelled', 'wasted') AND l.amount > 0 ORDER BY l.added_at, l.id`,
      [check.id],
    );
    if (!lines.length) return;
    await this.outbox.enqueue({
      propertyId: check.propertyId,
      eventType: 'AR_INVOICE',
      externalRef: check.number,
      payload: {
        documentNumber: check.number,
        cardCode: 'C-WALKIN', // SAP-01 walk-in account; TBC with accounts
        docDate: check.businessDate,
        currency: 'KES',
        folioNumber: null,
        lines: lines.map((l) => {
          const unit = Money.of(l.amount).divide(l.quantity);
          const exact = unit.multiply(l.quantity).equals(l.amount);
          return {
            // Non-inventory sales items per tax category until the SAP item mapping is signed off (SAP-03).
            itemCode: l.sapItemCode ?? `POS-${l.chargeCode}`,
            description: exact ? l.name : `${Number(l.quantity)} × ${l.name}`,
            quantity: exact ? l.quantity : '1',
            unitPriceInclTax: exact ? unit.toString() : l.amount,
            taxCode: l.vat ?? 'TBC',
            revenueCentre: outlet.revenueCentre,
            dimension2Code: outlet.sapDimension2Code,
            warehouseCode: outlet.issuingWarehouseCode ?? undefined,
          };
        }),
      },
    });
    const { rows: pays } = await q.query<{ cash: string; other: string; refs: string | null }>(
      `SELECT coalesce(sum(amount) FILTER (WHERE tender = 'cash'), 0)::numeric(18,2)::text AS cash,
              coalesce(sum(amount) FILTER (WHERE tender <> 'cash'), 0)::numeric(18,2)::text AS other,
              string_agg(reference, ' ') FILTER (WHERE reference IS NOT NULL) AS refs
         FROM pos_payments WHERE check_id = $1 AND status = 'confirmed'`,
      [check.id],
    );
    await this.outbox.enqueue({
      propertyId: check.propertyId,
      eventType: 'INCOMING_PAYMENT',
      externalRef: `${check.number}-PAY`,
      payload: {
        receiptNumber: check.number,
        cardCode: 'C-WALKIN',
        docDate: check.businessDate,
        folioNumber: null,
        // Till cash and M-PESA/card clearing accounts per property are TBC (SAP-16).
        ...(Money.of(pays[0].cash).isZero() ? {} : { cashSum: pays[0].cash }),
        ...(Money.of(pays[0].other).isZero() ? {} : { transferSum: pays[0].other, transferReference: pays[0].refs?.slice(0, 27) }),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Room charge (POS-09, BIL-02, BIL-03, BIL-12, BIL-17)
  // -------------------------------------------------------------------------

  /** In-house guests a waiter can charge to, with eligibility shown before posting (POS-09). */
  async lookupStays(propertyId: string, query: string) {
    const term = query.trim();
    const { rows } = await this.db.query<{
      stayId: string; stayNumber: string; roomNumber: string; guestName: string; departureDate: string; roomChargeAllowed: boolean;
      creditLimit: string | null; folioStatus: string; balance: string;
    }>(
      `SELECT s.id AS "stayId", s.number AS "stayNumber", rm.number AS "roomNumber", g.first_name || ' ' || g.last_name AS "guestName",
              s.departure_date AS "departureDate", s.room_charge_allowed AS "roomChargeAllowed", s.credit_limit AS "creditLimit",
              f.status AS "folioStatus", fb.balance
         FROM stays s JOIN rooms rm ON rm.id = s.room_id JOIN guests g ON g.id = s.primary_guest_id
         JOIN folios f ON f.stay_id = s.id AND f.is_primary JOIN folio_balances fb ON fb.folio_id = f.id
        WHERE s.property_id = $1 AND s.status = 'checked_in'
          AND ($2 = '' OR rm.number = $2 OR g.last_name ILIKE $3 OR g.first_name ILIKE $3)
        ORDER BY rm.number LIMIT 20`,
      [propertyId, term, `${term.replace(/[%_\\]/g, '')}%`],
    );
    return rows.map((r) => {
      const available = r.creditLimit === null ? null : Money.of(r.creditLimit).subtract(r.balance);
      const reason = !r.roomChargeAllowed
        ? 'Room charges are not allowed for this stay'
        : r.folioStatus !== 'open'
          ? 'The folio is closed'
          : available !== null && available.compare(0) <= 0
            ? 'Credit limit reached'
            : null;
      return { ...r, available: available?.toString() ?? null, eligible: reason === null, reason };
    });
  }

  async roomCharge(propertyId: string, checkId: string, input: RoomChargeInput) {
    return this.db.tx(async (q) => {
      // Same lock order as the front desk (property → stay → folio), then the
      // check: a charge racing checkout is either settled or refused (AT-09).
      await businessDate(q, propertyId, true);
      const folio = await this.folios.lockPrimaryForStay(q, propertyId, input.stayId);
      const check = await this.checks.lock(q, propertyId, checkId);
      if (check.stayId && check.stayId !== folio.stayId) throw conflict(`Check ${check.number} belongs to another stay`, 'stay_mismatch');
      if (folio.stayStatus !== 'checked_in') {
        throw conflict(`Stay ${folio.stayNumber} is ${folio.stayStatus.replace('_', ' ')}; only in-house guests can charge to the room`, 'stay_not_in_house');
      }
      if (!folio.roomChargeAllowed) throw conflict(`Room charges are not allowed for stay ${folio.stayNumber}`, 'room_charge_blocked');
      if (folio.status !== 'open') throw conflict(`Folio ${folio.number} is closed`, 'folio_closed');
      const ack = input.acknowledgement;
      if (ack.method === 'guest_signature' && !ack.signature) throw new BadRequestException('Capture the guest’s signature, or verify the guest and choose staff verified (BIL-03)');

      await this.checks.sendDrafts(q, check);
      const t = await this.totals(q, check.id);
      if (!Money.of(t.pending).isZero()) throw conflict('A payment on this check is still pending; confirm or fail it first', 'pending_payments');
      const amount = Money.of(t.balance);
      if (amount.compare(0) <= 0) throw conflict(`Nothing is due on ${check.number}`, 'nothing_due');
      if (folio.creditLimit !== null) {
        const bal = await this.folios.balance(q, folio.id);
        const available = Money.of(folio.creditLimit).subtract(bal.balance);
        if (amount.compare(available) > 0) {
          throw conflict(`This would take stay ${folio.stayNumber} over its credit limit; ${available.format()} is available`, 'credit_limit', {
            available: available.toString(),
          });
        }
      }

      // Only the unpaid part moves to the folio, spread over the items so the folio stays itemised (AT-07).
      const lines = await this.checks.lines(q, check.id, `status NOT IN ('cancelled', 'wasted') AND amount > 0`);
      const parts = spreadOverLines(amount.toString(), lines.map((l) => l.amount));
      const full = amount.equals(t.total);
      const chargeIds: string[] = [];
      for (const [i, l] of lines.entries()) {
        if (Money.of(parts[i]).isZero()) continue;
        const posted = await this.folios.postCharge(q, {
          folio,
          chargeCode: l.chargeCode,
          description: `${Number(l.quantity)} × ${l.name}${full ? '' : ' (balance)'}`,
          quantity: '1',
          unitPrice: parts[i],
          outletId: check.outletId,
          serviceDate: check.businessDate,
          reference: check.number,
          posCheckId: check.id,
        });
        chargeIds.push(posted.id);
      }
      await q.query(
        `INSERT INTO pos_room_charges (property_id, check_id, stay_id, folio_id, amount, acknowledgement_method, signed_name, signature, business_date, posted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [propertyId, check.id, folio.stayId, folio.id, amount.toString(), ack.method, ack.signedName.trim(), ack.signature ?? null, check.businessDate, actorId()],
      );
      if (!check.stayId) await q.query('UPDATE pos_checks SET stay_id = $2 WHERE id = $1', [check.id, folio.stayId]);
      await event(q, propertyId, check.id, 'room_charged', { stay: folio.stayNumber, folio: folio.number, amount: amount.toString(), method: ack.method });
      await this.audit.record({
        action: 'pos.room_charge', entityType: 'pos_check', entityId: check.id, propertyId,
        newValues: { folio: folio.number, amount: amount.toString(), chargeIds, acknowledgement: ack.method },
      });
      await this.closeIfSettled(q, check);
      return { ...(await this.checks.view(q, propertyId, check.id)), posting: { folioNumber: folio.number, stayNumber: folio.stayNumber, amount: amount.toString(), folioChargeIds: chargeIds } };
    });
  }

  // -------------------------------------------------------------------------
  // House accounts (POS-18)
  // -------------------------------------------------------------------------

  async houseAccount(propertyId: string, checkId: string, input: { houseAccountCode: string; reason: string; approval?: ApprovalInputT }) {
    return this.db.tx(async (q) => {
      const check = await this.checks.lock(q, propertyId, checkId);
      const { rows: pays } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM pos_payments WHERE check_id = $1 AND status <> 'failed'`, [check.id]);
      if (pays[0].n) throw conflict('A check with payments cannot go to a house account', 'check_has_payments');
      const { rows: accts } = await q.query<{ id: string; name: string; monthlyLimit: string | null }>(
        `SELECT id, name, monthly_limit AS "monthlyLimit" FROM house_accounts WHERE property_id = $1 AND code = $2 AND is_active FOR UPDATE`,
        [propertyId, input.houseAccountCode.toUpperCase()],
      );
      const acct = accts[0];
      if (!acct) throw new NotFoundException(`House account ${input.houseAccountCode} not found at this property`);
      await this.checks.sendDrafts(q, check);
      const t = await this.totals(q, check.id);
      if (acct.monthlyLimit !== null) {
        const { rows: [used] } = await q.query<{ used: string }>(
          `SELECT coalesce(sum(amount), 0)::numeric(18,2)::text AS used FROM house_account_charges
            WHERE house_account_id = $1 AND date_trunc('month', business_date) = date_trunc('month', $2::date)`,
          [acct.id, check.businessDate],
        );
        if (Money.of(used.used).add(t.total).compare(acct.monthlyLimit) > 0) {
          throw conflict(`${acct.name} has ${Money.of(acct.monthlyLimit).subtract(used.used).format()} left this month`, 'house_limit');
        }
      }
      const approvalId = await this.approvals.approve({
        permission: 'approve.house_account', propertyId, action: 'pos.house_account', entityType: 'pos_check', entityId: check.id, reason: input.reason,
        approval: input.approval, details: { check: check.number, account: input.houseAccountCode, amount: t.total },
      });
      await q.query(
        `INSERT INTO house_account_charges (property_id, house_account_id, check_id, amount, reason, approval_id, business_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [propertyId, acct.id, check.id, t.total, input.reason, approvalId, check.businessDate, actorId()],
      );
      await event(q, propertyId, check.id, 'house_account', { account: input.houseAccountCode, amount: t.total, reason: input.reason });
      await this.closeIfSettled(q, check);
      return this.checks.view(q, propertyId, check.id);
    });
  }

  // -------------------------------------------------------------------------
  // Refunds (POS-11, BIL-07)
  // -------------------------------------------------------------------------

  async refund(propertyId: string, checkId: string, input: { paymentId: string; amount: string; reason: string; reference?: string | null; approval?: ApprovalInputT }) {
    return this.db.tx(async (q) => {
      const check = await this.checks.lock(q, propertyId, checkId, false);
      if (check.status !== 'closed') throw conflict(`Only a closed check can be refunded; ${check.number} is ${check.status}`, 'check_not_closed');
      const { rows } = await q.query<{ tender: string; amount: string; status: string; refunded: string }>(
        `SELECT p.tender::text AS tender, p.amount, p.status,
                coalesce((SELECT sum(r.amount) FROM pos_refunds r WHERE r.payment_id = p.id), 0)::numeric(18,2)::text AS refunded
           FROM pos_payments p WHERE p.id = $1 AND p.check_id = $2 FOR UPDATE OF p`,
        [input.paymentId, check.id],
      );
      const pay = rows[0];
      if (!pay) throw new NotFoundException('Payment not found on this check');
      if (pay.status !== 'confirmed') throw conflict('Only a confirmed payment can be refunded', 'payment_not_confirmed');
      const refundable = Money.of(pay.amount).subtract(pay.refunded);
      const amount = Money.of(input.amount);
      if (amount.compare(refundable) > 0) throw conflict(`At most ${refundable.format()} of this payment can still be refunded`, 'refund_too_large');
      const approvalId = await this.approvals.approve({
        permission: 'approve.refund', propertyId, action: 'pos.refund', entityType: 'pos_check', entityId: check.id, reason: input.reason,
        approval: input.approval, details: { check: check.number, tender: pay.tender, amount: amount.toString() },
      });
      const shiftId = pay.tender === 'cash' ? await this.openShift(q, propertyId) : null;
      if (pay.tender === 'cash' && !shiftId) throw conflict('Open your cashier shift to pay a cash refund from the drawer', 'no_open_shift');
      const day = await this.days.currentDay(q, await outletById(q, check.outletId), true);
      const number = await this.numbering.next(propertyId, 'REFUND');
      const { rows: [r] } = await q.query<{ id: string }>(
        `INSERT INTO pos_refunds (property_id, number, check_id, payment_id, tender, amount, reason, approval_id, shift_id, reference, business_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [propertyId, number, check.id, input.paymentId, pay.tender, amount.toString(), input.reason, approvalId, shiftId, input.reference ?? null,
         day!.businessDate, actorId()],
      );
      await event(q, propertyId, check.id, 'refunded', { number, tender: pay.tender, amount: amount.toString(), reason: input.reason });
      await this.audit.record({ action: 'pos.refund', entityType: 'pos_check', entityId: check.id, propertyId, reason: input.reason, newValues: { refundId: r.id, number, amount: amount.toString() } });
      return { refund: { id: r.id, number, tender: pay.tender, amount: amount.toString() }, check: await this.checks.view(q, propertyId, check.id) };
    });
  }
}
