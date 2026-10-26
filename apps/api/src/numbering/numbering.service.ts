import { Global, Injectable, Module } from '@nestjs/common';
import type { DocumentType } from '@hotel/shared';
import { DbService } from '../db/db.service';
import { requestContext } from '../db/request-context';

/**
 * Property-prefixed, gapless document numbers (CFG-04, BIL-09).
 * Call inside the transaction that creates the document; if that transaction
 * rolls back, the number is not consumed.
 */
@Injectable()
export class NumberingService {
  constructor(private readonly db: DbService) {}

  async next(propertyId: string, type: DocumentType): Promise<string> {
    const actor = requestContext.get()?.user?.id ?? null;
    const { rows } = await this.db.query<{ number: string }>(
      'SELECT next_document_number($1, $2, $3) AS number',
      [propertyId, type, actor],
    );
    return rows[0].number;
  }
}

@Global()
@Module({ providers: [NumberingService], exports: [NumberingService] })
export class NumberingModule {}
