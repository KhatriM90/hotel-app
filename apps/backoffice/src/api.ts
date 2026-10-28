/** Thin client for the YeaStay API. All permission and property checks happen server-side (SEC-03). */

export interface Me {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  allProperties: boolean;
}

export interface Property {
  id: string;
  code: string;
  name: string;
  location: string;
  isHeadOffice: boolean;
  currency: string;
  timezone: string;
  currentBusinessDate: string;
  sapBranchId: number | null;
}

export interface Outlet {
  id: string;
  code: string;
  name: string;
  type: string;
  revenueCentre: string;
  issuingWarehouseCode: string | null;
  sellsAlcohol: boolean;
  isActive: boolean;
  sapOutletName: string | null;
  sapDimension2Code: string | null;
}

export interface OutboxEvent {
  id: string;
  eventType: string;
  externalRef: string;
  status: 'pending' | 'claimed' | 'posted' | 'failed' | 'dead';
  attempts: number;
  sapDocEntry: number | null;
  sapDocNum: number | null;
  lastError: string | null;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable reason from the API, e.g. approval_required, no_availability. */
    readonly code?: string,
  ) {
    super(message);
  }
}

/** A fresh key per user action; resubmitting the same action reuses it (BIL-04, AT-03). */
export function newIdempotencyKey(): string {
  return `bo-${crypto.randomUUID()}`;
}

const TOKEN_KEY = 'yeastay.token';

export class Api {
  // Session storage: the token dies with the tab, which suits shared reception PCs.
  constructor(
    private readonly base = '/api',
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = sessionStorage,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  get token(): string | null {
    return this.storage.getItem(TOKEN_KEY);
  }

  logout(): void {
    this.storage.removeItem(TOKEN_KEY);
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    const res = await this.fetchImpl(`${this.base}${path}`, { ...init, headers });
    if (res.status === 401) this.logout();
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string | string[]; error?: string; issues?: Array<{ path: string; message: string }> };
      const message = body.issues?.length
        ? body.issues.map((i) => `${i.path}: ${i.message}`).join('; ')
        : Array.isArray(body.message)
          ? body.message.join('; ')
          : body.message;
      throw new ApiError(res.status, message ?? `Request failed (${res.status})`, body.error);
    }
    return res;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await (await this.raw(path, init)).json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  /** POST with an Idempotency-Key; pass the same key to retry the same action safely. */
  post<T>(path: string, body: unknown = {}, key = newIdempotencyKey()): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': key } });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  }

  /** Printable documents are served as HTML behind the same bearer token. */
  async html(path: string): Promise<string> {
    return (await this.raw(path)).text();
  }

  async login(username: string, password: string): Promise<Me> {
    const res = await this.request<{ accessToken: string; user: Me }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    this.storage.setItem(TOKEN_KEY, res.accessToken);
    return res.user;
  }

  me() {
    return this.request<Me>('/auth/me');
  }
  properties() {
    return this.request<Property[]>('/properties');
  }
  outlets(code: string) {
    return this.request<Outlet[]>(`/properties/${encodeURIComponent(code)}/outlets`);
  }
  outbox(code: string) {
    return this.request<OutboxEvent[]>(`/properties/${encodeURIComponent(code)}/integration/sap/outbox`);
  }
}

export const api = new Api();
