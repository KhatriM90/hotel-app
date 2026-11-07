/**
 * Door locks (INT-09): TEMIC20 "V20 RF" locks driven through the vendor's
 * HUNERF.dll on a reception PC (see docs/door-locks.md). The cloud works out
 * every value the DLL's KeyCard call needs, so the Windows bridge only passes
 * them through and vendor quirks are fixed in one tested place.
 */

export const DOOR_LOCK_VENDORS = ['TEMIC20'] as const;
export type DoorLockVendor = (typeof DOOR_LOCK_VENDORS)[number];

export const KEY_CARD_KINDS = ['new', 'duplicate', 'read'] as const;
export type KeyCardKind = (typeof KEY_CARD_KINDS)[number];

export const KEY_CARD_STATUSES = ['pending', 'encoding', 'done', 'failed', 'cancelled'] as const;
export type KeyCardStatus = (typeof KEY_CARD_STATUSES)[number];

/** The card number field of KeyCard: 1 to 16,777,215 (24 bits). */
export const MAX_CARD_NO = 16_777_215;

/** Vendor default sector key for V20 RF cards (Lock DLL20.pdf). */
export const DEFAULT_CARD_PASS = '82A094FFFFFF';

/**
 * Lock address: "01" + building (2) + floor (2) + room (3) + door (2), as shown
 * on the Room page of the vendor's lock software. Example 01020300400 is
 * building 2, floor 3, room 4.
 */
export const LOCK_ADDRESS_PATTERN = /^01\d{9}$/;

export function parseLockAddress(address: string): { building: number; floor: number; room: number; door: number } {
  if (!LOCK_ADDRESS_PATTERN.test(address)) {
    throw new Error('A lock address is 11 digits starting 01, e.g. 01010200600 for building 1, floor 2, room 6');
  }
  return {
    building: Number(address.slice(2, 4)),
    floor: Number(address.slice(4, 6)),
    room: Number(address.slice(6, 9)),
    door: Number(address.slice(9, 11)),
  };
}

/** Kenya has used UTC+3 all year since 1960 (no daylight saving). Locks keep hotel time. */
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function nairobiParts(at: Date): LocalParts {
  const d = new Date(at.getTime() + EAT_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/** A Nairobi wall-clock date and time ("YYYY-MM-DD", "HH:MM[:SS]") as an instant. */
export function nairobiInstant(date: string, time: string): Date {
  const [h, m, s = '0'] = time.split(':');
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, Number(h), Number(m), Number(s)) - EAT_OFFSET_MS);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The DLL wants "yy-mm-dd" (two-digit year; four digits are refused) and "hh:nn:ss". */
export function cardDate(at: Date): string {
  const p = nairobiParts(at);
  return `${pad(p.year % 100)}-${pad(p.month)}-${pad(p.day)}`;
}

export function cardTime(at: Date): string {
  const p = nairobiParts(at);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/**
 * The vendor's CompactCipherTime: the room password ("RPass") written on a
 * "new" guest card, from the hotel's clock. A lock that sees a newer RPass
 * stops accepting cards with an older one, which is how a new guest's card
 * cancels the previous guest's. Resolution is 4 minutes.
 *
 *   dw = Min/4 + Hour·2⁴ + Day·2⁹ + Month·2¹⁴ + (((Year−8) mod 1000) mod 63)·2¹⁸, as upper-case hex
 */
export function compactCipherTime(at: Date): string {
  const p = nairobiParts(at);
  const dw =
    Math.floor(p.minute / 4) +
    p.hour * 2 ** 4 +
    p.day * 2 ** 9 +
    p.month * 2 ** 14 +
    (((p.year - 8) % 1000) % 63) * 2 ** 18;
  return dw.toString(16).toUpperCase();
}

/**
 * RPass for a new card. Two new cards for one room inside the same 4-minute
 * window would get the same value, and the second would not cancel the first
 * (a lost card replaced straight away, or a quick room swap). So the value
 * never goes backwards or repeats for a room: if the clock gives a value at or
 * below the room's last one, the last one plus one is used.
 */
export function nextRoomPass(at: Date, previous: string | null | undefined): string {
  const fromClock = compactCipherTime(at);
  if (!previous) return fromClock;
  const prev = parseInt(previous, 16);
  const now = parseInt(fromClock, 16);
  return now > prev ? fromClock : (prev + 1).toString(16).toUpperCase();
}

export interface KeyCardInput {
  kind: 'new' | 'duplicate';
  cardNo: number;
  cardPass: string;
  systemCode: string;
  hotelCode: string;
  roomPass: string;
  lockAddress: string;
  validFrom: Date;
  validTo: Date;
}

/** Every argument of HUNERF.dll KeyCard, in the order of the C declaration. */
export interface KeyCardParams {
  cardNo: number;
  nBlock: number;
  encrypt: number;
  cardPass: string;
  systemCode: string;
  hotelCode: string;
  roomPass: string;
  address: string;
  sdIn: string;
  stIn: string;
  sdOut: string;
  stOut: string;
  levelPass: number;
  passMode: number;
  addressMode: number;
  addressQty: number;
  timeMode: number;
  v8: number;
  v16: number;
  v24: number;
  alwaysOpen: number;
  openBolt: number;
  terminateOld: number;
  validTimes: number;
}

/**
 * Single-room guest card per Lock DLL20.pdf and the vendor's interface note:
 * LEVEL_Pass 3 with PassMode 1 and AddressMode 0; TerminateOld 1 on a "new"
 * card. Fixed values (nBlock 4, Encrypt 1, TimeMode 0, V8/V16/V24 255,
 * ValidTimes 255) are as the vendor specifies.
 */
export function keyCardParams(input: KeyCardInput): KeyCardParams {
  if (!Number.isInteger(input.cardNo) || input.cardNo < 1 || input.cardNo > MAX_CARD_NO) {
    throw new Error(`Card number must be 1 to ${MAX_CARD_NO}`);
  }
  parseLockAddress(input.lockAddress);
  if (input.validTo.getTime() <= input.validFrom.getTime()) throw new Error('A key card must end after it starts');
  return {
    cardNo: input.cardNo,
    nBlock: 4,
    encrypt: 1,
    cardPass: input.cardPass,
    systemCode: input.systemCode,
    hotelCode: input.hotelCode,
    roomPass: input.roomPass,
    address: input.lockAddress,
    sdIn: cardDate(input.validFrom),
    stIn: cardTime(input.validFrom),
    sdOut: cardDate(input.validTo),
    stOut: cardTime(input.validTo),
    levelPass: 3,
    passMode: 1,
    addressMode: 0,
    addressQty: 1,
    timeMode: 0,
    v8: 255,
    v16: 255,
    v24: 255,
    alwaysOpen: 0,
    openBolt: 0,
    terminateOld: input.kind === 'new' ? 1 : 0,
    validTimes: 255,
  };
}

/** Next card number, wrapping after the 24-bit maximum. */
export function nextCardNo(current: number): number {
  return current >= MAX_CARD_NO ? 1 : current + 1;
}
