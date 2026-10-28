/**
 * API client for the device app. Permission, property and money checks all
 * happen on the server; the device only shows what the server answered and
 * never pretends a payment or room charge succeeded (OPS-04).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable reason, e.g. approval_required, liquor_hours, warning. */
    readonly code?: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The request never reached the server (no network, server down). Safe to retry with the same key. */
export class OfflineError extends Error {}

export interface Me {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
}

export interface Session {
  token: string;
  user: Me;
  propertyCode?: string;
}

const SESSION_KEY = 'yeastay.pwa.session';

export function newKey(prefix = 'pwa'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export class Api {
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly base = '/api',
  ) {}

  get session(): Session | null {
    try {
      return JSON.parse(this.storage.getItem(SESSION_KEY) ?? 'null') as Session | null;
    } catch {
      return null;
    }
  }

  set session(s: Session | null) {
    if (s) this.storage.setItem(SESSION_KEY, JSON.stringify(s));
    else this.storage.removeItem(SESSION_KEY);
  }

  async login(username: string, password: string): Promise<Session> {
    const res = await this.request<{ accessToken: string; user: Me }>('POST', '/auth/login', { username, password }, undefined, false);
    const session = { token: res.accessToken, user: res.user };
    this.session = session;
    return session;
  }

  logout(): void {
    this.session = null;
  }

  async request<T>(method: string, path: string, body?: unknown, key?: string, auth = true): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = this.session?.token;
    if (auth && token) headers.authorization = `Bearer ${token}`;
    if (key) headers['idempotency-key'] = key;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    } catch {
      throw new OfflineError('No connection to the server');
    }
    if (res.status === 401 && auth) this.logout();
    if (res.status === 502 || res.status === 503 || res.status === 504) throw new OfflineError('The server is not reachable');
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown> & { message?: string | string[]; error?: string; issues?: Array<{ path: string; message: string }> };
      const message = b.issues?.length ? b.issues.map((i) => `${i.path}: ${i.message}`).join('; ') : Array.isArray(b.message) ? b.message.join('; ') : b.message;
      throw new ApiError(res.status, message ?? `Request failed (${res.status})`, b.error, b);
    }
    const type = res.headers.get('content-type') ?? '';
    return (type.includes('json') ? await res.json() : await res.text()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown = {}, key = newKey()): Promise<T> {
    return this.request<T>('POST', path, body, key);
  }

  /** HTML for printing (receipts, tickets, Z reports), fetched with the session token. */
  async html(path: string): Promise<string> {
    return this.request<string>('GET', path);
  }
}

export const api = new Api();
