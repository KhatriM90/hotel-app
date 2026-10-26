import { Global, Injectable, Module } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { PropertyScope, requestContext } from '../db/request-context';

export interface AuditEntry {
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  propertyId?: string | null;
  businessDate?: string | null;
  previousValues?: unknown;
  newValues?: unknown;
  reason?: string | null;
  actorUserId?: string | null;
}

/**
 * Append-only audit log (SEC-04). Writes join the caller's transaction, so an
 * audited change and its audit record commit or roll back together.
 */
@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  async record(entry: AuditEntry, scope?: PropertyScope): Promise<void> {
    const ctx = requestContext.get();
    await this.db.tx(
      (q) =>
        q.query(
        `INSERT INTO audit_events
           (business_date, property_id, actor_user_id, action, entity_type, entity_id,
            previous_values, new_values, reason, request_id, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          entry.businessDate ?? ctx?.property?.businessDate ?? null,
          entry.propertyId ?? ctx?.property?.id ?? null,
          entry.actorUserId ?? ctx?.user?.id ?? null,
          entry.action,
          entry.entityType ?? null,
          entry.entityId ?? null,
          entry.previousValues === undefined ? null : JSON.stringify(entry.previousValues),
          entry.newValues === undefined ? null : JSON.stringify(entry.newValues),
          entry.reason ?? null,
          ctx?.requestId ?? null,
          ctx?.ip ?? null,
        ],
        ),
      scope,
    );
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
