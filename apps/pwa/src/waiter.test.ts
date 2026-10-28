import { describe, expect, it } from 'vitest';
import { evenShare, tileClass } from './waiter';

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
