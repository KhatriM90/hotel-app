import { describe, expect, it, vi } from 'vitest';
import { Api, ApiError } from './api';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Api client', () => {
  it('stores the token on login and sends it afterwards', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { accessToken: 'abc', user: { username: 'owner' } }))
      .mockResolvedValueOnce(json(200, []));
    const api = new Api('/api', memoryStorage(), fetchMock);
    await api.login('owner', 'pw');
    await api.properties();
    const headers = fetchMock.mock.calls[1][1].headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer abc');
  });

  it('drops the token on 401 and surfaces the server message', async () => {
    const storage = memoryStorage();
    storage.setItem('yeastay.token', 'old');
    const api = new Api('/api', storage, vi.fn().mockResolvedValue(json(401, { message: 'Invalid or expired token' })));
    await expect(api.me()).rejects.toEqual(new ApiError(401, 'Invalid or expired token'));
    expect(api.token).toBeNull();
  });
});
