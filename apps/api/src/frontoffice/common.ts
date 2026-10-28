import { ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { Queryable } from '../db/db.service';
import { RequestContext } from '../db/request-context';

export type CurrentPropertyT = NonNullable<RequestContext['property']>;

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const Amount = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'expected a decimal amount such as "6500.00"');
export const SignedAmount = z.string().regex(/^-?\d{1,16}(\.\d{1,2})?$/, 'expected a decimal amount');
export const Quantity = z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, 'expected a decimal quantity such as "2"');
export const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
export const Reason = z.string().trim().min(3).max(500);

/** Another user's sign-off for an action the caller may not approve alone (SEC-02). */
export const ApprovalInput = z
  .object({
    username: z.string().min(3).max(64),
    password: z.string().min(1).max(256),
  })
  .optional();
export type ApprovalInputT = z.infer<typeof ApprovalInput>;

/**
 * The property's business date read inside the current transaction, with the
 * property row locked when `lock` is set, so a concurrent day close cannot move
 * the date under a check-in, checkout or room move (§9 business date).
 */
export async function businessDate(q: Queryable, propertyId: string, lock = false): Promise<string> {
  const { rows } = await q.query<{ d: string }>(
    `SELECT current_business_date::text AS d FROM properties WHERE id = $1 ${lock ? 'FOR SHARE' : ''}`,
    [propertyId],
  );
  if (!rows[0]) throw new NotFoundException('Property not found');
  return rows[0].d;
}

export function conflict(message: string, error = 'conflict', extra: Record<string, unknown> = {}): ConflictException {
  return new ConflictException({ statusCode: 409, error, message, ...extra });
}

/** Runs `fn` inside a savepoint so a constraint failure can be retried in the same transaction. */
export async function withSavepoint<T>(q: Queryable, name: string, fn: () => Promise<T>): Promise<T> {
  await q.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await q.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await q.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
}

export function isPgError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}
