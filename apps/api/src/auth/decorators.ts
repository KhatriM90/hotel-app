import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Permission } from '@hotel/shared';
import { requestContext } from '../db/request-context';

export const IS_PUBLIC = 'auth:public';
export const PERMISSION = 'auth:permission';
export const PROPERTY_PARAM = 'auth:propertyParam';
export const WORKER_ONLY = 'auth:worker';

/** No authentication required. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Caller must hold a role granting this permission (SEC-02/SEC-03). */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION, permission);

/**
 * The route acts on the property named by a route parameter (default `propertyCode`).
 * The caller must have access to it, and the request's database scope is narrowed
 * to that one property (SEC-06, AT-18).
 */
export const PropertyScoped = (param = 'propertyCode') => SetMetadata(PROPERTY_PARAM, param);

/** Only the HQ integration worker (bearer WORKER_TOKEN) may call this route. */
export const WorkerOnly = () => SetMetadata(WORKER_ONLY, true);

export const CurrentUser = createParamDecorator((_: unknown, _ctx: ExecutionContext) => requestContext.get()?.user);
export const CurrentProperty = createParamDecorator((_: unknown, _ctx: ExecutionContext) => requestContext.get()?.property);
