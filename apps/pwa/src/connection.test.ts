import { describe, expect, it, vi } from 'vitest';
import { label, probe } from './connection';

describe('connection probe (OPS-04)', () => {
  it('is online only when the API health check answers', async () => {
    expect(await probe(vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))).toBe('online');
    expect(await probe(vi.fn().mockResolvedValue(new Response('', { status: 502 })))).toBe('offline');
    expect(await probe(vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))).toBe('offline');
  });

  it('warns staff not to confirm charges while offline', () => {
    expect(label('offline')).toMatch(/Do not confirm room charges or payments/);
  });
});
