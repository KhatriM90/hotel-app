import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockServiceLayer, parseExtRefFilter } from './server';

describe('Service Layer mock', () => {
  const { server, state } = createMockServiceLayer();
  let base = '';
  let cookie = '';

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('logs in with company credentials and sets B1SESSION', async () => {
    const bad = await fetch(`${base}/b1s/v2/Login`, { method: 'POST', body: JSON.stringify({ CompanyDB: 'X', UserName: 'manager', Password: 'manager' }) });
    expect(bad.status).toBe(401);
    const res = await fetch(`${base}/b1s/v2/Login`, {
      method: 'POST',
      body: JSON.stringify({ CompanyDB: 'HOTEL_TEST', UserName: 'manager', Password: 'manager' }),
    });
    expect(res.status).toBe(200);
    cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    expect(cookie).toMatch(/B1SESSION=/);
  });

  it('requires a session', async () => {
    expect((await fetch(`${base}/b1s/v2/Invoices`)).status).toBe(401);
  });

  it('creates and finds documents by U_HTL_ExtRef', async () => {
    const body = {
      CardCode: 'C-WALKIN',
      BPL_IDAssignedToInvoice: 1,
      U_HTL_ExtRef: "K1-INV-000001",
      DocumentLines: [{ ItemCode: 'SODA', Quantity: 2 }],
    };
    const created = await fetch(`${base}/b1s/v2/Invoices`, { method: 'POST', headers: { cookie }, body: JSON.stringify(body) });
    expect(created.status).toBe(201);
    const filter = encodeURIComponent("U_HTL_ExtRef eq 'K1-INV-000001'");
    const found = await fetch(`${base}/b1s/v2/Invoices?$filter=${filter}&$select=DocEntry,DocNum`, { headers: { cookie } });
    expect((await found.json()).value).toEqual([{ DocEntry: 1, DocNum: 100001 }]);
  });

  it('rejects documents without a branch in a multi-branch company (SAP-13)', async () => {
    const res = await fetch(`${base}/b1s/v2/Invoices`, {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ CardCode: 'C', U_HTL_ExtRef: 'X-1', DocumentLines: [{ ItemCode: 'A', Quantity: 1 }] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('-5002');
  });

  it('parses escaped filter values', () => {
    expect(parseExtRefFilter("U_HTL_ExtRef eq 'O''Brien'")).toBe("O'Brien");
    expect(parseExtRefFilter('CardCode eq 1')).toBeUndefined();
    expect(state.documents.Invoices).toHaveLength(1);
  });
});
