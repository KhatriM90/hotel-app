import { describe, expect, it } from 'vitest';
import { csvCell, dashboardDates, nightState, summarizeDashboard } from './roomdashboard';
import { DEFAULT_GUEST_FIELD_RULES, missingGuestFields } from './guestfields';
import { COUNTRIES, countryName, isCountryCode } from './countries';

describe('room dashboard', () => {
  it('lists dates inclusively across month, year and leap-day boundaries', () => {
    expect(dashboardDates('2028-02-28', '2028-03-01')).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
    expect(dashboardDates('2026-12-31', '2027-01-01')).toEqual(['2026-12-31', '2027-01-01']);
    expect(dashboardDates('2026-11-05', '2026-11-05')).toEqual(['2026-11-05']);
  });

  it('rejects reversed and over-long ranges', () => {
    expect(() => dashboardDates('2026-11-05', '2026-11-04')).toThrow(/before/);
    expect(() => dashboardDates('2026-01-01', '2027-01-02')).toThrow(/366/);
    expect(dashboardDates('2028-01-01', '2028-12-31')).toHaveLength(366);
  });

  it('treats the departure morning as free (checkout-exclusive)', () => {
    const segs = [{ roomId: 'r1', kind: 'stay' as const, from: '2026-11-05', to: '2026-11-07', status: 'checked_in' }];
    expect(nightState(segs, 'r1', '2026-11-05')).toBe('occupied');
    expect(nightState(segs, 'r1', '2026-11-06')).toBe('occupied');
    expect(nightState(segs, 'r1', '2026-11-07')).toBe('available');
  });

  it('counts room-nights and occupancy without blocked nights', () => {
    const rooms = [{ id: 'r1' }, { id: 'r2' }];
    const segs = [
      { roomId: 'r1', kind: 'stay' as const, from: '2026-11-05', to: '2026-11-07', status: 'checked_in' },
      { roomId: 'r2', kind: 'block' as const, from: '2026-11-05', to: '2026-11-06' },
      { roomId: 'r2', kind: 'stay' as const, from: '2026-11-06', to: '2026-11-08', status: 'confirmed' },
    ];
    const s = summarizeDashboard(rooms, segs, ['2026-11-05', '2026-11-06']);
    expect(s).toEqual({ roomNights: 4, available: 0, reserved: 1, occupied: 2, blocked: 1, occupancyPercent: 66.7 });
    expect(summarizeDashboard([{ id: 'x' }], [{ roomId: 'x', kind: 'block', from: '2026-01-01', to: '2026-01-02' }], ['2026-01-01']).occupancyPercent).toBeNull();
  });

  it('neutralises spreadsheet formulas in CSV cells', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+254700')).toBe(`"'+254700"`);
    expect(csvCell('Wanjiru, A')).toBe('"Wanjiru, A"');
    expect(csvCell('101')).toBe('101');
    expect(csvCell(null)).toBe('');
  });
});

describe('guest field rules', () => {
  it('needs a KRA PIN only from Kenyan guests by default', () => {
    expect(missingGuestFields({ phone: '0700', nationality: 'KE' }, DEFAULT_GUEST_FIELD_RULES)).toEqual(['kraPin']);
    expect(missingGuestFields({ phone: '0700', nationality: 'GB' }, DEFAULT_GUEST_FIELD_RULES)).toEqual([]);
    expect(missingGuestFields({}, DEFAULT_GUEST_FIELD_RULES)).toEqual(['phone', 'nationality']);
    expect(missingGuestFields({ phone: '1', nationality: 'GB' }, { ...DEFAULT_GUEST_FIELD_RULES, kraPin: 'required', email: 'required' })).toEqual(['email', 'kraPin']);
  });
});

describe('countries', () => {
  it('has every ISO country with a name', () => {
    expect(COUNTRIES).toHaveLength(249);
    expect(countryName('ke')).toBe('Kenya');
    expect(isCountryCode('TZ')).toBe(true);
    expect(isCountryCode('XX')).toBe(false);
  });
});
