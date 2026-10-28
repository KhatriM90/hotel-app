import { describe, expect, it } from 'vitest';
import {
  addDays,
  canTransition,
  cancellationCharge,
  depositDueDate,
  depositFor,
  isoWeekday,
  nightsBetween,
  priceNight,
  splitInclusiveTax,
  STAY_STATUSES,
  STAY_TRANSITIONS,
} from './frontdesk';
import { Money } from './money';
import { hasPermission } from './roles';

const rule = {
  weekdayPrice: '6500.00',
  weekendPrice: '7000.00',
  extraAdultPrice: '1500.00',
  childPrice: '750.00',
  weekendDays: [5, 6],
  baseOccupancy: 2,
};

describe('dates', () => {
  it('lists the nights of a stay, excluding the departure day', () => {
    expect(nightsBetween('2026-11-02', '2026-11-04')).toEqual(['2026-11-02', '2026-11-03']);
    expect(nightsBetween('2026-12-31', '2027-01-02')).toEqual(['2026-12-31', '2027-01-01']);
    expect(nightsBetween('2026-11-02', '2026-11-02')).toEqual([]);
  });

  it('knows ISO weekdays and rejects impossible dates', () => {
    expect(isoWeekday('2026-11-02')).toBe(1); // Monday
    expect(isoWeekday('2026-11-08')).toBe(7); // Sunday
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(() => addDays('2026-02-30', 1)).toThrow();
  });
});

describe('night pricing (RES-05)', () => {
  it('uses the weekend price on Friday and Saturday nights', () => {
    expect(priceNight(rule, '2026-11-05', 2, 0).amount).toBe('6500.00'); // Thursday
    expect(priceNight(rule, '2026-11-06', 2, 0)).toMatchObject({ amount: '7000.00', weekend: true }); // Friday
    expect(priceNight(rule, '2026-11-08', 2, 0).amount).toBe('6500.00'); // Sunday
  });

  it('adds occupancy supplements beyond the base occupancy', () => {
    expect(priceNight(rule, '2026-11-02', 3, 0)).toMatchObject({ base: '6500.00', supplement: '1500.00', amount: '8000.00' });
    // one adult + one child fit the base occupancy; a second child pays
    expect(priceNight(rule, '2026-11-02', 1, 1).supplement).toBe('0.00');
    expect(priceNight(rule, '2026-11-02', 2, 2).supplement).toBe('1500.00');
  });
});

describe('tax-inclusive split (BIL-01, BIL-16)', () => {
  const vatAndLevy = [
    { code: 'O1', ratePercent: '16' },
    { code: 'C1', ratePercent: '2' },
  ];

  it('separates VAT and catering levy and always adds back to the gross', () => {
    const s = splitInclusiveTax('6500.00', vatAndLevy);
    expect(s.net).toBe('5508.47');
    expect(s.lines.map((l) => [l.code, l.amount])).toEqual([
      ['O1', '881.36'],
      ['C1', '110.17'],
    ]);
    expect(Money.of(s.net).add(s.tax).toString()).toBe('6500.00');
  });

  it('is exact for many awkward amounts, positive and negative', () => {
    for (const g of ['0.01', '0.99', '1.00', '99.99', '1234.56', '-1234.56', '16500.00', '33.33']) {
      const s = splitInclusiveTax(g, vatAndLevy);
      const sum = Money.of(s.net).add(Money.sum(s.lines.map((l) => Money.of(l.amount))));
      expect(sum.toString()).toBe(Money.of(g).toString());
    }
  });

  it('passes untaxed amounts straight through', () => {
    expect(splitInclusiveTax('500.00', [])).toMatchObject({ net: '500.00', tax: '0.00', lines: [] });
  });
});

describe('deposits and cancellation (RES-07)', () => {
  const policy = {
    depositType: 'percent' as const,
    depositValue: '50',
    depositDueDays: 7,
    freeCancellationHours: 48,
    lateCancellationNights: 1,
    noShowNights: 1,
  };

  it('computes percent and first-night deposits', () => {
    expect(depositFor(policy, ['6500.00', '7000.00'])).toBe('6750.00');
    expect(depositFor({ ...policy, depositType: 'nights', depositValue: '1' }, ['6500.00', '7000.00'])).toBe('6500.00');
    expect(depositFor({ ...policy, depositType: 'none' }, ['6500.00'])).toBe('0.00');
  });

  it('never makes a deposit due before the booking date', () => {
    expect(depositDueDate(policy, '2026-10-28', '2026-11-20')).toBe('2026-11-13');
    expect(depositDueDate(policy, '2026-10-28', '2026-10-30')).toBe('2026-10-28');
  });

  it('charges the first night only inside the free-cancellation window', () => {
    const checkIn = new Date('2026-11-10T11:00:00Z');
    expect(cancellationCharge(policy, ['6500.00', '7000.00'], new Date('2026-11-07T11:00:00Z'), checkIn)).toBe('0.00');
    expect(cancellationCharge(policy, ['6500.00', '7000.00'], new Date('2026-11-09T11:00:00Z'), checkIn)).toBe('6500.00');
  });
});

describe('lifecycle (RES-03)', () => {
  it('only allows the documented transitions', () => {
    expect(canTransition('hold', 'confirmed')).toBe(true);
    expect(canTransition('confirmed', 'checked_in')).toBe(true);
    expect(canTransition('enquiry', 'checked_in')).toBe(false);
    expect(canTransition('checked_out', 'checked_in')).toBe(false);
    for (const s of ['checked_out', 'cancelled', 'no_show'] as const) expect(STAY_TRANSITIONS[s]).toEqual([]);
    expect(Object.keys(STAY_TRANSITIONS).sort()).toEqual([...STAY_STATUSES].sort());
  });
});

describe('front desk permissions (FD-02, AT-14)', () => {
  it('keeps identity documents away from waiters but not from reception or managers', () => {
    expect(hasPermission(['waiter'], 'guest.identity')).toBe(false);
    expect(hasPermission(['receptionist'], 'guest.identity')).toBe(true);
    expect(hasPermission(['manager'], 'guest.identity')).toBe(true);
  });

  it('reception cannot approve its own rate overrides', () => {
    expect(hasPermission(['receptionist'], 'approve.rate_override')).toBe(false);
    expect(hasPermission(['manager'], 'approve.rate_override')).toBe(true);
  });
});
