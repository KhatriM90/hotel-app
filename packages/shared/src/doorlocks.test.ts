import { describe, expect, it } from 'vitest';
import {
  cardDate,
  cardTime,
  compactCipherTime,
  keyCardParams,
  MAX_CARD_NO,
  nairobiInstant,
  nextCardNo,
  nextRoomPass,
  parseLockAddress,
} from './doorlocks';

describe('door locks (INT-09, TEMIC20 V20 RF)', () => {
  it('computes the vendor RPass from Nairobi time', () => {
    // 2026-11-07 15:41 EAT: 41/4=10, 15·16=240, 7·512=3584, 11·16384=180224, ((2026-8)%1000%63=18)·262144=4718592
    expect(compactCipherTime(nairobiInstant('2026-11-07', '15:41'))).toBe((10 + 240 + 3584 + 180224 + 4718592).toString(16).toUpperCase());
    expect(compactCipherTime(nairobiInstant('2026-11-07', '15:41'))).toBe('4ACEFA');
    // Same 4-minute window, same value.
    expect(compactCipherTime(nairobiInstant('2026-11-07', '15:40'))).toBe(compactCipherTime(nairobiInstant('2026-11-07', '15:43')));
    // 12:30 UTC is 15:30 in Nairobi.
    expect(compactCipherTime(new Date('2026-11-07T12:30:00Z'))).toBe(compactCipherTime(nairobiInstant('2026-11-07', '15:30')));
  });

  it('never repeats or goes backwards for a room', () => {
    const at = nairobiInstant('2026-11-07', '15:41');
    expect(nextRoomPass(at, null)).toBe('4ACEFA');
    expect(nextRoomPass(at, '4ACEF0')).toBe('4ACEFA');
    expect(nextRoomPass(at, '4ACEFA')).toBe('4ACEFB');
    expect(nextRoomPass(at, '4ACF00')).toBe('4ACF01');
  });

  it('formats card dates with a two-digit year in Nairobi time', () => {
    const at = new Date('2026-12-31T22:15:09Z'); // 01:15:09 on 1 Jan 2027 in Nairobi
    expect(cardDate(at)).toBe('27-01-01');
    expect(cardTime(at)).toBe('01:15:09');
  });

  it('reads and checks lock addresses', () => {
    expect(parseLockAddress('01020300400')).toEqual({ building: 2, floor: 3, room: 4, door: 0 });
    expect(() => parseLockAddress('0102030040')).toThrow(/11 digits/);
    expect(() => parseLockAddress('02020300400')).toThrow();
  });

  it('builds the KeyCard arguments for a single-room guest card', () => {
    const p = keyCardParams({
      kind: 'new', cardNo: 17, cardPass: '82A094FFFFFF', systemCode: 'ABC', hotelCode: '123', roomPass: '4ACEFA',
      lockAddress: '01010200600', validFrom: nairobiInstant('2026-11-07', '15:41:00'), validTo: nairobiInstant('2026-11-09', '10:30:00'),
    });
    expect(p).toMatchObject({
      cardNo: 17, nBlock: 4, encrypt: 1, address: '01010200600', sdIn: '26-11-07', stIn: '15:41:00', sdOut: '26-11-09', stOut: '10:30:00',
      levelPass: 3, passMode: 1, addressMode: 0, addressQty: 1, timeMode: 0, v8: 255, v16: 255, v24: 255, alwaysOpen: 0, openBolt: 0,
      terminateOld: 1, validTimes: 255,
    });
    expect(keyCardParams({ ...base(), kind: 'duplicate' }).terminateOld).toBe(0);
    expect(() => keyCardParams({ ...base(), cardNo: MAX_CARD_NO + 1 })).toThrow(/Card number/);
    expect(() => keyCardParams({ ...base(), validTo: base().validFrom })).toThrow(/end after/);
  });

  it('wraps card numbers after 24 bits', () => {
    expect(nextCardNo(1)).toBe(2);
    expect(nextCardNo(MAX_CARD_NO)).toBe(1);
  });
});

function base() {
  return {
    kind: 'new' as const, cardNo: 1, cardPass: '82A094FFFFFF', systemCode: 'S', hotelCode: 'H', roomPass: '1',
    lockAddress: '01010200600', validFrom: nairobiInstant('2026-11-07', '12:00'), validTo: nairobiInstant('2026-11-08', '10:00'),
  };
}
