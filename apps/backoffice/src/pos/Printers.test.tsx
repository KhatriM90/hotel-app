import { describe, expect, it } from 'vitest';
import { jobState } from './Printers';

const failed = { status: 'failed', acknowledgedAt: null, acknowledgedBy: null, replacedById: null, replacedByStatus: null, replacedByPrinter: null };

describe('print job state', () => {
  it('says whether a failed job still needs someone', () => {
    expect(jobState({ ...failed, status: 'printed' })).toBe('Printed');
    expect(jobState(failed)).toBe('Failed; waiting for staff');
    expect(jobState({ ...failed, acknowledgedAt: '2026-11-10T10:00:00Z', acknowledgedBy: 'Alice' })).toBe('Failed; dealt with by Alice');
    expect(jobState({ ...failed, replacedById: 'x', replacedByStatus: 'printed', replacedByPrinter: 'Bar Epson' })).toBe('Failed; Bar Epson: printed');
  });
});
