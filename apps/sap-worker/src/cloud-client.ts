import type { ClaimedJob } from './mapping';

export type JobResult =
  | { outcome: 'posted'; docEntry: number; docNum?: number | null; alreadyExisted?: boolean }
  | { outcome: 'failed'; error: string; retryable: boolean };

export interface CloudQueue {
  claim(limit: number): Promise<ClaimedJob[]>;
  report(jobId: string, result: JobResult): Promise<void>;
}

/** Talks to the cloud API over outbound HTTPS only; HQ needs no inbound ports (brief §12). */
export class HttpCloudQueue implements CloudQueue {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly workerId: string,
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Cloud API ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async claim(limit: number): Promise<ClaimedJob[]> {
    const body = (await this.post('/integration/worker/claim', { workerId: this.workerId, limit })) as { jobs: ClaimedJob[] };
    return body.jobs;
  }

  async report(jobId: string, result: JobResult): Promise<void> {
    await this.post(`/integration/worker/jobs/${jobId}/result`, { workerId: this.workerId, ...result });
  }
}
