import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { OutboxService } from '../integration/outbox.service';

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly db: DbService,
    private readonly outbox: OutboxService,
  ) {}

  async tick(): Promise<{ releasedClaims: number; purgedKeys: number }> {
    const releasedClaims = await this.outbox.releaseExpiredClaims();
    const purgedKeys = await this.purgeExpiredIdempotencyKeys();
    return { releasedClaims, purgedKeys };
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
