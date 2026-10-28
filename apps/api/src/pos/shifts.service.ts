import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { hasPermission, Money } from '@hotel/shared';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { requestContext } from '../db/request-context';
import { ApprovalsService } from '../frontoffice/approvals.service';
import { ApprovalInputT, conflict } from '../frontoffice/common';
import { NumberingService } from '../numbering/numbering.service';
import { actorId, outletByCode } from './common';
import { PosDaysService } from './days.service';

export interface CashMovementInput {
  kind: 'paid_in' | 'paid_out' | 'drop';
  amount: string;
  reason: string;
  approval?: ApprovalInputT;
}

interface ShiftRow {
  id: string;
  number: string;
  propertyId: string;
  outletId: string;
  outletCode: string;
  userId: string;
  status: 'open' | 'closed';
  openingFloat: string;
}

/**
 * Cashier shifts (POS-13). A cashier opens a shift with a float before taking
 * cash, records paid-ins, paid-outs (manager approval, AT-13) and drops, and
 * closes with a blind count: the expected drawer is never shown before the
 * count. A variance is then reviewed by a manager.
 */
@Injectable()
export class PosShiftsService {
  constructor(
    private readonly db: DbService,
    private readonly days: PosDaysService,
    private readonly approvals: ApprovalsService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  private async lock(q: Queryable, propertyId: string, shiftId: string): Promise<ShiftRow> {
    const { rows } = await q.query<ShiftRow>(
      `SELECT s.id, s.number, s.property_id AS "propertyId", s.outlet_id AS "outletId", o.code AS "outletCode", s.user_id AS "userId",
              s.status, s.opening_float::text AS "openingFloat"
         FROM cashier_shifts s JOIN outlets o ON o.id = s.outlet_id
        WHERE s.property_id = $1 AND s.id = $2 FOR UPDATE OF s`,
      [propertyId, shiftId],
    );
    if (!rows[0]) throw new NotFoundException('Cashier shift not found at this property');
    return rows[0];
  }

  private async ownOpen(q: Queryable, propertyId: string): Promise<ShiftRow> {
    const { rows } = await q.query<{ id: string }>(
      `SELECT id FROM cashier_shifts WHERE property_id = $1 AND user_id = $2 AND status = 'open'`,
      [propertyId, actorId()],
    );
    if (!rows[0]) throw conflict('You have no open cashier shift', 'no_open_shift');
    return this.lock(q, propertyId, rows[0].id);
  }

  /** Expected drawer: float + cash taken + paid-ins − paid-outs − drops − cash refunds. */
  private async expected(q: Queryable, shift: { id: string; openingFloat: string }) {
    const { rows: [x] } = await q.query<Record<string, string>>(
      `SELECT (SELECT coalesce(sum(amount), 0) FROM pos_payments WHERE shift_id = $1 AND tender = 'cash' AND status = 'confirmed')::numeric(18,2)::text AS "cashSales",
              (SELECT coalesce(sum(amount), 0) FROM cash_movements WHERE shift_id = $1 AND kind = 'paid_in')::numeric(18,2)::text AS "paidIn",
              (SELECT coalesce(sum(amount), 0) FROM cash_movements WHERE shift_id = $1 AND kind = 'paid_out')::numeric(18,2)::text AS "paidOut",
              (SELECT coalesce(sum(amount), 0) FROM cash_movements WHERE shift_id = $1 AND kind = 'drop')::numeric(18,2)::text AS drops,
              (SELECT coalesce(sum(amount), 0) FROM pos_refunds WHERE shift_id = $1 AND tender = 'cash')::numeric(18,2)::text AS "cashRefunds"`,
      [shift.id],
    );
    const expected = Money.of(shift.openingFloat).add(x.cashSales).add(x.paidIn).subtract(x.paidOut).subtract(x.drops).subtract(x.cashRefunds);
    return { openingFloat: shift.openingFloat, ...x, expected: expected.toString() };
  }

  async open(propertyId: string, input: { outletCode: string; openingFloat: string; handoverFromId?: string | null }) {
    return this.db.tx(async (q) => {
      const outlet = await outletByCode(q, propertyId, input.outletCode);
      const day = await this.days.currentDay(q, outlet, true);
      if (input.handoverFromId) {
        const { rows } = await q.query<{ status: string; outletId: string }>(
          `SELECT status, outlet_id AS "outletId" FROM cashier_shifts WHERE property_id = $1 AND id = $2`,
          [propertyId, input.handoverFromId],
        );
        if (!rows[0]) throw new NotFoundException('The shift being handed over was not found');
        if (rows[0].status !== 'closed') throw conflict('The previous cashier must count and close their shift before the handover', 'shift_open');
        if (rows[0].outletId !== outlet.id) throw conflict('A handover must be at the same outlet', 'outlet_mismatch');
      }
      const number = await this.numbering.next(propertyId, 'CASH_SHIFT');
      let id: string;
      try {
        const { rows } = await q.query<{ id: string }>(
          `INSERT INTO cashier_shifts (property_id, number, outlet_id, outlet_day_id, user_id, opening_float, handover_from_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [propertyId, number, outlet.id, day!.id, actorId(), Money.of(input.openingFloat).toString(), input.handoverFromId ?? null],
        );
        id = rows[0].id;
      } catch (err) {
        const c = (err as { constraint?: string }).constraint;
        if (c === 'cashier_shifts_one_open_per_user') throw conflict('You already have an open cashier shift', 'shift_open');
        if (c === 'cashier_shifts_one_handover') throw conflict('That shift has already been handed over', 'already_handed_over');
        throw err;
      }
      await this.audit.record({
        action: 'pos.shift_open', entityType: 'cashier_shift', entityId: id, propertyId, businessDate: day!.businessDate,
        newValues: { number, outletCode: outlet.code, openingFloat: input.openingFloat },
      });
      return this.view(q, propertyId, id, false);
    });
  }

  /** The caller's open shift, without the expected drawer (blind count). */
  async current(propertyId: string) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `SELECT id FROM cashier_shifts WHERE property_id = $1 AND user_id = $2 AND status = 'open'`,
        [propertyId, actorId()],
      );
      return rows[0] ? this.view(q, propertyId, rows[0].id, false) : null;
    });
  }

  async movement(propertyId: string, input: CashMovementInput) {
    return this.db.tx(async (q) => {
      const shift = await this.ownOpen(q, propertyId);
      const approvalId =
        input.kind === 'paid_out'
          ? await this.approvals.approve({
              permission: 'approve.cash_out', propertyId, action: 'pos.paid_out', entityType: 'cashier_shift', entityId: shift.id,
              reason: input.reason, approval: input.approval, details: { amount: input.amount },
            })
          : null;
      await q.query(
        `INSERT INTO cash_movements (property_id, shift_id, kind, amount, reason, approval_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [propertyId, shift.id, input.kind, Money.of(input.amount).toString(), input.reason, approvalId, actorId()],
      );
      await this.audit.record({
        action: `pos.cash_${input.kind}`, entityType: 'cashier_shift', entityId: shift.id, propertyId, reason: input.reason,
        newValues: { amount: input.amount, approvalId },
      });
      return this.view(q, propertyId, shift.id, false);
    });
  }

  /**
   * Blind count. The cashier closes their own shift; a manager (who may approve
   * cash variances) can count and close a shift someone left open.
   */
  async close(propertyId: string, shiftId: string, input: { countedAmount: string; note?: string | null }) {
    return this.db.tx(async (q) => {
      const shift = await this.lock(q, propertyId, shiftId);
      const user = requestContext.get()?.user;
      if (shift.userId !== user?.id && !hasPermission(user?.roles ?? [], 'approve.cash_variance')) {
        throw new ForbiddenException('Only the cashier or a manager can close this shift');
      }
      if (shift.status !== 'open') throw conflict(`Shift ${shift.number} is already closed`, 'shift_closed');
      const { rows: pending } = await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pos_payments WHERE shift_id = $1 AND status = 'pending'`,
        [shift.id],
      );
      if (pending[0].n) throw conflict('Resolve the pending payments of this shift first', 'pending_payments');
      const exp = await this.expected(q, shift);
      const counted = Money.of(input.countedAmount);
      const variance = counted.subtract(exp.expected);
      await q.query(
        `UPDATE cashier_shifts SET status = 'closed', counted_amount = $2, expected_amount = $3, variance = $4, count_note = $5,
                closed_at = now(), closed_by = $6, finalised_at = now()
          WHERE id = $1`,
        [shift.id, counted.toString(), exp.expected, variance.toString(), input.note ?? null, actorId()],
      );
      await this.audit.record({
        action: 'pos.shift_close', entityType: 'cashier_shift', entityId: shift.id, propertyId,
        newValues: { counted: counted.toString(), expected: exp.expected, variance: variance.toString() },
      });
      return this.view(q, propertyId, shift.id, true);
    });
  }

  async review(propertyId: string, shiftId: string, input: { note: string; approval?: ApprovalInputT }) {
    return this.db.tx(async (q) => {
      const shift = await this.lock(q, propertyId, shiftId);
      if (shift.status !== 'closed') throw conflict('Count and close the shift before reviewing it', 'shift_open');
      const { rows } = await q.query<{ reviewed: boolean; variance: string }>(
        `SELECT reviewed_at IS NOT NULL AS reviewed, variance::text FROM cashier_shifts WHERE id = $1`,
        [shift.id],
      );
      if (rows[0].reviewed) throw conflict(`Shift ${shift.number} has already been reviewed`, 'already_reviewed');
      const approvalId = await this.approvals.approve({
        permission: 'approve.cash_variance', propertyId, action: 'pos.cash_variance', entityType: 'cashier_shift', entityId: shift.id,
        reason: input.note, approval: input.approval, details: { variance: rows[0].variance },
      });
      const { rows: [approver] } = await q.query<{ approvedBy: string }>(`SELECT approved_by AS "approvedBy" FROM approvals WHERE id = $1`, [approvalId]);
      await q.query(
        `UPDATE cashier_shifts SET reviewed_by = $2, reviewed_at = now(), review_note = $3, review_approval_id = $4 WHERE id = $1`,
        [shift.id, approver.approvedBy, input.note, approvalId],
      );
      return this.view(q, propertyId, shift.id, true);
    });
  }

  async list(propertyId: string, filter: { outletCode?: string; status?: 'open' | 'closed'; unreviewed?: boolean }) {
    return this.db.tx(async (q) => {
      const outletId = filter.outletCode ? (await outletByCode(q, propertyId, filter.outletCode, false)).id : null;
      const { rows } = await q.query(
        `SELECT s.id, s.number, o.code AS "outletCode", o.name AS "outletName", u.display_name AS cashier, s.status,
                d.business_date AS "businessDate", s.opening_float::text AS "openingFloat", s.opened_at AS "openedAt", s.closed_at AS "closedAt",
                s.counted_amount::text AS "countedAmount", s.expected_amount::text AS "expectedAmount", s.variance::text AS variance,
                s.reviewed_at AS "reviewedAt", ru.display_name AS "reviewedBy", s.review_note AS "reviewNote"
           FROM cashier_shifts s JOIN outlets o ON o.id = s.outlet_id JOIN users u ON u.id = s.user_id
           JOIN pos_outlet_days d ON d.id = s.outlet_day_id LEFT JOIN users ru ON ru.id = s.reviewed_by
          WHERE s.property_id = $1 AND ($2::uuid IS NULL OR s.outlet_id = $2) AND ($3::text IS NULL OR s.status = $3)
            AND (NOT $4 OR (s.status = 'closed' AND s.reviewed_at IS NULL AND s.variance <> 0))
          ORDER BY s.opened_at DESC LIMIT 200`,
        [propertyId, outletId, filter.status ?? null, filter.unreviewed ?? false],
      );
      return rows;
    });
  }

  async get(propertyId: string, shiftId: string) {
    return this.db.tx((q) => this.view(q, propertyId, shiftId, true));
  }

  private async view(q: Queryable, propertyId: string, shiftId: string, showExpected: boolean) {
    const { rows } = await q.query<Record<string, unknown> & { status: string }>(
      `SELECT s.id, s.number, o.code AS "outletCode", o.name AS "outletName", u.username, u.display_name AS cashier, s.status,
              d.business_date AS "businessDate", s.opening_float::text AS "openingFloat", s.handover_from_id AS "handoverFromId",
              s.opened_at AS "openedAt", s.closed_at AS "closedAt", s.counted_amount::text AS "countedAmount",
              s.expected_amount::text AS "expectedAmount", s.variance::text AS variance, s.count_note AS "countNote",
              s.reviewed_at AS "reviewedAt", ru.display_name AS "reviewedBy", s.review_note AS "reviewNote"
         FROM cashier_shifts s JOIN outlets o ON o.id = s.outlet_id JOIN users u ON u.id = s.user_id
         JOIN pos_outlet_days d ON d.id = s.outlet_day_id LEFT JOIN users ru ON ru.id = s.reviewed_by
        WHERE s.property_id = $1 AND s.id = $2`,
      [propertyId, shiftId],
    );
    const shift = rows[0];
    if (!shift) throw new NotFoundException('Cashier shift not found at this property');
    const { rows: movements } = await q.query(
      `SELECT m.kind, m.amount::text AS amount, m.reason, m.created_at AS "createdAt", u.display_name AS "by"
         FROM cash_movements m LEFT JOIN users u ON u.id = m.created_by WHERE m.shift_id = $1 ORDER BY m.created_at`,
      [shiftId],
    );
    if (!showExpected || shift.status === 'open') {
      // Blind count: nothing that reveals what the drawer should hold.
      const { expectedAmount: _e, variance: _v, ...blind } = shift;
      return { ...blind, movements };
    }
    return { ...shift, movements, breakdown: await this.expected(q, { id: shiftId, openingFloat: shift.openingFloat as string }) };
  }
}
