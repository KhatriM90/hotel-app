import { AddressInfo } from 'node:net';
import { createMockServiceLayer } from '@hotel/sap-sl-mock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CloudQueue, JobResult } from './cloud-client';
import { ClaimedJob, mapJob, MappingError } from './mapping';
import { odataString, ServiceLayerClient } from './service-layer-client';
import { IntegrationWorker, Logger, processJob } from './worker';

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function invoiceJob(ref: string, overrides: Partial<ClaimedJob> = {}, itemCode = 'SODA-300'): ClaimedJob {
  return {
    id: `job-${ref}`,
    eventType: 'AR_INVOICE',
    externalRef: ref,
    attempts: 1,
    property: { code: 'SW', sapBranchId: 2, sapDimension1: 'SW' },
    payload: {
      documentNumber: ref,
      cardCode: 'C-WALKIN',
      docDate: '2026-10-26',
      folioNumber: 'SW-FO-000010',
      lines: [
        { itemCode, quantity: '2', unitPriceInclTax: '150.00', taxCode: 'TBC', warehouseCode: 'SW-BAR1', revenueCentre: 'BAR', dimension2Code: 'SWMBAR' },
      ],
    },
    ...overrides,
  };
}

/** In-memory stand-in for the cloud pull API. */
class FakeQueue implements CloudQueue {
  pending: ClaimedJob[] = [];
  results: Array<{ id: string; result: JobResult }> = [];
  async claim(limit: number) {
    return this.pending.splice(0, limit);
  }
  async report(id: string, result: JobResult) {
    this.results.push({ id, result });
  }
}

describe('SAP integration worker against the Service Layer mock', () => {
  const { server, state } = createMockServiceLayer();
  let base = '';
  let sl: ServiceLayerClient;

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  beforeEach(async () => {
    await fetch(`${base}/mock/reset`, { method: 'POST' });
    sl = new ServiceLayerClient({ baseUrl: `${base}/b1s/v2`, companyDb: 'HOTEL_TEST', username: 'manager', password: 'manager', timeoutMs: 2000 });
  });

  const fault = (mode: string, times = 1) =>
    fetch(`${base}/mock/faults`, { method: 'POST', body: JSON.stringify({ mode, times }) });

  it('posts an A/R invoice with branch, dimensions and traceability UDFs (SAP-04, SAP-13, SAP-15, SAP-20)', async () => {
    const result = await processJob(invoiceJob('SW-INV-000001'), sl);
    expect(result).toMatchObject({ outcome: 'posted', docEntry: 1 });
    const doc = state.documents.Invoices[0];
    expect(doc).toMatchObject({
      CardCode: 'C-WALKIN',
      BPL_IDAssignedToInvoice: 2,
      U_HTL_ExtRef: 'SW-INV-000001',
      U_HTL_Property: 'SW',
      U_HTL_FolioNo: 'SW-FO-000010',
    });
    expect((doc.DocumentLines as Array<Record<string, unknown>>)[0]).toMatchObject({
      ItemCode: 'SODA-300',
      Quantity: 2,
      PriceAfterVAT: 150,
      WarehouseCode: 'SW-BAR1',
      CostingCode: 'SW',
      CostingCode2: 'SWMBAR',
    });
    expect((doc.DocumentLines as Array<Record<string, unknown>>)[0]).not.toHaveProperty('TaxCode');
  });

  it('SAP-AT04: SAP commits but the response is lost; the retry finds the document instead of posting twice', async () => {
    await fault('commit-then-drop');
    const first = await processJob(invoiceJob('SW-INV-000002'), sl);
    expect(first).toMatchObject({ outcome: 'failed', retryable: true });
    expect(state.documents.Invoices).toHaveLength(1);

    const retry = await processJob(invoiceJob('SW-INV-000002'), sl);
    expect(retry).toMatchObject({ outcome: 'posted', docEntry: 1, alreadyExisted: true });
    expect(state.documents.Invoices).toHaveLength(1);
  });

  it('SAP-AT05: an outage is retryable and posts exactly once after recovery', async () => {
    await fault('unavailable', 2);
    const down = await processJob(invoiceJob('SW-INV-000003'), sl);
    expect(down).toMatchObject({ outcome: 'failed', retryable: true });
    const up = await processJob(invoiceJob('SW-INV-000003'), sl);
    expect(up.outcome).toBe('failed'); // second injected 503
    const ok = await processJob(invoiceJob('SW-INV-000003'), sl);
    expect(ok).toMatchObject({ outcome: 'posted' });
    expect(state.documents.Invoices).toHaveLength(1);
  });

  it('SAP-AT06: a rejected document is a permanent failure with SAP’s reason', async () => {
    const result = await processJob(invoiceJob('SW-INV-000004', {}, 'INVALID-ITEM'), sl);
    expect(result).toMatchObject({ outcome: 'failed', retryable: false });
    expect((result as { error: string }).error).toMatch(/-5002.*Invalid item code/);
  });

  it('logs in again when the Service Layer session expires', async () => {
    await processJob(invoiceJob('SW-INV-000005'), sl);
    await fault('expire-sessions');
    const result = await processJob(invoiceJob('SW-INV-000006'), sl);
    expect(result.outcome).toBe('posted');
    expect(state.requests.filter((r) => r.path.endsWith('/Login'))).toHaveLength(2);
  });

  it('refuses to post without a configured SAP branch (SAP-13)', async () => {
    const job = invoiceJob('SW-INV-000007', { property: { code: 'SW', sapBranchId: null, sapDimension1: 'SW' } });
    const result = await processJob(job, sl);
    expect(result).toMatchObject({ outcome: 'failed', retryable: false });
    expect(state.documents.Invoices).toHaveLength(0);
  });

  it('processes a claimed batch in order and reports every result', async () => {
    const queue = new FakeQueue();
    queue.pending = [invoiceJob('SW-INV-000010'), invoiceJob('SW-INV-000011', {}, 'INVALID-X'), invoiceJob('SW-INV-000012')];
    const worker = new IntegrationWorker(queue, sl, { batchSize: 10, idlePollMs: 10 }, silent);
    expect(await worker.runOnce()).toBe(3);
    expect(queue.results.map((r) => r.result.outcome)).toEqual(['posted', 'failed', 'posted']);
    expect(state.documents.Invoices.map((d) => d.U_HTL_ExtRef)).toEqual(['SW-INV-000010', 'SW-INV-000012']);
  });
});

describe('mapping', () => {
  it('rejects unknown event types and non-decimal amounts', () => {
    expect(() => mapJob({ ...invoiceJob('X-1'), eventType: 'NOPE' })).toThrow(MappingError);
    const bad = invoiceJob('X-2');
    (bad.payload.lines as Array<Record<string, string>>)[0].quantity = '1e3';
    expect(() => mapJob(bad)).toThrow(/not a decimal/);
  });

  it('maps a loyalty journal and refuses one without G/L accounts (CLUB07)', () => {
    const job = (account: string): ClaimedJob => ({
      ...invoiceJob('CB-202610-1-SW'),
      eventType: 'LOYALTY_JOURNAL',
      payload: {
        kind: 'CASHBACK', docDate: '2026-10-31', memo: 'Club cashback 2026-10 regular SW',
        lines: [{ account, debit: '750.00', credit: '0.00' }, { account: '210500', debit: '0.00', credit: '750.00' }],
      },
    });
    const mapped = mapJob(job('612000'));
    expect(mapped.entity).toBe('JournalEntries');
    expect(mapped.body.JournalEntryLines).toEqual([
      expect.objectContaining({ AccountCode: '612000', Debit: 750, Credit: 0, BPLID: 2, CostingCode: 'SW' }),
      expect.objectContaining({ AccountCode: '210500', Debit: 0, Credit: 750 }),
    ]);
    expect(() => mapJob(job('UNMAPPED'))).toThrow(/G\/L accounts/);
  });

  it('escapes OData string literals', () => {
    expect(odataString("K1'X")).toBe("'K1''X'");
  });
});
