import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { SYSTEM_SCOPE } from '../db/request-context';

export const MAX_RETRYABLE_ATTEMPTS = 25;
const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 3600;

export type OutboxStatus = 'pending' | 'claimed' | 'posted' | 'failed' | 'dead';

export interface OutboxRow {
  id: string;
  propertyId: string;
  target: 'SAP';
  eventType: string;
  externalRef: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  claimedBy: string | null;
  sapDocEntry: number | null;
  sapDocNum: number | null;
  lastError: string | null;
  createdAt: string;
  postedAt: string | null;
}

export interface ClaimedJob extends OutboxRow {
  property: { code: string; sapBranchId: number | null; sapDimension1: string };
}

export type JobResult =
  | { outcome: 'posted'; docEntry: number; docNum?: number | null; alreadyExisted?: boolean }
  | { outcome: 'failed'; error: string; retryable: boolean };

const COLUMNS = `
  o.id, o.property_id AS "propertyId", o.target, o.event_type AS "eventType", o.external_ref AS "externalRef",
  o.payload, o.status, o.attempts, o.next_attempt_at AS "nextAttemptAt", o.claimed_by AS "claimedBy",
  o.sap_doc_entry AS "sapDocEntry", o.sap_doc_num AS "sapDocNum", o.last_error AS "lastError",
  o.created_at AS "createdAt", o.posted_at AS "postedAt"`;

export function backoffSeconds(attempts: number): number {
  return Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempts - 1));
}

/**
 * Durable outbox for SAP postings (§9, INT-07, SAP-11, OPS-02). Rows are
 * written in the same transaction as the business change and pulled by the
 * HQ worker; the cloud never calls into the HQ network (brief §12).
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Enqueue inside the caller's business transaction. `externalRef` is the SAP U_HTL_ExtRef. */
  async enqueue(input: {
    propertyId: string;
    eventType: string;
    externalRef: string;
    payload: Record<string, unknown>;
  }): Promise<OutboxRow> {
    const { rows } = await this.db.query<OutboxRow>(
      `INSERT INTO integration_outbox AS o (property_id, target, event_type, external_ref, payload)
       VALUES ($1, 'SAP', $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [input.propertyId, input.eventType, input.externalRef, JSON.stringify(input.payload)],
    );
    return rows[0];
  }

  /** Oldest-first claim with SKIP LOCKED so several workers never take the same job. */
  async claim(workerId: string, limit: number, leaseSeconds: number): Promise<ClaimedJob[]> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<ClaimedJob>(
        `WITH picked AS (
           SELECT id FROM integration_outbox
            WHERE target = 'SAP'
              AND ((status IN ('pending', 'failed') AND next_attempt_at <= now())
                OR (status = 'claimed' AND claim_expires_at < now()))
            ORDER BY created_at
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         ), updated AS (
         UPDATE integration_outbox o
            SET status = 'claimed', claimed_by = $1, attempts = o.attempts + 1,
                claim_expires_at = now() + make_interval(secs => $3)
           FROM picked, properties p
          WHERE o.id = picked.id AND p.id = o.property_id
         RETURNING ${COLUMNS},
           json_build_object('code', p.code, 'sapBranchId', p.sap_branch_id,
                             'sapDimension1', p.sap_dimension1) AS property
         )
         SELECT * FROM updated ORDER BY "createdAt"`,
        [workerId, limit, leaseSeconds],
      );
      return rows;
    }, SYSTEM_SCOPE);
  }

  async complete(id: string, workerId: string, result: JobResult): Promise<OutboxRow> {
    return this.db.tx(async (q) => {
      const { rows: current } = await q.query<{ attempts: number; property_id: string }>(
        `SELECT attempts, property_id FROM integration_outbox
          WHERE id = $1 AND status = 'claimed' AND claimed_by = $2
          FOR UPDATE`,
        [id, workerId],
      );
      if (!current[0]) {
        throw new ConflictException('Job is not claimed by this worker (claim expired or already completed)');
      }

      let sql: string;
      let params: unknown[];
      if (result.outcome === 'posted') {
        sql = `UPDATE integration_outbox o
                  SET status = 'posted', sap_doc_entry = $2, sap_doc_num = $3, posted_at = now(),
                      claimed_by = NULL, claim_expires_at = NULL, last_error = NULL
                WHERE id = $1 RETURNING ${COLUMNS}`;
        params = [id, result.docEntry, result.docNum ?? null];
      } else {
        const dead = !result.retryable || current[0].attempts >= MAX_RETRYABLE_ATTEMPTS;
        sql = `UPDATE integration_outbox o
                  SET status = $2::outbox_status, last_error = $3, claimed_by = NULL, claim_expires_at = NULL,
                      next_attempt_at = now() + make_interval(secs => $4)
                WHERE id = $1 RETURNING ${COLUMNS}`;
        params = [id, dead ? 'dead' : 'failed', result.error.slice(0, 4000), backoffSeconds(current[0].attempts)];
      }
      const { rows } = await q.query<OutboxRow>(sql, params);
      const row = rows[0];
      if (row.status === 'dead') {
        await this.audit.record({
          action: 'integration.dead_letter',
          entityType: 'integration_outbox',
          entityId: id,
          propertyId: row.propertyId,
          newValues: { error: row.lastError, attempts: row.attempts },
        });
      }
      return row;
    }, SYSTEM_SCOPE);
  }

  /** Authorised replay after the mapping/master data was corrected in SAP (SAP-AT06). */
  async replay(propertyId: string, id: string, reason: string): Promise<OutboxRow> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<OutboxRow>(
        `UPDATE integration_outbox o
            SET status = 'pending', next_attempt_at = now(), last_error = NULL
          WHERE id = $1 AND property_id = $2 AND status IN ('dead', 'failed')
          RETURNING ${COLUMNS}`,
        [id, propertyId],
      );
      if (!rows[0]) throw new NotFoundException('No failed or dead integration event with that id at this property');
      await this.audit.record({
        action: 'integration.replay',
        entityType: 'integration_outbox',
        entityId: id,
        propertyId,
        reason,
      });
      return rows[0];
    });
  }

  async list(propertyId: string, status?: OutboxStatus, limit = 100): Promise<OutboxRow[]> {
    const { rows } = await this.db.query<OutboxRow>(
      `SELECT ${COLUMNS} FROM integration_outbox o
        WHERE o.property_id = $1 AND ($2::outbox_status IS NULL OR o.status = $2::outbox_status)
        ORDER BY o.created_at DESC LIMIT $3`,
      [propertyId, status ?? null, limit],
    );
    return rows;
  }

  /** Housekeeping: make abandoned claims visible as pending again. */
  async releaseExpiredClaims(): Promise<number> {
    const { rowCount } = await this.db.tx(
      (q) =>
        q.query(
          `UPDATE integration_outbox
              SET status = 'pending', claimed_by = NULL, claim_expires_at = NULL
            WHERE status = 'claimed' AND claim_expires_at < now()`,
        ),
      SYSTEM_SCOPE,
    );
    return rowCount ?? 0;
  }
}
