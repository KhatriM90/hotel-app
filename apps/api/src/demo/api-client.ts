import { randomUUID } from 'node:crypto';

/** An API error with the status and body the server sent back. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; message?: string | string[] } & Record<string, unknown>,
    readonly route: string,
  ) {
    super(`${route} → ${status} ${body.error ?? ''} ${Array.isArray(body.message) ? body.message.join('; ') : body.message ?? ''}`.trim());
  }

  /** The app's machine-readable error code (for example `room_not_ready`). */
  get code(): string | undefined {
    return this.body.error;
  }
}

type Json = Record<string, unknown> | unknown[];

/**
 * A small HTTP client for the demo seed. It signs in as real seeded users and
 * calls the same API routes the back office and tablets use, so every record
 * goes through the app's services: numbering, prices, taxes, approvals,
 * idempotency keys and the §9 guards all apply exactly as at a real desk.
 */
export class DemoApi {
  private readonly tokens = new Map<string, string>();
  private seq = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly password: string,
    private readonly runId = randomUUID().slice(0, 8),
  ) {}

  /** Credentials a manager types on the tablet or desk to approve an action (SEC-02). */
  approval(username: string) {
    return { username, password: this.password };
  }

  async as(username: string): Promise<UserApi> {
    if (!this.tokens.has(username)) {
      const res = await this.raw('POST', '/auth/login', { username, password: this.password });
      this.tokens.set(username, (res as { accessToken: string }).accessToken);
    }
    return new UserApi(this, this.tokens.get(username)!);
  }

  /** A fresh idempotency key per write. A network retry reuses it, so nothing posts twice (§9). */
  nextKey(): string {
    return `demo-${this.runId}-${++this.seq}`;
  }

  async raw(method: string, path: string, body?: unknown, token?: string, key?: string): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    if (key) headers['idempotency-key'] = key;
    const url = `${this.baseUrl}${path}`;
    let res: Response | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        break;
      } catch (err) {
        // Only network failures are retried, and with the same idempotency key.
        if (attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    const parsed = type.includes('json') && text ? JSON.parse(text) : text;
    if (!res.ok) throw new ApiError(res.status, typeof parsed === 'object' && parsed ? parsed : { message: String(parsed) }, `${method} ${path}`);
    return parsed;
  }
}

/** Calls as one signed-in user. Writes always carry an Idempotency-Key. */
export class UserApi {
  constructor(
    private readonly api: DemoApi,
    private readonly token: string,
  ) {}

  get<T = any>(path: string): Promise<T> {
    return this.api.raw('GET', path, undefined, this.token) as Promise<T>;
  }

  post<T = any>(path: string, body: Json = {}): Promise<T> {
    return this.api.raw('POST', path, body, this.token, this.api.nextKey()) as Promise<T>;
  }

  put<T = any>(path: string, body: Json): Promise<T> {
    return this.api.raw('PUT', path, body, this.token, this.api.nextKey()) as Promise<T>;
  }

  patch<T = any>(path: string, body: Json): Promise<T> {
    return this.api.raw('PATCH', path, body, this.token, this.api.nextKey()) as Promise<T>;
  }
}
