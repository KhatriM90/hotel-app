import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { from, lastValueFrom, Observable } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { requestContext } from '../db/request-context';

export const IDEMPOTENT = 'idempotency:required';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
const KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

/**
 * Requires an `Idempotency-Key` header and makes the route safe to retry
 * (brief §9; BIL-04; AT-03). Apply to every route that posts a charge,
 * payment, nightly charge or fiscal submission.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);

/** Stable JSON: object keys sorted, so semantically equal bodies hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

interface StoredKey {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
}

/**
 * The key row is inserted in the same database transaction as the handler's
 * work. Outcomes:
 *  - first request: handler runs, response stored, both commit together;
 *  - handler throws: everything rolls back, the key is free for a retry;
 *  - concurrent duplicate: its INSERT waits on the primary key until the first
 *    commits, then it replays the stored response (no second charge);
 *  - same key, different body: 422.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT, [ctx.getHandler(), ctx.getClass()]);
    if (!required || ctx.getType() !== 'http') return next.handle();

    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const key = req.header(IDEMPOTENCY_HEADER);
    if (!key || !KEY_RE.test(key)) {
      throw new BadRequestException('Idempotency-Key header is required (8-200 chars of A-Z a-z 0-9 . _ : -)');
    }
    const store = requestContext.get();
    const scope = `${req.method} ${req.originalUrl.split('?')[0]}`;
    const hash = createHash('sha256').update(canonicalJson(req.body ?? null)).digest('hex');

    return from(
      this.db.tx(async (q) => {
        const inserted = await q.query(
          `INSERT INTO idempotency_keys (scope, key, property_id, request_hash, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))
           ON CONFLICT (scope, key) DO NOTHING`,
          [scope, key, store?.property?.id ?? null, hash, store?.user?.id ?? null, this.config.IDEMPOTENCY_TTL_HOURS],
        );

        if (inserted.rowCount === 0) {
          const { rows } = await q.query<StoredKey>(
            'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE scope = $1 AND key = $2',
            [scope, key],
          );
          const prior = rows[0];
          if (!prior || prior.response_status === null) {
            throw new ConflictException('A request with this Idempotency-Key is still in progress');
          }
          if (prior.request_hash !== hash) {
            throw new UnprocessableEntityException('Idempotency-Key was already used with a different request body');
          }
          res.setHeader('Idempotent-Replayed', 'true');
          res.status(prior.response_status);
          return prior.response_body;
        }

        const body = await lastValueFrom(next.handle(), { defaultValue: null });
        await q.query(
          'UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE scope = $1 AND key = $2',
          [scope, key, res.statusCode, JSON.stringify(body ?? null)],
        );
        return body;
      }),
    );
  }
}
