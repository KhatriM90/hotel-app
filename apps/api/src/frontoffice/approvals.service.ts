import { ForbiddenException, Injectable } from '@nestjs/common';
import { hasPermission, Permission } from '@hotel/shared';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { DbService } from '../db/db.service';
import { requestContext } from '../db/request-context';
import { ApprovalInputT } from './common';

export interface ApprovalRequest {
  permission: Permission;
  propertyId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  reason: string;
  approval?: ApprovalInputT;
  details?: Record<string, unknown>;
}

/**
 * Approval matrix (SEC-02). If the acting user holds the `approve.*`
 * permission they approve their own action; otherwise a holder with access to
 * the property must sign off with their credentials (a manager at the desk).
 * Every approval is recorded with requester, approver and reason, and audited.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly db: DbService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  async approve(req: ApprovalRequest): Promise<string> {
    const actor = requestContext.get()?.user;
    if (!actor) throw new ForbiddenException('Not signed in');

    let approverId = actor.id;
    if (!hasPermission(actor.roles, req.permission)) {
      if (!req.approval) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'approval_required',
          message: `This needs approval from a user with ${req.permission}`,
          permission: req.permission,
        });
      }
      const approver = await this.auth.verifyCredentials(req.approval.username, req.approval.password);
      const canApproveHere = approver && (approver.allProperties || approver.propertyIds.includes(req.propertyId));
      if (!approver || !canApproveHere || !hasPermission(approver.roles, req.permission)) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'approval_rejected',
          message: `Approval rejected: the approver's credentials are wrong or they lack ${req.permission} at this property`,
        });
      }
      if (approver.id === actor.id) throw new ForbiddenException('You cannot approve your own request');
      approverId = approver.id;
    }

    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO approvals (property_id, action, entity_type, entity_id, requested_by, approved_by, reason, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [req.propertyId, req.action, req.entityType, req.entityId ?? null, actor.id, approverId, req.reason, req.details ?? null],
    );
    await this.audit.record({
      action: 'approval.granted',
      entityType: req.entityType,
      entityId: req.entityId ?? null,
      propertyId: req.propertyId,
      newValues: { approvalId: rows[0].id, action: req.action, approvedBy: approverId, details: req.details ?? null },
      reason: req.reason,
    });
    return rows[0].id;
  }
}
