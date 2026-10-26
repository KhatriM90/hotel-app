import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { hasPermission, Permission } from '@hotel/shared';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { requestContext, SYSTEM_SCOPE } from '../db/request-context';
import { AuthService } from './auth.service';
import { IS_PUBLIC, PERMISSION, PROPERTY_PARAM, WORKER_ONLY } from './decorators';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * One global guard so the order of checks is fixed:
 * authenticate → permission (SEC-02/03) → property scope (SEC-06).
 * Everything is server-side; the UI hides nothing that matters.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private meta<T>(key: string, ctx: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    if (this.meta<boolean>(IS_PUBLIC, ctx)) return true;

    const store = requestContext.get();
    if (!store) throw new Error('Request context missing; is RequestContextMiddleware applied?');
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new UnauthorizedException('Missing bearer token');

    if (this.meta<boolean>(WORKER_ONLY, ctx)) {
      if (!timingSafeEqual(sha256(token), sha256(this.config.WORKER_TOKEN))) {
        throw new UnauthorizedException('Invalid worker token');
      }
      store.worker = true;
      store.scope = SYSTEM_SCOPE;
      return true;
    }

    let sub: string;
    try {
      ({ sub } = await this.jwt.verifyAsync<{ sub: string }>(token));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const user = await this.auth.loadActiveUser(sub);
    if (!user) throw new UnauthorizedException('User inactive or not found');
    store.user = user;
    store.scope = user.allProperties ? { all: true, propertyIds: [] } : { all: false, propertyIds: user.propertyIds };

    const permission = this.meta<Permission>(PERMISSION, ctx);
    if (permission && !hasPermission(user.roles, permission)) {
      throw new ForbiddenException(`Missing permission ${permission}`);
    }

    const param = this.meta<string>(PROPERTY_PARAM, ctx);
    if (param) {
      const code = String(req.params[param] ?? '').toUpperCase();
      // RLS hides properties outside the user's scope, so "not found" and
      // "not allowed" look the same to the caller (no data leak).
      const { rows } = await this.db.tx((q) =>
        q.query<{ id: string; code: string; business_date: string }>(
          `SELECT id, code, current_business_date::text AS business_date FROM properties WHERE code = $1 AND is_active`,
          [code],
        ),
      );
      if (!rows[0]) throw new ForbiddenException(`No access to property ${code}`);
      store.property = { id: rows[0].id, code: rows[0].code, businessDate: rows[0].business_date };
      store.scope = { all: false, propertyIds: [rows[0].id] };
    }
    return true;
  }
}
