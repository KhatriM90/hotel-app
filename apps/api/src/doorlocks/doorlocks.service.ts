import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { keyCardParams, KeyCardParams, LOCK_ADDRESS_PATTERN, nextCardNo, nextRoomPass } from '@hotel/shared';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { requestContext } from '../db/request-context';
import { conflict } from '../frontoffice/common';

/** A job nobody picked up in this time fails, so reception is never left waiting on a dead PC. */
export const PICKUP_TIMEOUT_SECONDS = 120;
/** How long the bridge has to report after claiming a job. */
export const ENCODE_LEASE_SECONDS = 60;
/** The bridge polls every second or two; after this long without a poll it shows as offline. */
export const BRIDGE_ONLINE_SECONDS = 30;
/** Cards start a few minutes early so a lock clock running slightly fast still opens. */
const VALID_FROM_SLACK_MS = 5 * 60 * 1000;

export interface DoorLockSettings {
  vendor: 'TEMIC20';
  enabled: boolean;
  systemCode: string | null;
  hotelCode: string | null;
  cardPass: string;
  comPort: number;
  cardGraceMinutes: number;
  /** Number the next card gets; start it above the numbers the supplier's software has used. */
  nextCardNo: number;
  bridge: {
    paired: boolean;
    pairedAt: string | null;
    lastSeenAt: string | null;
    online: boolean;
    bridgeId: string | null;
    version: string | null;
    mode: 'dll' | 'mock' | null;
  };
}

export interface KeyCardRow {
  id: string;
  kind: 'new' | 'duplicate' | 'read';
  status: 'pending' | 'encoding' | 'done' | 'failed' | 'cancelled';
  stayId: string | null;
  stayNumber: string | null;
  roomId: string | null;
  roomNumber: string | null;
  cardNo: number | null;
  validFrom: string | null;
  validTo: string | null;
  errorCode: number | null;
  error: string | null;
  readCardNo: number | null;
  requestedBy: string | null;
  requestedAt: string;
  finishedAt: string | null;
  /** Derived for done guest cards: still opens the door, or why not. */
  state?: 'active' | 'replaced' | 'moved' | 'checked_out' | 'expired';
}

export type BridgeResult =
  | { outcome: 'done'; cardNo?: number | null; systemCode?: string | null }
  | { outcome: 'failed'; errorCode?: number | null; error: string };

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

const CARD_COLUMNS = `
  k.id, k.kind, k.status, k.stay_id AS "stayId", s.number AS "stayNumber", k.room_id AS "roomId", r.number AS "roomNumber",
  k.card_no AS "cardNo", k.valid_from AS "validFrom", k.valid_to AS "validTo", k.error_code AS "errorCode", k.error,
  k.read_card_no AS "readCardNo", u.display_name AS "requestedBy", k.requested_at AS "requestedAt", k.finished_at AS "finishedAt"`;
const CARD_JOINS = `
  FROM key_cards k LEFT JOIN stays s ON s.id = k.stay_id LEFT JOIN rooms r ON r.id = k.room_id LEFT JOIN users u ON u.id = k.requested_by`;

/**
 * Guest key cards for TEMIC20 locks (INT-09, FD-03, FD-05). Reception asks for
 * a card here; the property's bridge on the encoder PC claims the job, calls
 * HUNERF.dll KeyCard with the parameters computed here and reports back.
 *
 * The locks are offline: a card stops working when it expires, or when a newer
 * "new" card for the same room is first used at that door. Nothing can cancel
 * a card remotely, which is why the stay screen says so after a move or an
 * early checkout.
 */
@Injectable()
export class DoorLocksService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private actor(): string | null {
    return requestContext.get()?.user?.id ?? null;
  }

  private async settingsRow(q: Queryable, propertyId: string, lock = false) {
    await q.query('INSERT INTO door_lock_settings (property_id) VALUES ($1) ON CONFLICT DO NOTHING', [propertyId]);
    const { rows } = await q.query<{
      vendor: 'TEMIC20'; enabled: boolean; system_code: string | null; hotel_code: string | null; card_pass: string; com_port: number;
      card_grace_minutes: number; next_card_no: number; bridge_token_hash: string | null; bridge_paired_at: string | null;
      bridge_last_seen_at: string | null; bridge_id: string | null; bridge_version: string | null; bridge_mode: 'dll' | 'mock' | null; online: boolean;
    }>(
      `SELECT *, coalesce(bridge_last_seen_at > now() - make_interval(secs => $2), false) AS online
         FROM door_lock_settings WHERE property_id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [propertyId, BRIDGE_ONLINE_SECONDS],
    );
    return rows[0];
  }

  private view(r: Awaited<ReturnType<DoorLocksService['settingsRow']>>, withCodes: boolean): DoorLockSettings {
    return {
      vendor: r.vendor,
      enabled: r.enabled,
      systemCode: withCodes ? r.system_code : r.system_code ? '••••' : null,
      hotelCode: withCodes ? r.hotel_code : r.hotel_code ? '••••' : null,
      cardPass: withCodes ? r.card_pass : '••••',
      comPort: r.com_port,
      cardGraceMinutes: r.card_grace_minutes,
      nextCardNo: r.next_card_no,
      bridge: {
        paired: !!r.bridge_token_hash,
        pairedAt: r.bridge_paired_at,
        lastSeenAt: r.bridge_last_seen_at,
        online: r.online,
        bridgeId: r.bridge_id,
        version: r.bridge_version,
        mode: r.bridge_mode,
      },
    };
  }

  async settings(propertyId: string, withCodes: boolean): Promise<DoorLockSettings> {
    return this.db.tx(async (q) => this.view(await this.settingsRow(q, propertyId), withCodes));
  }

  async updateSettings(
    propertyId: string,
    input: { enabled?: boolean; systemCode?: string | null; hotelCode?: string | null; cardPass?: string; comPort?: number; cardGraceMinutes?: number; nextCardNo?: number },
  ): Promise<DoorLockSettings> {
    return this.db.tx(async (q) => {
      const before = await this.settingsRow(q, propertyId, true);
      const next = {
        enabled: input.enabled ?? before.enabled,
        system_code: input.systemCode === undefined ? before.system_code : input.systemCode,
        hotel_code: input.hotelCode === undefined ? before.hotel_code : input.hotelCode,
        card_pass: input.cardPass ?? before.card_pass,
        com_port: input.comPort ?? before.com_port,
        card_grace_minutes: input.cardGraceMinutes ?? before.card_grace_minutes,
        next_card_no: input.nextCardNo ?? before.next_card_no,
      };
      // Card numbers only move forward, so "whose card is this?" never matches two cards.
      if (next.next_card_no < before.next_card_no) {
        throw new BadRequestException(`Card numbers only go up; the next card is already ${before.next_card_no}`);
      }
      if (next.enabled && (!next.system_code || !next.hotel_code)) {
        throw new BadRequestException('Enter the SystemCode and HotelCode from the lock supplier before switching key cards on');
      }
      await q.query(
        `UPDATE door_lock_settings SET enabled = $2, system_code = $3, hotel_code = $4, card_pass = $5, com_port = $6,
                card_grace_minutes = $7, next_card_no = $9, updated_by = $8 WHERE property_id = $1`,
        [propertyId, next.enabled, next.system_code, next.hotel_code, next.card_pass, next.com_port, next.card_grace_minutes, this.actor(), next.next_card_no],
      );
      // Codes are secrets of the lock system: the audit trail records that they changed, not their values.
      await this.audit.record({
        action: 'doorlock.settings', entityType: 'door_lock_settings', entityId: propertyId, propertyId,
        previousValues: { enabled: before.enabled, comPort: before.com_port, cardGraceMinutes: before.card_grace_minutes, nextCardNo: before.next_card_no },
        newValues: {
          enabled: next.enabled, comPort: next.com_port, cardGraceMinutes: next.card_grace_minutes, nextCardNo: next.next_card_no,
          systemCodeChanged: next.system_code !== before.system_code, hotelCodeChanged: next.hotel_code !== before.hotel_code,
          cardPassChanged: next.card_pass !== before.card_pass,
        },
      });
      return this.view(await this.settingsRow(q, propertyId), true);
    });
  }

  /** Pairs the encoder PC: a new token replaces any earlier one, which stops working at once. Shown once. */
  async pairBridge(propertyId: string): Promise<{ token: string; settings: DoorLockSettings }> {
    return this.db.tx(async (q) => {
      await this.settingsRow(q, propertyId, true);
      const token = randomBytes(32).toString('base64url');
      await q.query(
        `UPDATE door_lock_settings SET bridge_token_hash = $2, bridge_paired_at = now(), bridge_paired_by = $3,
                bridge_last_seen_at = NULL, bridge_id = NULL, bridge_version = NULL, bridge_mode = NULL WHERE property_id = $1`,
        [propertyId, sha256(token), this.actor()],
      );
      await this.audit.record({ action: 'doorlock.bridge_paired', entityType: 'door_lock_settings', entityId: propertyId, propertyId });
      return { token, settings: this.view(await this.settingsRow(q, propertyId), true) };
    });
  }

  async unpairBridge(propertyId: string): Promise<DoorLockSettings> {
    return this.db.tx(async (q) => {
      await this.settingsRow(q, propertyId, true);
      await q.query(
        `UPDATE door_lock_settings SET bridge_token_hash = NULL, bridge_last_seen_at = NULL, bridge_id = NULL, bridge_version = NULL, bridge_mode = NULL
          WHERE property_id = $1`,
        [propertyId],
      );
      await this.audit.record({ action: 'doorlock.bridge_unpaired', entityType: 'door_lock_settings', entityId: propertyId, propertyId });
      return this.view(await this.settingsRow(q, propertyId), true);
    });
  }

  // -------------------------------------------------------------------------
  // Room lock addresses
  // -------------------------------------------------------------------------

  async rooms(propertyId: string) {
    const { rows } = await this.db.query(
      `SELECT r.id, r.number, r.floor, r.building, r.lock_address AS "lockAddress", st.room_pass IS NOT NULL AS "hasGuestCard"
         FROM rooms r LEFT JOIN room_lock_state st ON st.room_id = r.id
        WHERE r.property_id = $1 ORDER BY r.number`,
      [propertyId],
    );
    return rows;
  }

  /** Sets lock addresses by room number; null clears one. All or nothing. */
  async setRoomAddresses(propertyId: string, rooms: Array<{ number: string; lockAddress: string | null }>) {
    return this.db.tx(async (q) => {
      const seen = new Set<string>();
      for (const r of rooms) {
        if (r.lockAddress && !LOCK_ADDRESS_PATTERN.test(r.lockAddress)) {
          throw new BadRequestException(`Room ${r.number}: a lock address is 11 digits starting 01, e.g. 01010200600`);
        }
        if (r.lockAddress && seen.has(r.lockAddress)) throw new BadRequestException(`Lock address ${r.lockAddress} is given to two rooms`);
        if (r.lockAddress) seen.add(r.lockAddress);
      }
      // Clear first so two rooms can swap addresses in one save.
      const numbers = rooms.map((r) => r.number.toUpperCase());
      const { rows: found } = await q.query<{ number: string }>(
        `SELECT number FROM rooms WHERE property_id = $1 AND number = ANY($2::text[])`,
        [propertyId, numbers],
      );
      const missing = numbers.filter((n) => !found.some((f) => f.number === n));
      if (missing.length) throw new BadRequestException(`No room ${missing.join(', ')} at this property`);
      await q.query(`UPDATE rooms SET lock_address = NULL WHERE property_id = $1 AND number = ANY($2::text[])`, [propertyId, numbers]);
      for (const r of rooms) {
        if (!r.lockAddress) continue;
        const { rows: clash } = await q.query<{ number: string }>(
          `SELECT number FROM rooms WHERE property_id = $1 AND lock_address = $2`,
          [propertyId, r.lockAddress],
        );
        if (clash[0]) throw conflict(`Lock address ${r.lockAddress} already belongs to room ${clash[0].number}`, 'lock_address_taken');
        await q.query(`UPDATE rooms SET lock_address = $3 WHERE property_id = $1 AND number = $2`, [propertyId, r.number.toUpperCase(), r.lockAddress]);
      }
      await this.audit.record({
        action: 'doorlock.room_addresses', entityType: 'property', entityId: propertyId, propertyId,
        newValues: { rooms: rooms.map((r) => ({ number: r.number.toUpperCase(), lockAddress: r.lockAddress })) },
      });
      return this.rooms(propertyId);
    });
  }

  // -------------------------------------------------------------------------
  // Guest cards (reception)
  // -------------------------------------------------------------------------

  /** Pending jobs nobody picked up, and claims the bridge never answered, end as failed. */
  private async expireStale(q: Queryable, propertyId: string): Promise<void> {
    const { rows } = await q.query<{ id: string }>(
      `UPDATE key_cards SET status = 'failed', finished_at = now(),
              error = CASE status WHEN 'pending' THEN 'The encoder PC did not pick this up. Check that the YeaStay lock bridge is running, then try again.'
                                  ELSE 'No answer from the encoder PC after it started. Read the card to check it before trying again.' END
        WHERE property_id = $1
          AND ((status = 'pending' AND requested_at < now() - make_interval(secs => $2))
            OR (status = 'encoding' AND claim_expires_at < now()))
        RETURNING id`,
      [propertyId, PICKUP_TIMEOUT_SECONDS],
    );
    for (const r of rows) await this.cancelChildren(q, r.id);
  }

  private async cancelChildren(q: Queryable, parentId: string): Promise<void> {
    await q.query(
      `UPDATE key_cards SET status = 'cancelled', finished_at = now(), error = 'Not made: the new card before it failed'
        WHERE parent_id = $1 AND status = 'pending'`,
      [parentId],
    );
  }

  private async stayCards(q: Queryable, propertyId: string, stayId: string): Promise<KeyCardRow[]> {
    const { rows } = await q.query<KeyCardRow & { stayStatus: string; currentRoomId: string | null; replaced: boolean }>(
      `SELECT ${CARD_COLUMNS}, s.status AS "stayStatus", s.room_id AS "currentRoomId",
              EXISTS (SELECT 1 FROM key_cards n WHERE n.room_id = k.room_id AND n.kind = 'new' AND n.status = 'done'
                         AND n.requested_at > k.requested_at AND n.stay_id IS DISTINCT FROM k.stay_id) AS replaced
         ${CARD_JOINS}
        WHERE k.property_id = $1 AND k.stay_id = $2
        ORDER BY k.requested_at DESC`,
      [propertyId, stayId],
    );
    return rows.map(({ stayStatus, currentRoomId, replaced, ...card }) => {
      if (card.status !== 'done' || card.kind === 'read') return card;
      let state: KeyCardRow['state'] = 'active';
      if (card.validTo && new Date(card.validTo) <= new Date()) state = 'expired';
      else if (replaced) state = 'replaced';
      else if (stayStatus === 'checked_out') state = 'checked_out';
      else if (card.roomId !== currentRoomId) state = 'moved';
      return { ...card, state };
    });
  }

  /** The stay's cards with what reception needs to see: encoder status, and whether the cards cover the stay. */
  async forStay(propertyId: string, stayId: string) {
    return this.db.tx(async (q) => {
      await this.expireStale(q, propertyId);
      const settings = this.view(await this.settingsRow(q, propertyId), false);
      const { rows } = await q.query<{ status: string; room_id: string | null; room_number: string | null; lock_address: string | null; ends: Date }>(
        `SELECT s.status, s.room_id, r.number AS room_number, r.lock_address, ${stayEndSql('s', 'res')} AS ends
           FROM stays s JOIN reservations res ON res.id = s.reservation_id LEFT JOIN rooms r ON r.id = s.room_id
          WHERE s.property_id = $1 AND s.id = $2`,
        [propertyId, stayId],
      );
      if (!rows[0]) throw new NotFoundException('Stay not found at this property');
      const stay = rows[0];
      const cards = await this.stayCards(q, propertyId, stayId);
      const { rows: lockState } = await q.query<{ stay_id: string | null }>(
        `SELECT k.stay_id FROM room_lock_state st JOIN key_cards k ON k.id = st.key_card_id WHERE st.room_id = $1`,
        [stay.room_id],
      );
      const activeHere = cards.filter((c) => c.state === 'active' && c.roomId === stay.room_id);
      const warnings: string[] = [];
      if (stay.status === 'checked_in' && activeHere.length && activeHere.every((c) => new Date(c.validTo!) < new Date(stay.ends))) {
        warnings.push('The cards stop before the new departure time. Make a new card to cover the extension.');
      }
      if (cards.some((c) => c.state === 'moved')) {
        warnings.push('Cards for the previous room keep opening it until they expire or the next guest’s new card is used there. Collect them if you can.');
      }
      if (stay.status === 'checked_out' && cards.some((c) => c.state === 'checked_out')) {
        warnings.push('Cards from this stay open the room until they expire or the next guest’s new card is used there.');
      }
      const ready = settings.enabled && !!stay.lock_address && stay.status === 'checked_in';
      return {
        enabled: settings.enabled,
        encoderOnline: settings.bridge.online,
        roomNumber: stay.room_number,
        lockAddress: stay.lock_address,
        canIssueNew: ready,
        // A duplicate copies the room password of this stay's own new card for this room.
        canIssueDuplicate: ready && lockState[0]?.stay_id === stayId,
        blockedReason: !settings.enabled
          ? 'Key cards are switched off for this property (Door locks settings).'
          : stay.status !== 'checked_in'
            ? 'Key cards are made for checked-in guests.'
            : !stay.lock_address
              ? `Room ${stay.room_number ?? ''} has no lock address yet (Door locks settings).`
              : null,
        warnings,
        cards,
      };
    });
  }

  /**
   * Queues cards for the stay's current room. `new` makes one card with a
   * fresh room password (cancelling earlier guests' cards at the door) and
   * `count - 1` duplicates of it; `duplicate` copies the stay's last new card.
   */
  async issue(propertyId: string, stayId: string, input: { kind: 'new' | 'duplicate'; count: number }) {
    return this.db.tx(async (q) => {
      await this.expireStale(q, propertyId);
      const { rows } = await q.query<{ status: string; number: string; room_id: string | null; room_number: string; lock_address: string | null; ends: Date }>(
        `SELECT s.status, s.number, s.room_id, r.number AS room_number, r.lock_address, ${stayEndSql('s', 'res')} AS ends
           FROM stays s JOIN reservations res ON res.id = s.reservation_id LEFT JOIN rooms r ON r.id = s.room_id
          WHERE s.property_id = $1 AND s.id = $2 FOR NO KEY UPDATE OF s`,
        [propertyId, stayId],
      );
      const stay = rows[0];
      if (!stay) throw new NotFoundException('Stay not found at this property');
      const settings = await this.settingsRow(q, propertyId, true);
      if (!settings.enabled || !settings.system_code || !settings.hotel_code) {
        throw conflict('Key cards are switched off for this property. A manager sets them up under Door locks.', 'door_locks_disabled');
      }
      if (stay.status !== 'checked_in') throw conflict(`Stay ${stay.number} is ${stay.status.replace('_', ' ')}; key cards are made after check-in`, 'invalid_transition');
      if (!stay.room_id) throw conflict('The stay has no room', 'no_room');
      if (!stay.lock_address) throw conflict(`Room ${stay.room_number} has no lock address yet. A manager adds it under Door locks.`, 'no_lock_address');
      await q.query('SELECT 1 FROM rooms WHERE id = $1 FOR UPDATE', [stay.room_id]);

      const now = new Date();
      const validFrom = new Date(now.getTime() - VALID_FROM_SLACK_MS);
      const validTo = new Date(new Date(stay.ends).getTime() + settings.card_grace_minutes * 60_000);
      if (validTo <= now) throw conflict(`Stay ${stay.number} was due out already; extend it before making a card`, 'overstay');

      let roomPass: string;
      let parentId: string | null = null;
      const toMake: Array<'new' | 'duplicate'> = [];
      if (input.kind === 'new') {
        // Never reuse or go back from the room's newest password, including one still being encoded.
        const { rows: prev } = await q.query<{ room_pass: string }>(
          `SELECT room_pass FROM (
             SELECT room_pass, updated_at AS at FROM room_lock_state WHERE room_id = $1
             UNION ALL
             SELECT room_pass, requested_at FROM key_cards WHERE room_id = $1 AND kind = 'new' AND status IN ('pending', 'encoding')
           ) x ORDER BY ('x' || lpad(room_pass, 8, '0'))::bit(32)::bigint DESC LIMIT 1`,
          [stay.room_id],
        );
        roomPass = nextRoomPass(now, prev[0]?.room_pass);
        toMake.push('new', ...Array<'duplicate'>(input.count - 1).fill('duplicate'));
      } else {
        const { rows: pendingNew } = await q.query<{ id: string; room_pass: string }>(
          `SELECT id, room_pass FROM key_cards WHERE room_id = $1 AND stay_id = $2 AND kind = 'new' AND status IN ('pending', 'encoding')
            ORDER BY requested_at DESC LIMIT 1`,
          [stay.room_id, stayId],
        );
        const { rows: state } = await q.query<{ room_pass: string; stay_id: string }>(
          `SELECT st.room_pass, k.stay_id FROM room_lock_state st JOIN key_cards k ON k.id = st.key_card_id WHERE st.room_id = $1`,
          [stay.room_id],
        );
        if (pendingNew[0]) {
          roomPass = pendingNew[0].room_pass;
          parentId = pendingNew[0].id;
        } else if (state[0]?.stay_id === stayId) {
          roomPass = state[0].room_pass;
        } else {
          throw conflict(`Make a new card for room ${stay.room_number} first; extra cards copy this guest’s new card`, 'new_card_required');
        }
        toMake.push(...Array<'duplicate'>(input.count).fill('duplicate'));
      }

      let cardNo = settings.next_card_no;
      const ids: string[] = [];
      for (const kind of toMake) {
        const params: KeyCardParams = keyCardParams({
          kind, cardNo, cardPass: settings.card_pass, systemCode: settings.system_code, hotelCode: settings.hotel_code,
          roomPass, lockAddress: stay.lock_address, validFrom, validTo,
        });
        const { rows: ins } = await q.query<{ id: string }>(
          `INSERT INTO key_cards (property_id, kind, stay_id, room_id, parent_id, card_no, lock_address, room_pass, valid_from, valid_to, params, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [propertyId, kind, stayId, stay.room_id, parentId, cardNo, stay.lock_address, roomPass, validFrom, validTo, JSON.stringify(params), this.actor()],
        );
        ids.push(ins[0].id);
        if (kind === 'new') parentId = ins[0].id;
        cardNo = nextCardNo(cardNo);
      }
      await q.query('UPDATE door_lock_settings SET next_card_no = $2 WHERE property_id = $1', [propertyId, cardNo]);
      await this.audit.record({
        action: 'keycard.request', entityType: 'stay', entityId: stayId, propertyId,
        newValues: { kind: input.kind, count: toMake.length, room: stay.room_number, validTo: validTo.toISOString(), keyCardIds: ids },
      });
      const cards = await this.stayCards(q, propertyId, stayId);
      return cards.filter((c) => ids.includes(c.id)).reverse();
    });
  }

  async cancel(propertyId: string, id: string) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `UPDATE key_cards SET status = 'cancelled', finished_at = now(), cancelled_by = $3, error = 'Cancelled at reception'
          WHERE property_id = $1 AND id = $2 AND status = 'pending' RETURNING id`,
        [propertyId, id, this.actor()],
      );
      if (!rows[0]) throw conflict('Only a card still waiting for the encoder can be cancelled', 'not_pending');
      await this.cancelChildren(q, id);
      await this.audit.record({ action: 'keycard.cancel', entityType: 'key_card', entityId: id, propertyId });
      return this.job(propertyId, id);
    });
  }

  /** Puts a "read the card on the encoder" job in the queue, to find whose card it is. */
  async requestRead(propertyId: string) {
    return this.db.tx(async (q) => {
      await this.expireStale(q, propertyId);
      const s = await this.settingsRow(q, propertyId);
      if (!s.bridge_token_hash) throw conflict('No encoder PC is paired for this property yet (Door locks settings)', 'bridge_not_paired');
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO key_cards (property_id, kind, requested_by) VALUES ($1, 'read', $2) RETURNING id`,
        [propertyId, this.actor()],
      );
      return this.job(propertyId, rows[0].id);
    });
  }

  /** One job, with what a read job found: the guest card with that number. */
  async job(propertyId: string, id: string) {
    return this.db.tx(async (q) => {
      await this.expireStale(q, propertyId);
      const { rows } = await q.query<KeyCardRow>(`SELECT ${CARD_COLUMNS} ${CARD_JOINS} WHERE k.property_id = $1 AND k.id = $2`, [propertyId, id]);
      if (!rows[0]) throw new NotFoundException('Key card job not found at this property');
      const job = rows[0];
      let matched: KeyCardRow | null = null;
      if (job.kind === 'read' && job.status === 'done' && job.readCardNo) {
        const { rows: m } = await q.query<KeyCardRow>(
          `SELECT ${CARD_COLUMNS} ${CARD_JOINS}
            WHERE k.property_id = $1 AND k.card_no = $2 AND k.status = 'done' AND k.kind <> 'read'
            ORDER BY k.requested_at DESC LIMIT 1`,
          [propertyId, job.readCardNo],
        );
        if (m[0] && m[0].stayId) matched = (await this.stayCards(q, propertyId, m[0].stayId)).find((c) => c.id === m[0].id) ?? m[0];
      }
      return { ...job, matched };
    });
  }

  // -------------------------------------------------------------------------
  // Bridge (encoder PC)
  // -------------------------------------------------------------------------

  /** Oldest waiting job for this property's encoder, one at a time; also the bridge's heartbeat. */
  async claim(propertyId: string, bridge: { bridgeId: string; version: string; mode: 'dll' | 'mock' }) {
    return this.db.tx(async (q) => {
      await q.query(
        `UPDATE door_lock_settings SET bridge_last_seen_at = now(), bridge_id = $2, bridge_version = $3, bridge_mode = $4 WHERE property_id = $1`,
        [propertyId, bridge.bridgeId, bridge.version, bridge.mode],
      );
      await this.expireStale(q, propertyId);
      const s = await this.settingsRow(q, propertyId);
      // One encoder: while a job is being written, wait for its result.
      const { rows: busy } = await q.query(`SELECT 1 FROM key_cards WHERE property_id = $1 AND status = 'encoding'`, [propertyId]);
      if (busy.length) return { job: null, comPort: s.com_port };
      const { rows } = await q.query<{ id: string; kind: 'new' | 'duplicate' | 'read'; params: KeyCardParams | null }>(
        `UPDATE key_cards SET status = 'encoding', claimed_by = $2, claim_expires_at = now() + make_interval(secs => $3)
          WHERE id = (SELECT id FROM key_cards WHERE property_id = $1 AND status = 'pending' ORDER BY requested_at, card_no NULLS LAST LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING id, kind, params`,
        [propertyId, bridge.bridgeId, ENCODE_LEASE_SECONDS],
      );
      const job = rows[0];
      if (!job) return { job: null, comPort: s.com_port };
      return {
        comPort: s.com_port,
        job: job.kind === 'read'
          ? { id: job.id, kind: 'read' as const, read: { nBlock: 4, encrypt: 1, cardPass: s.card_pass } }
          : { id: job.id, kind: job.kind, keyCard: job.params },
      };
    });
  }

  async complete(propertyId: string, id: string, bridgeId: string, result: BridgeResult) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ kind: string; room_id: string | null; room_pass: string | null }>(
        `SELECT kind, room_id, room_pass FROM key_cards WHERE property_id = $1 AND id = $2 AND status = 'encoding' AND claimed_by = $3 FOR UPDATE`,
        [propertyId, id, bridgeId],
      );
      const job = rows[0];
      if (!job) throw conflict('This job is not being encoded by this bridge (it timed out or was already reported)', 'not_claimed');
      if (result.outcome === 'done') {
        await q.query(
          `UPDATE key_cards SET status = 'done', finished_at = now(), claim_expires_at = NULL, read_card_no = $3, read_system_code = $4 WHERE id = $1 AND property_id = $2`,
          [id, propertyId, job.kind === 'read' ? result.cardNo ?? null : null, job.kind === 'read' ? result.systemCode ?? null : null],
        );
        if (job.kind === 'new') {
          await q.query(
            `INSERT INTO room_lock_state (room_id, property_id, room_pass, key_card_id) VALUES ($1, $2, $3, $4)
             ON CONFLICT (room_id) DO UPDATE SET room_pass = EXCLUDED.room_pass, key_card_id = EXCLUDED.key_card_id`,
            [job.room_id, propertyId, job.room_pass, id],
          );
        }
      } else {
        await q.query(
          `UPDATE key_cards SET status = 'failed', finished_at = now(), claim_expires_at = NULL, error_code = $3, error = $4 WHERE id = $1 AND property_id = $2`,
          [id, propertyId, result.errorCode ?? null, result.error.slice(0, 1000)],
        );
        await this.cancelChildren(q, id);
      }
      if (job.kind !== 'read') {
        await this.audit.record({
          action: result.outcome === 'done' ? 'keycard.encoded' : 'keycard.failed', entityType: 'key_card', entityId: id, propertyId,
          newValues: result.outcome === 'done' ? {} : { errorCode: result.errorCode ?? null, error: result.error },
        });
      }
      return { id, status: result.outcome };
    });
  }
}

/** When the stay ends: departure date at the late check-out time, else the booking policy's check-out time (FD-06). */
function stayEndSql(s: string, res: string): string {
  return `((${s}.departure_date + coalesce(${s}.departure_time, (${res}.policy_snapshot->>'checkOutTime')::time, '10:00'::time))::timestamp AT TIME ZONE 'Africa/Nairobi')`;
}
