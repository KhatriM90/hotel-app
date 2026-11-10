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
  /** Set when the user signed in with a PIN on this registered tablet. */
  viaPin?: boolean;
}

/** A shared tablet registered by a manager for PIN sign-in (Kahama meeting, 9 Nov 2026). */
export interface DeviceInfo {
  id: string;
  name: string;
  propertyCode: string;
  propertyName?: string;
  idleSignoutSeconds: number;
  signoutAfterSend: boolean;
}
export interface RegisteredDevice extends DeviceInfo {
  token: string;
}
export interface DeviceStaff {
  id: string;
  displayName: string;
  roles: string[];
}

const SESSION_KEY = 'yeastay.pwa.session';
const DEVICE_KEY = 'yeastay.pwa.device';

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

  /** The registered tablet this browser is, if any. Its token stays on the tablet across sign-ins. */
  get device(): RegisteredDevice | null {
    try {
      return JSON.parse(this.storage.getItem(DEVICE_KEY) ?? 'null') as RegisteredDevice | null;
    } catch {
      return null;
    }
  }

  set device(d: RegisteredDevice | null) {
    if (d) this.storage.setItem(DEVICE_KEY, JSON.stringify(d));
    else this.storage.removeItem(DEVICE_KEY);
  }

  /** This tablet's current settings and the staff who can sign in on it with a PIN. */
  async deviceStaff(): Promise<{ device: DeviceInfo; staff: DeviceStaff[] }> {
    const d = this.device;
    if (!d) throw new ApiError(401, 'This tablet is not registered', 'device_not_registered');
    const res = await this.request<{ device: DeviceInfo; staff: DeviceStaff[] }>('GET', '/auth/pos-device', undefined, undefined, false, { 'x-pos-device': d.token });
    this.device = { ...d, ...res.device };
    return res;
  }

  async pinLogin(userId: string, pin: string): Promise<Session> {
    const d = this.device;
    if (!d) throw new ApiError(401, 'This tablet is not registered', 'device_not_registered');
    const res = await this.request<{ accessToken: string; user: Me; propertyCode: string; device: DeviceInfo }>(
      'POST', '/auth/pin-login', { userId, pin }, undefined, false, { 'x-pos-device': d.token },
    );
    this.device = { ...d, ...res.device };
    const session = { token: res.accessToken, user: res.user, propertyCode: res.propertyCode, viaPin: true };
    this.session = session;
    return session;
  }

  /**
   * Sends a request with a given user's token: offline actions replay under
   * the waiter who took them, never under whoever is signed in now. A refusal
   * does not sign the current user out.
   */
  requestAs<T>(token: string, method: string, path: string, body?: unknown, key?: string): Promise<T> {
    return this.request<T>(method, path, body, key, false, { authorization: `Bearer ${token}` });
  }

  async request<T>(method: string, path: string, body?: unknown, key?: string, auth = true, extraHeaders: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders };
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
