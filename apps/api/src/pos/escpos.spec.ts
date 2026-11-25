import { ascii, columnsFor, EscPos, escposCheck, escposTicket, wrap } from './escpos';

describe('ESC/POS slips for Epson printers (INT-04)', () => {
  it('keeps text to plain ASCII the printer can show on any code page', () => {
    expect(ascii('2 × Café crème · “large”')).toBe('2 x Cafe creme - "large"');
    expect(ascii('Line\nbreak\ttab')).toBe('Line break tab');
    expect(ascii('Chai ☕')).toBe('Chai ?');
  });

  it('wraps words to the paper width and splits words that are too long', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrap('abcdefghijkl', 5)).toEqual(['abcde', 'fghij', 'kl']);
    expect(wrap('', 10)).toEqual(['']);
    expect(columnsFor(80)).toBe(48);
    expect(columnsFor(58)).toBe(32);
  });

  it('right-aligns amounts on the line width, and halves the width for large text', () => {
    const p = new EscPos(32).pair('2 x Tusker', '700.00');
    const text = p.toBuffer().subarray(2).toString('latin1');
    expect(text).toBe(`2 x Tusker${' '.repeat(32 - 10 - 6)}700.00\n`);
    expect(new EscPos(48).big(true).cols()).toBe(24);
  });

  it('starts with ESC @, ends with a cut, and marks reprints and cancellations', () => {
    const ticket = {
      number: 'KM-TKT-000009', printNo: 2, route: 'kitchen',
      content: { kind: 'cancellation', station: { name: 'Main kitchen' }, table: 'T4', outlet: { name: 'Cocktail Bar' }, checkNumber: 'KM-CHK-1', server: 'Alice',
        covers: 2, time: '2026-11-10 20:15', reason: 'Guest changed mind', lines: [{ quantity: '1', name: 'Beef samosas', modifiers: ['Extra chilli'], notes: null }] },
    };
    const b = escposTicket(ticket, 80).toBuffer();
    expect([...b.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...b.subarray(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
    const text = b.toString('latin1');
    expect(text).toContain('REPRINT #2');
    expect(text).toContain(' CANCEL ');
    expect(text).toContain('TABLE T4');
    expect(text).toContain('Reason: Guest changed mind');
    expect(text).toContain('+ Extra chilli');
  });

  it('prints the customer and their KRA PIN on the bill (POS demo, 25 Nov 2026)', () => {
    const check = {
      status: 'open', number: 'K1-CHK-000045', outletName: 'Cocktail Bar', serviceType: 'counter', covers: 1, waiter: 'Alice', businessDate: '2026-11-25',
      customer: { name: 'Acme Traders Ltd', kraPin: 'P051234567Q' },
      lines: [{ status: 'sent', quantity: '1', name: 'Soda', amount: '150.00', modifiers: [], discountAmount: '0', ruleDiscount: '0', taxes: [] }],
      totals: { total: '150.00', balance: '150.00' }, payments: [], refunds: [],
    };
    const text = escposCheck(check, { name: 'K1 Klubhouse', kraPin: 'P000598390N' }, 80).toBuffer().toString('latin1');
    expect(text).toContain('Customer Acme Traders Ltd');
    expect(text).toContain('Customer KRA PIN P051234567Q');
    const none = escposCheck({ ...check, customer: null }, { name: 'K1 Klubhouse' }, 80).toBuffer().toString('latin1');
    expect(none).not.toContain('Customer');
  });
});
