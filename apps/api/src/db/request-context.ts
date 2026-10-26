import { AsyncLocalStorage } from 'node:async_hooks';

/** Which properties the current request may touch (SEC-06). */
export interface PropertyScope {
  all: boolean;
  propertyIds: string[];
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  allProperties: boolean;
  propertyIds: string[];
}

export interface RequestContext {
  requestId: string;
  ip?: string;
  user?: AuthUser;
  /** Set by the auth guard; narrowed to a single property on property routes. */
  scope?: PropertyScope;
  /** The property resolved from a `:propertyCode` route parameter. */
  property?: { id: string; code: string; businessDate: string };
  /** Set for the HQ integration worker. */
  worker?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
};

export const SYSTEM_SCOPE: PropertyScope = Object.freeze({ all: true, propertyIds: [] }) as PropertyScope;
export const NO_SCOPE: PropertyScope = Object.freeze({ all: false, propertyIds: [] }) as PropertyScope;
