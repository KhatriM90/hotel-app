import type { CloudQueue, JobResult } from './cloud-client';
import { ClaimedJob, mapJob, MappingError } from './mapping';
import { SapError, ServiceLayerClient } from './service-layer-client';

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const jsonLogger: Logger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: 'info', msg, ...meta, t: new Date().toISOString() })),
  warn: (msg, meta) => console.warn(JSON.stringify({ level: 'warn', msg, ...meta, t: new Date().toISOString() })),
  error: (msg, meta) => console.error(JSON.stringify({ level: 'error', msg, ...meta, t: new Date().toISOString() })),
};

/**
 * Posts one job exactly once (SAP-11, SAP-20, SAP-AT04):
 * 1. map the event (mapping errors are permanent until corrected and replayed);
 * 2. look up U_HTL_ExtRef in SAP, so a document committed on an earlier attempt
 *    whose response was lost is found instead of created again;
 * 3. create the document only if it does not exist yet.
 */
export async function processJob(job: ClaimedJob, sl: ServiceLayerClient): Promise<JobResult> {
  try {
    const mapped = mapJob(job);
    const existing = await sl.findByExtRef(mapped.entity, job.externalRef);
    if (existing) {
      return { outcome: 'posted', docEntry: existing.DocEntry, docNum: existing.DocNum, alreadyExisted: true };
    }
    const created = await sl.create(mapped.entity, mapped.body);
    return { outcome: 'posted', docEntry: created.DocEntry, docNum: created.DocNum };
  } catch (err) {
    if (err instanceof MappingError || err instanceof SapError) {
      return { outcome: 'failed', error: err.message, retryable: err.retryable };
    }
    return { outcome: 'failed', error: `Unexpected: ${(err as Error).message}`, retryable: true };
  }
}

export class IntegrationWorker {
  private stopped = false;

  constructor(
    private readonly queue: CloudQueue,
    private readonly sl: ServiceLayerClient,
    private readonly opts: { batchSize: number; idlePollMs: number },
    private readonly log: Logger = jsonLogger,
  ) {}

  /** Claims one batch and processes it in order. Returns the number of jobs handled. */
  async runOnce(): Promise<number> {
    const jobs = await this.queue.claim(this.opts.batchSize);
    for (const job of jobs) {
      const result = await processJob(job, this.sl);
      const meta = { jobId: job.id, extRef: job.externalRef, property: job.property.code, attempt: job.attempts };
      if (result.outcome === 'posted') {
        this.log.info(result.alreadyExisted ? 'found existing SAP document' : 'posted to SAP', { ...meta, docEntry: result.docEntry });
      } else {
        (result.retryable ? this.log.warn : this.log.error)('SAP posting failed', { ...meta, error: result.error, retryable: result.retryable });
      }
      // If this report is lost, the claim expires and the next attempt finds the document by U_HTL_ExtRef.
      await this.queue.report(job.id, result);
    }
    return jobs.length;
  }

  async run(): Promise<void> {
    this.log.info('integration worker started');
    let backoff = this.opts.idlePollMs;
    while (!this.stopped) {
      try {
        const handled = await this.runOnce();
        backoff = this.opts.idlePollMs;
        if (handled === 0) await this.sleep(this.opts.idlePollMs);
      } catch (err) {
        // Cloud unreachable (e.g. HQ internet down, SAP-AT12): keep trying, slowly.
        this.log.warn('worker cycle failed', { error: (err as Error).message, retryInMs: backoff });
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
    await this.sl.logout();
    this.log.info('integration worker stopped');
  }

  stop(): void {
    this.stopped = true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      const check = setInterval(() => {
        if (this.stopped) {
          clearTimeout(t);
          clearInterval(check);
          resolve();
        }
      }, 200);
      setTimeout(() => clearInterval(check), ms + 10);
    });
  }
}
