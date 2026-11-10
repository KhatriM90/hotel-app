import { describe, expect, it } from 'vitest';
import { alertText, PrintAlert } from './print-alerts';

const base: PrintAlert = {
  id: '1', kind: 'ticket', title: 'Ticket KM-TKT-000012 - Main kitchen', printer: 'Kitchen Epson', error: 'Kitchen Epson: Paper out. Load a new roll, then reprint.',
  failedAt: '2026-11-10T18:00:00Z', outlet: 'Cocktail Bar', replacedById: null, replacedByStatus: null, replacedByPrinter: null,
};

describe('failed print alerts', () => {
  it('says what did not print, where, and why', () => {
    expect(alertText(base)).toBe('Ticket KM-TKT-000012 - Main kitchen did not print on Kitchen Epson: Kitchen Epson: Paper out. Load a new roll, then reprint.');
    expect(alertText({ ...base, error: null })).toBe('Ticket KM-TKT-000012 - Main kitchen did not print on Kitchen Epson.');
  });

  it('says what happened on the backup printer', () => {
    const moved = { ...base, error: 'Cover open. Sent to Bar Epson instead.', replacedById: '2', replacedByPrinter: 'Bar Epson' };
    expect(alertText({ ...moved, replacedByStatus: 'queued' })).toMatch(/Cover open\. Sending to Bar Epson instead\.$/);
    expect(alertText({ ...moved, replacedByStatus: 'printed' })).toMatch(/Printed on Bar Epson instead\.$/);
    expect(alertText({ ...moved, replacedByStatus: 'failed' })).toMatch(/Bar Epson failed too\.$/);
  });
});
