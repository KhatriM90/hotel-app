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

  it('downloads a report with the file name the server chose (RPT-06)', async () => {
    const storage = memoryStorage();
    storage.setItem('yeastay.token', 'tok');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('\ufeffPOS sales\r\n', { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="K1-pos-sales-2026-11-02.csv"' } }),
    );
    const api = new Api('/api', storage, fetchMock);
    const file = await api.download('/properties/K1/reports/pos-sales/export?from=2026-11-02&to=2026-11-02&format=csv');
    expect(file.filename).toBe('K1-pos-sales-2026-11-02.csv');
    expect(await file.blob.text()).toContain('POS sales');
    expect((fetchMock.mock.calls[0][1].headers as Headers).get('authorization')).toBe('Bearer tok');
  });
});
