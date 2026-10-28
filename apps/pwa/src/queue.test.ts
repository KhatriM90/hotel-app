import { describe, expect, it } from 'vitest';
import { ApiError, OfflineError } from './api';
import { OfflineQueue, type QueuedAction } from './queue';

function memory(): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

const action = (checkId: string, label: string) => ({ method: 'POST' as const, path: `/x/${label}`, body: {}, key: `k-${label}`, label, checkId });

describe('offline order queue (OPS-05)', () => {
  it('keeps actions across reloads and sends them in order with their own keys', async () => {
    const store = memory();
    new OfflineQueue(store).add(action('A', 'open'));
    new OfflineQueue(store).add(action('A', 'lines'));
    const q = new OfflineQueue(store);
    const sent: string[] = [];
    const res = await q.flush(async (a) => void sent.push(a.key));
    expect(sent).toEqual(['k-open', 'k-lines']);
    expect(res).toEqual({ sent: 2, failed: 0, offline: false });
    expect(q.list()).toEqual([]);
  });

  it('stops when the server is still unreachable and keeps the rest', async () => {
    const q = new OfflineQueue(memory());
    q.add(action('A', 'open'));
    q.add(action('A', 'lines'));
    let calls = 0;
    const res = await q.flush(async () => {
      calls++;
      throw new OfflineError('down');
    });
    expect(calls).toBe(1);
    expect(res.offline).toBe(true);
    expect(q.list()).toHaveLength(2);
  });

  it('a refused action keeps its error and holds back later actions of that check only', async () => {
    const q = new OfflineQueue(memory());
    q.add(action('A', 'open'));
    q.add(action('A', 'lines'));
    q.add(action('B', 'open'));
    const sent: string[] = [];
    const res = await q.flush(async (a: QueuedAction) => {
      if (a.label === 'open' && a.checkId === 'A') throw new ApiError(409, 'Outlet day closed', 'outlet_day_closed');
      sent.push(`${a.checkId}:${a.label}`);
    });
    expect(sent).toEqual(['B:open']);
    expect(res).toMatchObject({ sent: 1, failed: 1 });
    const left = q.list();
    expect(left.map((a) => a.label)).toEqual(['open', 'lines']);
    expect(left[0].error).toBe('Outlet day closed');
    q.dismiss(left[0].id);
    expect(q.pendingFor('A').map((a) => a.label)).toEqual(['lines']);
  });
});
