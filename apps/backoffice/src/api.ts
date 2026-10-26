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
  ) {
    super(message);
  }
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

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    const res = await this.fetchImpl(`${this.base}${path}`, { ...init, headers });
    if (res.status === 401) this.logout();
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new ApiError(res.status, body.message ?? `Request failed (${res.status})`);
    }
    return (await res.json()) as T;
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
