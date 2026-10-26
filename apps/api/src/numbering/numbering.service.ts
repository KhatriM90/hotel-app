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

  /**
   * Next eTIMS invoice number. The group has one eTIMS registration, so this is
   * one gapless sequence shared by all three properties (INT-02). Call inside
   * the transaction that records the fiscal submission.
   */
  async nextFiscalInvoiceNo(propertyId: string): Promise<bigint> {
    const actor = requestContext.get()?.user?.id ?? null;
    const { rows } = await this.db.query<{ no: string }>('SELECT next_fiscal_invoice_number($1, $2)::text AS no', [
      propertyId,
      actor,
    ]);
    return BigInt(rows[0].no);
  }
}

@Global()
@Module({ providers: [NumberingService], exports: [NumberingService] })
export class NumberingModule {}
