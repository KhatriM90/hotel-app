import { describe, expect, it } from 'vitest';
import { cardStatus, KeyCard } from './KeyCards';

const card = (over: Partial<KeyCard>): KeyCard => ({
  id: '1', kind: 'new', status: 'done', stayNumber: 'KM-ST-000001', roomNumber: '101', cardNo: 7, validTo: null,
  errorCode: null, error: null, readCardNo: null, requestedBy: 'Kahama receptionist', requestedAt: '2031-07-07T12:00:00Z', ...over,
});

describe('key card status text', () => {
  it('tells reception what to do while the encoder works', () => {
    expect(cardStatus(card({ status: 'pending' }))).toMatch(/put a blank card/);
    expect(cardStatus(card({ status: 'encoding' }))).toMatch(/Writing/);
  });

  it('explains why a finished card does or does not open the room', () => {
    expect(cardStatus(card({ state: 'active' }))).toBe('Opens the room');
    expect(cardStatus(card({ state: 'moved' }))).toBe('Previous room');
    expect(cardStatus(card({ state: 'replaced' }))).toMatch(/newer guest card/);
  });

  it('shows the encoder error', () => {
    expect(cardStatus(card({ status: 'failed', error: 'The encoder returned error 3.' }))).toBe('The encoder returned error 3.');
  });
});
