/**
 * Minimal SAP Business One Service Layer client (OData v4, /b1s/v2).
 * Credentials stay on the HQ worker (brief §12 "Keep SAP credentials on the backend").
 * For SAP's self-signed certificate, trust it with NODE_EXTRA_CA_CERTS rather
 * than disabling TLS verification.
 */

export class SapError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly sapCode: string | null,
    /** Network failures, timeouts and 5xx may succeed later; validation errors will not. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SapError';
  }
}

export interface ServiceLayerOptions {
  baseUrl: string;
  companyDb: string;
  username: string;
  password: string;
  timeoutMs: number;
}

export interface SapDocumentRef {
  DocEntry: number;
  DocNum: number | null;
}

/** OData string literal: single quotes doubled. */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export class ServiceLayerClient {
  private cookie: string | null = null;

  constructor(private readonly opts: ServiceLayerOptions) {}

  async login(): Promise<void> {
    const res = await this.raw('POST', 'Login', {
      CompanyDB: this.opts.companyDb,
      UserName: this.opts.username,
      Password: this.opts.password,
    });
    if (!res.ok) throw await this.toError(res);
    const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (!cookies.some((c) => c.startsWith('B1SESSION='))) throw new SapError('Login returned no B1SESSION cookie', res.status, null, true);
    this.cookie = cookies.join('; ');
  }

  async logout(): Promise<void> {
    if (!this.cookie) return;
    await this.raw('POST', 'Logout').catch(() => undefined);
    this.cookie = null;
  }

  /** SAP-20: look up the external reference before every attempt. */
  async findByExtRef(entity: string, extRef: string): Promise<SapDocumentRef | null> {
    const query = `$select=DocEntry,DocNum&$filter=${encodeURIComponent(`U_HTL_ExtRef eq ${odataString(extRef)}`)}`;
    const body = (await this.call('GET', `${entity}?${query}`)) as { value: SapDocumentRef[] };
    if (body.value.length > 1) {
      // Should never happen; surface it for reconciliation rather than pick one.
      throw new SapError(`${body.value.length} ${entity} documents carry U_HTL_ExtRef ${extRef}`, null, null, false);
    }
    return body.value[0] ?? null;
  }

  async create(entity: string, document: Record<string, unknown>): Promise<SapDocumentRef> {
    const created = (await this.call('POST', entity, document)) as SapDocumentRef;
    return { DocEntry: created.DocEntry, DocNum: created.DocNum ?? null };
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.cookie) await this.login();
    let res = await this.raw(method, path, body);
    if (res.status === 401) {
      // Session timed out: log in once more and retry this call.
      await this.login();
      res = await this.raw(method, path, body);
    }
    if (!res.ok) throw await this.toError(res);
    return res.status === 204 ? null : res.json();
  }

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(`${this.opts.baseUrl}/${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      // Connection reset/timeout: the outcome is unknown, so the next attempt must look up first.
      throw new SapError(`Service Layer unreachable: ${(err as Error).message}`, null, null, true);
    }
  }

  private async toError(res: Response): Promise<SapError> {
    let code: string | null = null;
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: { code?: string | number; message?: string | { value?: string } } };
      if (body.error) {
        code = body.error.code != null ? String(body.error.code) : null;
        message = typeof body.error.message === 'string' ? body.error.message : (body.error.message?.value ?? message);
      }
    } catch {
      /* non-JSON error body */
    }
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    return new SapError(`SAP ${res.status}${code ? ` [${code}]` : ''}: ${message}`, res.status, code, retryable);
  }
}
