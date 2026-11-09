import { BadRequestException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { GROUP_ROLES } from '@hotel/shared';

/** Roles that work on a shared POS tablet (waiter/bar POS and the kitchen/bar ticket screen). */
export const POS_TABLET_ROLES = ['manager', 'cashier', 'waiter', 'bartender', 'kitchen'];
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { AuthUser, SYSTEM_SCOPE } from '../db/request-context';
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, hashPin, pinProblem, verifyPassword } from './password';

/** Wrong PINs in a row before the user's PIN is locked, and for how long. */
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MINUTES = 5;

export interface PosDevice {
  id: string;
  name: string;
  propertyId: string;
  propertyCode: string;
  propertyName: string;
  idleSignoutSeconds: number;
  signoutAfterSend: boolean;
}

export function deviceTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  pos_pin_hash: string | null;
  pos_pin_failures: number;
  pin_locked_seconds: number | null;
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
              u.pos_pin_hash, u.pos_pin_failures,
              CASE WHEN u.pos_pin_locked_until > now() THEN ceil(extract(epoch FROM u.pos_pin_locked_until - now()))::int END AS pin_locked_seconds,
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

  /**
   * Checks another user's credentials for an approval (SEC-02) without issuing a
   * token. Failures are audited like failed logins.
   */
  async verifyCredentials(username: string, password: string): Promise<AuthUser | undefined> {
    const row = await this.findUser('username', username);
    const ok = await verifyPassword(password, row?.password_hash ?? (await this.dummyHash));
    if (!row || !ok || !row.is_active) {
      await this.audit.record(
        { action: 'auth.approval_failed', entityType: 'user', entityId: row?.id ?? null, newValues: { username } },
        SYSTEM_SCOPE,
      );
      return undefined;
    }
    return this.toAuthUser(row);
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

  // -------------------------------------------------------------------------
  // Shared POS tablets: PIN sign-in (Kahama meeting, 9 Nov 2026; SEC-03)
  // -------------------------------------------------------------------------

  /** The active registered tablet for a device token, or undefined. */
  async deviceByToken(token: string | undefined): Promise<PosDevice | undefined> {
    if (!token || token.length < 32 || token.length > 128) return undefined;
    const { rows } = await this.db.tx(
      (q) =>
        q.query<PosDevice>(
          `UPDATE pos_devices d SET last_seen_at = now()
             FROM properties p
            WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND p.id = d.property_id AND p.is_active
           RETURNING d.id, d.name, d.property_id AS "propertyId", p.code AS "propertyCode", p.name AS "propertyName",
                     d.idle_signout_seconds AS "idleSignoutSeconds", d.signout_after_send AS "signoutAfterSend"`,
          [deviceTokenHash(token)],
        ),
      SYSTEM_SCOPE,
    );
    return rows[0];
  }

  /** The active registered tablet by id (checked on every request a PIN session makes). */
  async deviceById(id: string): Promise<{ id: string; propertyCode: string } | undefined> {
    const { rows } = await this.db.tx(
      (q) =>
        q.query<{ id: string; propertyCode: string }>(
          `SELECT d.id, p.code AS "propertyCode" FROM pos_devices d JOIN properties p ON p.id = d.property_id
            WHERE d.id = $1 AND d.revoked_at IS NULL AND p.is_active`,
          [id],
        ),
      SYSTEM_SCOPE,
    );
    return rows[0];
  }

  /** Staff who can sign in on this tablet with a PIN: active, with access to its property, a POS role and a PIN set. */
  async deviceStaff(device: PosDevice): Promise<Array<{ id: string; displayName: string; roles: string[] }>> {
    const { rows } = await this.db.pool.query<{ id: string; displayName: string; roles: string[] }>(
      `SELECT u.id, u.display_name AS "displayName", array_agg(DISTINCT r.role_code ORDER BY r.role_code) AS roles
         FROM users u JOIN user_roles r ON r.user_id = u.id
        WHERE u.is_active AND u.pos_pin_hash IS NOT NULL
          AND EXISTS (SELECT 1 FROM user_property_access a WHERE a.user_id = u.id AND a.property_id = $1)
          AND r.role_code = ANY($2)
        GROUP BY u.id ORDER BY u.display_name`,
      [device.propertyId, POS_TABLET_ROLES],
    );
    return rows;
  }

  async pinLogin(deviceToken: string | undefined, userId: string, pin: string) {
    const device = await this.deviceByToken(deviceToken);
    if (!device) {
      throw new UnauthorizedException({ statusCode: 401, error: 'device_not_registered', message: 'This tablet is not registered for PIN sign-in. Sign in with your password.' });
    }
    const row = /^[0-9a-f-]{36}$/i.test(userId) ? await this.findUser('id', userId) : undefined;
    const allowed = row && row.is_active && row.pos_pin_hash && (row.property_ids.includes(device.propertyId));
    if (!row || !allowed) {
      await verifyPassword(pin, await this.dummyHash);
      throw new UnauthorizedException({ statusCode: 401, error: 'pin_invalid', message: 'Wrong PIN' });
    }
    if (row.pin_locked_seconds) {
      throw new HttpException(
        { statusCode: 423, error: 'pin_locked', message: `Too many wrong PINs. Try again in ${Math.ceil(row.pin_locked_seconds / 60)} min, or sign in with your password.` },
        HttpStatus.LOCKED,
      );
    }
    if (!(await verifyPassword(pin, row.pos_pin_hash!))) {
      const { rows: [f] } = await this.db.pool.query<{ locked: boolean }>(
        `UPDATE users SET pos_pin_failures = CASE WHEN pos_pin_failures + 1 >= $2 THEN 0 ELSE pos_pin_failures + 1 END,
                          pos_pin_locked_until = CASE WHEN pos_pin_failures + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE pos_pin_locked_until END
          WHERE id = $1 RETURNING pos_pin_locked_until > now() AS locked`,
        [row.id, PIN_MAX_FAILURES, PIN_LOCK_MINUTES],
      );
      await this.audit.record(
        { action: 'auth.pin_failed', entityType: 'user', entityId: row.id, propertyId: device.propertyId, newValues: { device: device.name, locked: !!f?.locked } },
        SYSTEM_SCOPE,
      );
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'pin_invalid',
        message: f?.locked ? `Wrong PIN. Your PIN is locked for ${PIN_LOCK_MINUTES} min; sign in with your password or ask a manager.` : 'Wrong PIN',
      });
    }
    await this.db.pool.query('UPDATE users SET last_login_at = now(), pos_pin_failures = 0, pos_pin_locked_until = NULL WHERE id = $1', [row.id]);
    await this.audit.record(
      { action: 'auth.pin_login', entityType: 'user', entityId: row.id, actorUserId: row.id, propertyId: device.propertyId, newValues: { device: device.name, deviceId: device.id } },
      SYSTEM_SCOPE,
    );
    // The token names the tablet: revoking the tablet ends its sessions, and it only works at the tablet's property.
    const accessToken = await this.jwt.signAsync({ sub: row.id, usr: row.username, dev: device.id });
    return { accessToken, user: this.toAuthUser(row), propertyCode: device.propertyCode, device: this.deviceView(device) };
  }

  deviceView(d: PosDevice) {
    return { id: d.id, name: d.name, propertyCode: d.propertyCode, propertyName: d.propertyName, idleSignoutSeconds: d.idleSignoutSeconds, signoutAfterSend: d.signoutAfterSend };
  }

  /** A user sets or changes their own POS PIN, confirming with their password. */
  async setOwnPin(userId: string, currentPassword: string, pin: string): Promise<{ pinSet: true }> {
    const row = await this.findUser('id', userId);
    if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
      throw new UnauthorizedException({ statusCode: 401, error: 'password_invalid', message: 'Your password is wrong' });
    }
    const problem = pinProblem(pin);
    if (problem) throw new BadRequestException({ statusCode: 400, error: 'pin_weak', message: problem });
    await this.db.pool.query(
      'UPDATE users SET pos_pin_hash = $2, pos_pin_set_at = now(), pos_pin_failures = 0, pos_pin_locked_until = NULL WHERE id = $1',
      [row.id, await hashPin(pin)],
    );
    await this.audit.record({ action: 'auth.pin_set', entityType: 'user', entityId: row.id }, SYSTEM_SCOPE);
    return { pinSet: true };
  }
}
