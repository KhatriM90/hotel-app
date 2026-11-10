import { Injectable } from '@nestjs/common';
import { hasPermission } from '@hotel/shared';
import { DbService } from '../db/db.service';
import { requestContext } from '../db/request-context';
import { ApprovalsService } from '../frontoffice/approvals.service';
import { ApprovalInputT, conflict } from '../frontoffice/common';
import { FoliosService } from '../frontoffice/folios.service';
import { PosChecksService } from './checks.service';
import { actorId, event } from './common';
import { PosPrintingService } from './printing.service';
import { renderCheck } from './render';

export interface BillPrintInput {
  reason?: string;
  approval?: ApprovalInputT;
}

/**
 * Guest bill and receipt printing (POS-10) with reprint control, from the
 * Kahama service-team meeting of 9 Nov 2026: a waiter could print the same
 * bill again and again and use it to charge other guests.
 *
 * - The first bill prints freely. Another print is free only if the bill has
 *   changed since the last one (items added or cancelled, a discount, a part
 *   payment); the slip then says UPDATED BILL.
 * - A copy of an unchanged bill needs a reason and a manager's approval
 *   (approve.bill_reprint, SEC-02) and says REPRINT #n.
 * - Once paid, the receipt prints once; any receipt copy needs approval too.
 * Every print is recorded (append-only) with who printed it and on which tablet.
 */
@Injectable()
export class PosBillPrintsService {
  constructor(
    private readonly db: DbService,
    private readonly checks: PosChecksService,
    private readonly approvals: ApprovalsService,
    private readonly folios: FoliosService,
    private readonly printing: PosPrintingService,
  ) {}

  async print(propertyId: string, checkId: string, input: BillPrintInput) {
    const header = await this.folios.headerFor(propertyId);
    return this.db.tx(async (q) => {
      const check = await this.checks.lock(q, propertyId, checkId, false);
      if (check.status === 'merged') throw conflict(`Check ${check.number} was merged into another check; print that one`, 'check_merged');
      const kind: 'bill' | 'receipt' = check.status === 'open' ? 'bill' : 'receipt';

      // What the slip will show: live lines (id, quantity, amount) and the balance due.
      const { rows: [state] } = await q.query<{ total: string; lineState: string }>(
        `SELECT tot.total::text AS total,
                md5(coalesce((SELECT string_agg(l.id || ':' || l.quantity || ':' || l.amount, ',' ORDER BY l.id)
                                FROM pos_check_lines l WHERE l.check_id = tot.check_id AND l.status NOT IN ('cancelled', 'wasted')), '')
                    || '|' || tot.balance::text) AS "lineState"
           FROM pos_check_totals tot WHERE tot.check_id = $1`,
        [check.id],
      );
      const { rows: [last] } = await q.query<{ printNo: number; lineState: string }>(
        `SELECT print_no AS "printNo", line_state AS "lineState" FROM pos_bill_prints
          WHERE check_id = $1 AND kind = $2 ORDER BY print_no DESC LIMIT 1`,
        [check.id, kind],
      );
      const printNo = (last?.printNo ?? 0) + 1;
      const changed = !!last && kind === 'bill' && last.lineState !== state.lineState;

      let approvalId: string | null = null;
      if (last && !changed) {
        const what = kind === 'bill' ? `Bill ${check.number} was already printed and nothing has changed since` : `The receipt for ${check.number} was already printed`;
        if (!input.reason) {
          const user = requestContext.get()?.user;
          throw conflict(`${what}. A reprint needs a reason and a manager's approval.`, 'reprint_restricted', {
            kind,
            printNo,
            selfApprove: !!user && hasPermission(user.roles, 'approve.bill_reprint'),
          });
        }
        approvalId = await this.approvals.approve({
          permission: 'approve.bill_reprint', propertyId, action: 'pos.bill_reprint', entityType: 'pos_check', entityId: check.id,
          reason: input.reason, approval: input.approval, details: { check: check.number, kind, printNo },
        });
      }

      await q.query(
        `INSERT INTO pos_bill_prints (property_id, check_id, kind, print_no, total, line_state, changed, reason, approval_id, printed_by, device_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [propertyId, check.id, kind, printNo, state.total, state.lineState, changed, approvalId ? input.reason : null, approvalId, actorId(),
          requestContext.get()?.posDeviceId ?? null],
      );
      await event(q, propertyId, check.id, printNo === 1 ? `${kind}_printed` : `${kind}_reprinted`, {
        printNo, changed, reason: approvalId ? input.reason : null,
      });
      const view = await this.checks.view(q, propertyId, check.id);
      // On the outlet's receipt printer when it has one (INT-04); the tablet prints the html otherwise.
      const job = await this.printing.queueCheck(q, propertyId, view, header, { kind, printNo, changed });
      return { kind, printNo, changed, html: renderCheck(view, header, { printNo, changed }), printer: job?.printer ?? null, printJobId: job?.id ?? null };
    });
  }

  /** Bill and receipt reprints for a range of business dates, newest first (manager report). */
  async reprints(propertyId: string, from: string, to: string, outletCode?: string) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{
        printedAt: string; checkNumber: string; outlet: string; kind: string; printNo: number; changed: boolean; reason: string | null;
        printedBy: string; waiter: string; approvedBy: string | null; total: string; device: string | null; businessDate: string;
      }>(
        `SELECT bp.printed_at AS "printedAt", c.number AS "checkNumber", o.name AS outlet, bp.kind, bp.print_no AS "printNo", bp.changed,
                bp.reason, pu.display_name AS "printedBy", w.display_name AS waiter, au.display_name AS "approvedBy", bp.total::text AS total,
                d.name AS device, c.business_date::text AS "businessDate"
           FROM pos_bill_prints bp
           JOIN pos_checks c ON c.id = bp.check_id JOIN outlets o ON o.id = c.outlet_id
           JOIN users pu ON pu.id = bp.printed_by JOIN users w ON w.id = c.waiter_id
           LEFT JOIN approvals a ON a.id = bp.approval_id LEFT JOIN users au ON au.id = a.approved_by
           LEFT JOIN pos_devices d ON d.id = bp.device_id
          WHERE bp.property_id = $1 AND bp.print_no > 1 AND c.business_date BETWEEN $2 AND $3 AND ($4::text IS NULL OR o.code = $4)
          ORDER BY bp.printed_at DESC LIMIT 1000`,
        [propertyId, from, to, outletCode?.toUpperCase() ?? null],
      );
      const byUser = new Map<string, { printedBy: string; updated: number; copies: number }>();
      for (const r of rows) {
        const s = byUser.get(r.printedBy) ?? { printedBy: r.printedBy, updated: 0, copies: 0 };
        if (r.changed) s.updated++;
        else s.copies++;
        byUser.set(r.printedBy, s);
      }
      return {
        from,
        to,
        copies: rows.filter((r) => !r.changed).length,
        updated: rows.filter((r) => r.changed).length,
        byUser: [...byUser.values()].sort((a, b) => b.copies - a.copies || b.updated - a.updated),
        rows,
      };
    });
  }
}
