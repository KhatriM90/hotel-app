import { describe, expect, it } from 'vitest';
import { Money } from './money';
import { hasPermission } from './roles';
import { liquorAllowed, outletTradingDate, priceLine, ruleApplies, spreadOverLines, tradingDate } from './pos';

describe('trading date from the business-day cut-off (§9)', () => {
  it('puts sales before 08:00 on the previous business date', () => {
    expect(tradingDate('2026-10-29T07:59', '08:00')).toBe('2026-10-28');
    expect(tradingDate('2026-10-29T08:00', '08:00')).toBe('2026-10-29');
    expect(tradingDate('2026-10-29T00:30:12', '08:00')).toBe('2026-10-28');
    expect(tradingDate('2026-11-01T02:00', '00:00')).toBe('2026-11-01');
  });

  it('honours an outlet that starts its day earlier', () => {
    expect(tradingDate('2026-10-29T06:30', '05:00')).toBe('2026-10-29');
    expect(tradingDate('2026-10-29T06:30', '08:00')).toBe('2026-10-28');
  });

  it('never opens an outlet day before the property date or more than one day after it', () => {
    expect(outletTradingDate('2026-10-29T03:00', '08:00', '2026-10-29')).toBe('2026-10-29');
    expect(outletTradingDate('2026-10-29T09:00', '08:00', '2026-10-28')).toBe('2026-10-29');
    expect(outletTradingDate('2026-11-02T09:00', '08:00', '2026-10-28')).toBe('2026-10-29');
  });
});

describe('liquor-licence hours (POS-17)', () => {
  // Friday (5) 18:00–02:00, Saturday (6) 14:00–23:00
  const hours = [
    { weekday: 5, opensAt: '18:00', closesAt: '02:00' },
    { weekday: 6, opensAt: '14:00', closesAt: '23:00' },
  ];
  it('allows sales inside a window and past midnight for an overnight window', () => {
    expect(liquorAllowed(hours, '2026-10-30T18:00')).toBe(true); // Friday
    expect(liquorAllowed(hours, '2026-10-31T01:59')).toBe(true); // Saturday early, Friday's window
    expect(liquorAllowed(hours, '2026-10-31T15:00')).toBe(true); // Saturday afternoon
  });
  it('blocks outside the windows and on days without one', () => {
    expect(liquorAllowed(hours, '2026-10-30T17:59')).toBe(false);
    expect(liquorAllowed(hours, '2026-10-31T02:00')).toBe(false);
    expect(liquorAllowed(hours, '2026-10-31T23:00')).toBe(false);
    expect(liquorAllowed(hours, '2026-11-01T01:00')).toBe(false); // Saturday's window does not run past midnight
    expect(liquorAllowed(hours, '2026-11-02T12:00')).toBe(false); // Monday: no window
    expect(liquorAllowed([], '2026-10-30T20:00')).toBe(false);
  });
});

describe('scheduled price rules (POS-03)', () => {
  const happyHour = { weekdays: [1, 2, 3, 4, 5], startsAt: '17:00', endsAt: '19:00', validFrom: '2026-10-01', validTo: null };
  it('applies on the right days and hours only', () => {
    expect(ruleApplies(happyHour, '2026-10-29T17:30')).toBe(true); // Thursday
    expect(ruleApplies(happyHour, '2026-10-29T19:00')).toBe(false);
    expect(ruleApplies(happyHour, '2026-10-31T17:30')).toBe(false); // Saturday
    expect(ruleApplies(happyHour, '2026-09-30T17:30')).toBe(false); // before valid_from
    expect(ruleApplies({ ...happyHour, validTo: '2026-10-28' }, '2026-10-29T17:30')).toBe(false);
  });
});

describe('line pricing (POS-03, BIL-08)', () => {
  it('adds modifiers per unit and applies the rule, then the manual discount', () => {
    expect(priceLine({ unitPrice: '350.00', quantity: '3' })).toEqual({ gross: '1050.00', ruleDiscount: '0.00', discount: '0.00', amount: '1050.00' });
    expect(priceLine({ unitPrice: '1200.00', modifiersUnitPrice: '150.00', quantity: '2', rulePercent: '10', discountPercent: '15' })).toEqual({
      gross: '2700.00', ruleDiscount: '270.00', discount: '364.50', amount: '2065.50',
    });
  });
  it('treats 100% as a comp with nothing left to pay', () => {
    expect(priceLine({ unitPrice: '333.33', quantity: '3', discountPercent: '100' }).amount).toBe('0.00');
  });
  it('rounds each step half-up to the cent', () => {
    expect(priceLine({ unitPrice: '99.99', quantity: '1', discountPercent: '12.5' })).toMatchObject({ discount: '12.50', amount: '87.49' });
  });
});

describe('room-charge remainder spread over lines (AT-07)', () => {
  it('sums exactly to the remainder and follows line weights', () => {
    const parts = spreadOverLines('1000.00', ['1050.00', '450.00', '300.00']);
    expect(parts).toEqual(['583.33', '250.00', '166.67']);
    expect(Money.sum(parts.map((p) => Money.of(p))).toString()).toBe('1000.00');
  });
  it('handles all-zero lines', () => {
    expect(spreadOverLines('0.00', ['0.00', '0.00'])).toEqual(['0.00', '0.00']);
  });
});

describe('POS permissions (SEC-02, AT-14)', () => {
  it('lets waiters order and settle but never refund', () => {
    expect(hasPermission(['waiter'], 'pos.use')).toBe(true);
    expect(hasPermission(['waiter'], 'pos.room_charge')).toBe(true);
    expect(hasPermission(['waiter'], 'pos.refund')).toBe(false);
    expect(hasPermission(['waiter'], 'approve.refund')).toBe(false);
    expect(hasPermission(['manager'], 'approve.refund')).toBe(true);
  });
  it('keeps the kitchen to tickets and day close to managers', () => {
    expect(hasPermission(['kitchen'], 'pos.kitchen')).toBe(true);
    expect(hasPermission(['kitchen'], 'pos.use')).toBe(false);
    expect(hasPermission(['cashier'], 'pos.day_close')).toBe(false);
    expect(hasPermission(['manager'], 'businessday.configure')).toBe(true);
    expect(hasPermission(['receptionist'], 'businessday.configure')).toBe(false);
  });
});
