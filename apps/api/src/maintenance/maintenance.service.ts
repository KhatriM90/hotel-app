import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { SYSTEM_SCOPE } from '../db/request-context';
import { OutboxService } from '../integration/outbox.service';

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly db: DbService,
    private readonly outbox: OutboxService,
  ) {}

  async tick(): Promise<{ releasedClaims: number; purgedKeys: number; expiredHolds: number }> {
    const releasedClaims = await this.outbox.releaseExpiredClaims();
    const purgedKeys = await this.purgeExpiredIdempotencyKeys();
    const expiredHolds = await this.releaseExpiredHolds();
    return { releasedClaims, purgedKeys, expiredHolds };
  }

  /**
   * Timed holds that lapsed go back to enquiry and free their rooms (RES-03).
   * Bookings and availability checks also do this on the spot; the job keeps
   * the calendar and dashboard honest when nobody is booking.
   */
  async releaseExpiredHolds(): Promise<number> {
    const { rows } = await this.db.tx(
      (q) => q.query<{ n: number }>('SELECT coalesce(sum(release_expired_holds(id)), 0)::int AS n FROM properties'),
      SYSTEM_SCOPE,
    );
    return rows[0].n;
  }

  /**
   * Expired keys only guard against client retries. Durable duplicate protection
   * for financial records lives on the records themselves (unique external refs).
   */
  async purgeExpiredIdempotencyKeys(): Promise<number> {
    const { rowCount } = await this.db.query(
      'DELETE FROM idempotency_keys WHERE expires_at < now() AND response_status IS NOT NULL',
    );
    return rowCount ?? 0;
  }
}
