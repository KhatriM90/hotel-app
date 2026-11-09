import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api, ApiError } from './api';
import { IdleGuard } from './tablet';

function memory(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('shared tablet sign-in (Kahama meeting 2.3)', () => {
  afterEach(() => vi.useRealTimers());

  it('signs in with a PIN through the registered tablet and sets its property', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return json(200, {
        accessToken: 'pin-token',
        user: { id: 'u1', username: 'km.waiter', displayName: 'Kahama waiter', roles: ['waiter'] },
        propertyCode: 'KM',
        device: { id: 'd1', name: 'Pool bar', propertyCode: 'KM', idleSignoutSeconds: 90, signoutAfterSend: true },
      });
    }) as unknown as typeof fetch;
    const api = new Api(memory(), fetchImpl);
    api.device = { id: 'd1', name: 'Old name', token: 'device-token', propertyCode: 'KM', idleSignoutSeconds: 120, signoutAfterSend: false };
    const s = await api.pinLogin('u1', '4826');
    expect(calls[0].url).toBe('/api/auth/pin-login');
    expect(calls[0].headers['x-pos-device']).toBe('device-token');
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(s).toMatchObject({ token: 'pin-token', propertyCode: 'KM', viaPin: true });
    expect(api.device).toMatchObject({ token: 'device-token', name: 'Pool bar', idleSignoutSeconds: 90, signoutAfterSend: true });
  });

  it('replays an action with the token of the waiter who took it, and a refusal does not sign out whoever is on the tablet now', async () => {
    let seen = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = (init.headers as Record<string, string>).authorization;
      return json(401, { error: 'unauthorized', message: 'expired' });
    }) as unknown as typeof fetch;
    const api = new Api(memory(), fetchImpl);
    api.session = { token: 'second-waiter', user: { id: 'u2', username: 'b', displayName: 'B', roles: ['waiter'] } };
    await expect(api.requestAs('first-waiter', 'POST', '/x', {}, 'k1')).rejects.toBeInstanceOf(ApiError);
    expect(seen).toBe('Bearer first-waiter');
    expect(api.session?.token).toBe('second-waiter');
  });

  it('signs out after the idle time, counts touches as activity and waits while paused', () => {
    vi.useFakeTimers();
    let active = true;
    const expired = vi.fn();
    const guard = new IdleGuard(60, expired, () => active);
    guard.start();
    vi.advanceTimersByTime(50_000);
    expect(guard.remaining()).toBe(10);
    expect(document.querySelector('.idle-banner')?.textContent).toContain('Signing out in');
    window.dispatchEvent(new Event('pointerdown'));
    expect(guard.remaining()).toBe(60);
    expect(document.querySelector('.idle-banner')).toBeNull();
    active = false; // offline, or the kitchen ticket screen
    vi.advanceTimersByTime(120_000);
    expect(expired).not.toHaveBeenCalled();
    active = true;
    vi.advanceTimersByTime(61_000);
    expect(expired).toHaveBeenCalledTimes(1);
    guard.stop();
  });
});
