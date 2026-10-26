import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { GROUP_ROLES } from '@hotel/shared';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { AuthUser, SYSTEM_SCOPE } from '../db/request-context';
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from './password';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  is_active: boolean;
  all_properties: boolean;
  roles: string[];
  property_ids: string[];
}

@Injectable()
export class AuthService {
  // Verified against for unknown usernames so they cost the same as a wrong password.
  private readonly dummyHash = hashPassword(randomBytes(24).toString('hex'));

  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  private async findUser(where: 'id' | 'username', value: string): Promise<UserRow | undefined> {
    const column = where === 'id' ? 'u.id = $1::uuid' : 'lower(u.username) = lower($1)';
    const { rows } = await this.db.pool.query<UserRow>(
      `SELECT u.id, u.username, u.display_name, u.password_hash, u.is_active, u.all_properties,
              coalesce(array_agg(DISTINCT r.role_code) FILTER (WHERE r.role_code IS NOT NULL), '{}') AS roles,
              coalesce(array_agg(DISTINCT a.property_id::text) FILTER (WHERE a.property_id IS NOT NULL), '{}') AS property_ids
         FROM users u
         LEFT JOIN user_roles r ON r.user_id = u.id
         LEFT JOIN user_property_access a ON a.user_id = u.id
        WHERE ${column}
        GROUP BY u.id`,
      [value],
    );
    return rows[0];
  }

  private toAuthUser(row: UserRow): AuthUser {
    const isGroup = row.all_properties || row.roles.some((r) => (GROUP_ROLES as readonly string[]).includes(r));
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      roles: row.roles,
      allProperties: isGroup,
      propertyIds: isGroup ? [] : row.property_ids,
    };
  }

  /** Loaded on every request so deactivation and role changes apply immediately (SEC-03). */
  async loadActiveUser(id: string): Promise<AuthUser | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const row = await this.findUser('id', id);
    return row && row.is_active ? this.toAuthUser(row) : undefined;
  }

  async login(username: string, password: string): Promise<{ accessToken: string; user: AuthUser }> {
    const row = await this.findUser('username', username);
    const ok = await verifyPassword(password, row?.password_hash ?? (await this.dummyHash));
    if (!row || !ok || !row.is_active) {
      await this.audit.record(
        { action: 'auth.login_failed', entityType: 'user', entityId: row?.id ?? null, newValues: { username } },
        SYSTEM_SCOPE,
      );
      throw new UnauthorizedException('Invalid username or password');
    }
    await this.db.pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.id]);
    await this.audit.record({ action: 'auth.login', entityType: 'user', entityId: row.id, actorUserId: row.id }, SYSTEM_SCOPE);
    const user = this.toAuthUser(row);
    const accessToken = await this.jwt.signAsync({ sub: row.id, usr: row.username });
    return { accessToken, user };
  }
}
