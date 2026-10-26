import { describe, expect, it } from 'vitest';
import { Money, MoneyError } from './money';
import { formatDocumentNumber, parseDocumentNumber } from './documents';
import { hasPermission } from './roles';

describe('Money', () => {
  it('reproduces the brief checkout example exactly (AT-01)', () => {
    const charges = Money.sum([Money.of('6000').multiply(2), Money.of('2500'), Money.of('1500'), Money.of('500')]);
    expect(charges.toString()).toBe('16500.00');
    const balance = charges.subtract('5000');
    expect(balance.toString()).toBe('11500.00');
    expect(balance.subtract('8000').subtract('3500').isZero()).toBe(true);
  });

  it('avoids binary floating-point drift', () => {
    expect(Money.of('0.1').add('0.2').toString()).toBe('0.30');
  });

  it('rounds half-up to the minor unit', () => {
    expect(Money.of('1.005').toString()).toBe('1.01');
    expect(Money.of('-1.005').toString()).toBe('-1.01');
    expect(Money.of('100').multiply('0.16').toString()).toBe('16.00');
  });

  it('refuses fractional JS numbers and junk strings', () => {
    expect(() => Money.of(0.1)).toThrow(MoneyError);
    expect(() => Money.of('1e3')).toThrow(MoneyError);
    expect(() => Money.of('NaN')).toThrow(MoneyError);
    expect(Money.of(42).toString()).toBe('42.00');
  });

  it('refuses mixed currencies', () => {
    expect(() => Money.of('1', 'KES').add(Money.of('1', 'USD'))).toThrow(/Currency mismatch/);
  });

  it('allocates without losing or creating cents (AT-07)', () => {
    const parts = Money.of('100.00').allocate([1, 1, 1]);
    expect(parts.map(String)).toEqual(['33.34', '33.33', '33.33']);
    expect(Money.sum(parts).toString()).toBe('100.00');

    const uneven = Money.of('1000.01').allocate(['70', '30']);
    expect(Money.sum(uneven).toString()).toBe('1000.01');
  });

  it('formats for display', () => {
    expect(Money.of('16500').format()).toBe('KES 16,500.00');
    expect(Money.of('-5').format()).toBe('-KES 5.00');
    expect(JSON.stringify({ a: Money.of('1') })).toBe('{"a":"1.00"}');
  });
});

describe('document numbers', () => {
  it('formats with property prefix and padding (CFG-04)', () => {
    expect(formatDocumentNumber('K1', 'INVOICE', 7)).toBe('K1-INV-000007');
    expect(formatDocumentNumber('SW', 'FOLIO', 1234567)).toBe('SW-FO-1234567');
    expect(parseDocumentNumber('KM-BK-000042')).toEqual({ propertyCode: 'KM', prefix: 'BK', seq: 42n });
    expect(parseDocumentNumber('bad')).toBeNull();
  });
});

describe('permissions', () => {
  it('blocks waiters from managing outlets', () => {
    expect(hasPermission(['waiter'], 'outlet.manage')).toBe(false);
    expect(hasPermission(['waiter', 'manager'], 'outlet.manage')).toBe(true);
  });
});
