import { describe, expect, it } from 'vitest';
import { canOpenCounter, customerLine, evenShare, KRA_PIN, newlyReady, sentMessage, tileClass } from './waiter';

describe('split evenly', () => {
  it('gives each person a share rounded down to the cent', () => {
    expect(evenShare('1850.00', 2)).toBe('925.00');
    expect(evenShare('1000.00', 3)).toBe('333.33');
    expect(evenShare('0.05', 3)).toBe('0.01');
    expect(evenShare('700', 1)).toBe('700.00');
  });
});

describe('tile colours', () => {
  it('colours known categories and gives unknown ones a stable colour', () => {
    expect(tileClass('BEER')).toBe('t-beer');
    expect(tileClass('MAINS')).toBe('t-food');
    expect(tileClass('NEWCAT')).toBe(tileClass('NEWCAT'));
    expect(tileClass('NEWCAT')).toMatch(/^t-/);
  });
});

describe('send message', () => {
  it('names the printers the tickets went to, once each', () => {
    expect(sentMessage([])).toBe('Sent');
    expect(sentMessage([
      { number: 'T1', station: 'KIT', printer: 'Kitchen Epson' },
      { number: 'T2', station: 'BAR', printer: 'Kitchen Epson' },
      { number: 'T3', station: 'GRILL', printer: null },
    ])).toBe('Sent: Kitchen Epson, GRILL screen');
  });
});

describe('counter sales and bar tabs', () => {
  it('are open to everyone unless the outlet keeps them for counter staff', () => {
    expect(canOpenCounter({ counterStaffOnly: false }, ['waiter'])).toBe(true);
    expect(canOpenCounter({}, ['waiter'])).toBe(true);
    expect(canOpenCounter({ counterStaffOnly: true }, ['waiter'])).toBe(false);
    expect(canOpenCounter({ counterStaffOnly: true }, ['bartender'])).toBe(true);
    expect(canOpenCounter({ counterStaffOnly: true }, ['waiter', 'cashier'])).toBe(true);
  });
});

describe('ready alert', () => {
  it('alerts only for my checks with more items ready than last seen', () => {
    const seen = new Map<string, number>();
    const checks = [
      { id: 'a', waiterId: 'me', readyLines: 0 },
      { id: 'b', waiterId: 'other', readyLines: 2 },
    ];
    expect(newlyReady(checks, 'me', seen)).toEqual([]);
    checks[0].readyLines = 1;
    expect(newlyReady(checks, 'me', seen)).toEqual(['a']);
    expect(newlyReady(checks, 'me', seen)).toEqual([]);
    checks[0].readyLines = 0;
    expect(newlyReady(checks, 'me', seen)).toEqual([]);
    checks[0].readyLines = 2;
    expect(newlyReady(checks, 'me', seen)).toEqual(['a']);
    expect(newlyReady(checks, undefined, new Map())).toEqual([]);
  });
});

describe('customer KRA PIN on the bill', () => {
  it('shows the name with the PIN, and the phone only in pick lists', () => {
    const acme = { name: 'Acme Traders Ltd', kraPin: 'P051234567Q', phone: '+254722123456' };
    expect(customerLine(acme)).toBe('Acme Traders Ltd · PIN P051234567Q');
    expect(customerLine(acme, true)).toBe('Acme Traders Ltd · PIN P051234567Q · +254722123456');
    expect(customerLine({ name: 'Walk-in', kraPin: null })).toBe('Walk-in');
    expect(customerLine(null)).toBe('');
  });
  it('accepts KRA PINs shaped like A012345678Z', () => {
    expect(KRA_PIN.test('P051234567Q')).toBe(true);
    expect(KRA_PIN.test('P05123456Q')).toBe(false);
    expect(KRA_PIN.test('p051234567q')).toBe(false);
  });
});
