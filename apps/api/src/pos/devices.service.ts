import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { deviceTokenHash, POS_TABLET_ROLES } from '../auth/auth.service';
import { DbService } from '../db/db.service';
import { conflict } from '../frontoffice/common';
import { actorId } from './common';

export interface DeviceSettingsInput {
  idleSignoutSeconds?: number;
  signoutAfterSend?: boolean;
}

const DEVICE_COLUMNS = `d.id, d.name, d.idle_signout_seconds AS "idleSignoutSeconds", d.signout_after_send AS "signoutAfterSend",
  d.registered_at AS "registeredAt", ru.display_name AS "registeredBy", d.last_seen_at AS "lastSeenAt",
  d.revoked_at AS "revokedAt", vu.display_name AS "revokedBy"`;
const DEVICE_FROM = `pos_devices d JOIN users ru ON ru.id = d.registered_by LEFT JOIN users vu ON vu.id = d.revoked_by`;

/**
 * Shared POS tablets (Kahama meeting, 9 Nov 2026). A manager registers a
 * tablet once; staff then sign in on it by name and PIN, and the tablet signs
 * them out by itself after its idle time (and, if set, after every Send or
 * payment) so the next person never works under someone else's name.
 */
@Injectable()
export class PosDevicesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  list(propertyId: string) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query(`SELECT ${DEVICE_COLUMNS} FROM ${DEVICE_FROM} WHERE d.property_id = $1 ORDER BY d.revoked_at IS NOT NULL, d.name`, [propertyId]);
      return rows;
    });
  }

  /** Returns the device token once; only its hash is stored. */
  register(propertyId: string, input: DeviceSettingsInput & { name: string }) {
    return this.db.tx(async (q) => {
      const token = randomBytes(32).toString('base64url');
      const { rows: [d] } = await q.query<{ id: string }>(
        `INSERT INTO pos_devices (property_id, name, token_hash, idle_signout_seconds, signout_after_send, registered_by)
         VALUES ($1, $2, $3, coalesce($4, 120), coalesce($5, false), $6) RETURNING id`,
        [propertyId, input.name, deviceTokenHash(token), input.idleSignoutSeconds ?? null, input.signoutAfterSend ?? null, actorId()],
      );
      await this.audit.record({ action: 'pos.device_registered', entityType: 'pos_device', entityId: d.id, propertyId, newValues: { name: input.name } });
      const { rows } = await q.query(`SELECT ${DEVICE_COLUMNS} FROM ${DEVICE_FROM} WHERE d.id = $1`, [d.id]);
      return { ...rows[0], token };
    });
  }

  update(propertyId: string, id: string, input: DeviceSettingsInput) {
    return this.db.tx(async (q) => {
      const { rows: [old] } = await q.query<{ idleSignoutSeconds: number; signoutAfterSend: boolean; revoked: boolean }>(
        `SELECT idle_signout_seconds AS "idleSignoutSeconds", signout_after_send AS "signoutAfterSend", revoked_at IS NOT NULL AS revoked
           FROM pos_devices WHERE property_id = $1 AND id = $2 FOR UPDATE`,
        [propertyId, id],
      );
      if (!old) throw new NotFoundException('Tablet not found at this property');
      if (old.revoked) throw conflict('This tablet was unregistered', 'device_revoked');
      await q.query(
        `UPDATE pos_devices SET idle_signout_seconds = coalesce($3, idle_signout_seconds), signout_after_send = coalesce($4, signout_after_send), updated_by = $5
          WHERE property_id = $1 AND id = $2`,
        [propertyId, id, input.idleSignoutSeconds ?? null, input.signoutAfterSend ?? null, actorId()],
      );
      await this.audit.record({ action: 'pos.device_updated', entityType: 'pos_device', entityId: id, propertyId, previousValues: old, newValues: input });
      const { rows } = await q.query(`SELECT ${DEVICE_COLUMNS} FROM ${DEVICE_FROM} WHERE d.id = $1`, [id]);
      return rows[0];
    });
  }

  /** Unregisters a tablet (lost, stolen or replaced); PIN sessions on it end at their next request. */
  revoke(propertyId: string, id: string) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `UPDATE pos_devices SET revoked_at = now(), revoked_by = $3, updated_by = $3
          WHERE property_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING id`,
        [propertyId, id, actorId()],
      );
      if (!rows[0]) throw new NotFoundException('Active tablet not found at this property');
      await this.audit.record({ action: 'pos.device_revoked', entityType: 'pos_device', entityId: id, propertyId });
      const { rows: out } = await q.query(`SELECT ${DEVICE_COLUMNS} FROM ${DEVICE_FROM} WHERE d.id = $1`, [id]);
      return out[0];
    });
  }

  /** Staff of the property who work on tablets, with whether each has a PIN and whether it is locked. */
  async staff(propertyId: string) {
    const { rows } = await this.db.pool.query(
      `SELECT u.id, u.username, u.display_name AS "displayName", array_agg(DISTINCT r.role_code ORDER BY r.role_code) AS roles,
              u.pos_pin_hash IS NOT NULL AS "pinSet", u.pos_pin_set_at AS "pinSetAt",
              CASE WHEN u.pos_pin_locked_until > now() THEN u.pos_pin_locked_until END AS "pinLockedUntil"
         FROM users u JOIN user_roles r ON r.user_id = u.id
        WHERE u.is_active AND r.role_code = ANY($2)
          AND EXISTS (SELECT 1 FROM user_property_access a WHERE a.user_id = u.id AND a.property_id = $1)
        GROUP BY u.id ORDER BY u.display_name`,
      [propertyId, POS_TABLET_ROLES],
    );
    return rows;
  }

  /** A manager clears a user's PIN (forgotten or shared); the user sets a new one after signing in with their password. */
  async clearPin(propertyId: string, userId: string) {
    const { rows } = await this.db.pool.query<{ id: string }>(
      `UPDATE users u SET pos_pin_hash = NULL, pos_pin_set_at = NULL, pos_pin_failures = 0, pos_pin_locked_until = NULL
        WHERE u.id = $2 AND EXISTS (SELECT 1 FROM user_property_access a WHERE a.user_id = u.id AND a.property_id = $1)
        RETURNING u.id`,
      [propertyId, userId],
    );
    if (!rows[0]) throw new NotFoundException('User not found at this property');
    await this.audit.record({ action: 'auth.pin_cleared', entityType: 'user', entityId: userId, propertyId });
    return { id: userId, pinSet: false };
  }
}
