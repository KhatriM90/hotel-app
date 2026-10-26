import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentProperty, PropertyScoped, RequirePermission, WorkerOnly } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { RequestContext } from '../db/request-context';
import { Idempotent } from '../idempotency/idempotency';
import { NumberingService } from '../numbering/numbering.service';
import { JobResult, OutboxService, OutboxStatus } from './outbox.service';

const ClaimSchema = z.object({
  workerId: z.string().regex(/^[A-Za-z0-9._-]{3,64}$/),
  limit: z.number().int().min(1).max(50).default(10),
});

const ResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    workerId: z.string().min(3),
    outcome: z.literal('posted'),
    docEntry: z.number().int().positive(),
    docNum: z.number().int().positive().nullish(),
    alreadyExisted: z.boolean().optional(),
  }),
  z.object({
    workerId: z.string().min(3),
    outcome: z.literal('failed'),
    error: z.string().min(1),
    retryable: z.boolean(),
  }),
]);

/** Pull API for the HQ integration worker (outbound HTTPS from HQ only, brief §12). */
@Controller('integration/worker')
@WorkerOnly()
export class WorkerController {
  constructor(
    private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('claim')
  @HttpCode(200)
  async claim(@Body(new ZodPipe(ClaimSchema)) body: z.infer<typeof ClaimSchema>) {
    const jobs = await this.outbox.claim(body.workerId, body.limit, this.config.WORKER_CLAIM_LEASE_SECONDS);
    return { jobs, leaseSeconds: this.config.WORKER_CLAIM_LEASE_SECONDS };
  }

  @Post('jobs/:id/result')
  @HttpCode(200)
  result(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ResultSchema)) body: z.infer<typeof ResultSchema>) {
    const { workerId, ...rest } = body;
    return this.outbox.complete(id, workerId, rest as JobResult);
  }
}

const ReplaySchema = z.object({ reason: z.string().min(5).max(500) });
const StatusSchema = z.enum(['pending', 'claimed', 'posted', 'failed', 'dead']).optional();
type CurrentPropertyT = NonNullable<RequestContext['property']>;

/** Property-level integration status and staff reconciliation tools (OPS-02). */
@Controller('properties/:propertyCode/integration/sap')
@PropertyScoped()
export class SapIntegrationController {
  constructor(
    private readonly outbox: OutboxService,
    private readonly numbering: NumberingService,
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('outbox')
  @RequirePermission('integration.read')
  list(@CurrentProperty() property: CurrentPropertyT, @Query('status', new ZodPipe(StatusSchema)) status?: OutboxStatus) {
    return this.outbox.list(property.id, status);
  }

  @Post('outbox/:id/replay')
  @HttpCode(200)
  @RequirePermission('integration.manage')
  replay(
    @CurrentProperty() property: CurrentPropertyT,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReplaySchema)) body: z.infer<typeof ReplaySchema>,
  ) {
    return this.outbox.replay(property.id, id, body.reason);
  }

  /**
   * Development only (ENABLE_DEV_ENDPOINTS=true): allocates an invoice number and
   * queues a sample A/R invoice in one transaction, to exercise numbering,
   * idempotency, the outbox, the HQ worker and the Service Layer mock end to end.
   */
  @Post('sample-invoice')
  @RequirePermission('integration.manage')
  @Idempotent()
  async sampleInvoice(@CurrentProperty() property: CurrentPropertyT) {
    if (!this.config.ENABLE_DEV_ENDPOINTS) throw new NotFoundException();
    return this.db.tx(async (q) => {
      const { rows: bars } = await q.query<{ dim2: string | null; wh: string | null }>(
        `SELECT sap_dimension2_code AS dim2, issuing_warehouse_code AS wh FROM outlets
          WHERE property_id = $1 AND type = 'bar' AND is_active ORDER BY code LIMIT 1`,
        [property.id],
      );
      const documentNumber = await this.numbering.next(property.id, 'INVOICE');
      return this.outbox.enqueue({
        propertyId: property.id,
        eventType: 'AR_INVOICE',
        externalRef: documentNumber,
        payload: {
          documentNumber,
          cardCode: 'C-WALKIN',
          docDate: property.businessDate,
          currency: 'KES',
          folioNumber: null,
          lines: [
            {
              itemCode: 'SAMPLE-SODA-300',
              description: 'Sample soda 300ml (test data)',
              quantity: '2',
              unitPriceInclTax: '150.00',
              taxCode: 'O1', // Output VAT 16% (SAP tax group)
              revenueCentre: 'BAR',
              dimension2Code: bars[0]?.dim2 ?? null,
              warehouseCode: bars[0]?.wh ?? undefined,
            },
          ],
        },
      });
    });
  }
}
