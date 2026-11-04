import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { addDays } from '@hotel/shared';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { runMigrations } from '../src/db/migrate';
import { DemoApi, UserApi } from '../src/demo/api-client';
import { seed } from '../src/seed';
import { DemoReport, nairobiToday, runDemo } from '../src/seed-demo';

/**
 * The demo seed, end to end, on a database of its own (so it never takes
 * rooms or business dates from the other suites). It starts the day before
 * today, as on a stack that has not closed yesterday yet.
 */
describe('demo data (seed-demo)', () => {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
  const ownerUrl = Object.assign(new URL(adminUrl), { pathname: '/hotel_api_demo' }).toString();
  const appUrl = Object.assign(new URL(ownerUrl), { username: 'hotel_app', password: 'hotel_app_test_pw' }).toString();
  const today = nairobiToday();
  const yesterday = addDays(today, -1);
  let app: INestApplication;
  let apiUrl: string;
  let report: DemoReport;
  let owner: UserApi;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS hotel_api_demo WITH (FORCE)');
    await admin.query('CREATE DATABASE hotel_api_demo');
    await admin.end();
    await runMigrations({ connectionString: ownerUrl, appRolePassword: 'hotel_app_test_pw', log: () => undefined });
    await seed(ownerUrl, process.env.SEED_PASSWORD!);
    const db = new Client({ connectionString: ownerUrl });
    await db.connect();
    await db.query(`UPDATE properties SET current_business_date = $1`, [yesterday]);
    await db.end();

    app = await createApp(loadConfig({ ...process.env, DATABASE_URL: appUrl }));
    await app.listen(0, '127.0.0.1');
    apiUrl = `${await app.getUrl()}/api`.replace('[::1]', '127.0.0.1');
    report = await runDemo({ apiUrl, password: process.env.SEED_PASSWORD!, today, log: () => undefined });
    owner = await new DemoApi(apiUrl, process.env.SEED_PASSWORD!).as('owner');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('creates every scenario at all three properties and closes yesterday', () => {
    expect(report.results.filter((r) => !r.ok)).toEqual([]);
    expect(report.results.length).toBeGreaterThan(80);
    expect(report.dates).toEqual({
      K1: { from: yesterday, to: today },
      SW: { from: yesterday, to: today },
      KM: { from: yesterday, to: today },
    });
  });

  it('fills the K1 front desk: arrivals, departures, in-house, a room not ready, requests', async () => {
    const d = await owner.get('/properties/K1/front-desk/dashboard');
    const names = (list: Array<{ guestName: string }>) => list.map((s) => s.guestName);
    expect(names(d.arrivals)).toEqual(expect.arrayContaining(['Samuel Njoroge', 'Lucy Wambui']));
    expect(names(d.departures)).toEqual(expect.arrayContaining(['Mercy Wanjiku', 'Faith Muthoni']));
    expect(names(d.inHouse)).toEqual(expect.arrayContaining(['Peter Kamau', 'Joseph Mutua']));
    expect(names(d.arrivalsRoomNotReady)).toEqual(['Lucy Wambui']);
    const requests = await owner.get<Array<{ status: string }>>('/properties/K1/guest-requests');
    expect(requests.map((r) => r.status).sort()).toEqual(['done', 'in_progress', 'open']);
  });

  it('marks demo bookings and keeps every booking status the guide talks about', async () => {
    const list = await owner.get<Array<{ statuses: string[] }>>(`/properties/K1/reservations?q=DEMO-${today}`);
    const statuses = new Set(list.flatMap((r) => r.statuses));
    for (const s of ['enquiry', 'hold', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show']) expect(statuses).toContain(s);
  });

  it('posted yesterday’s room night through the day close, with the room move and reversal on the same folio', async () => {
    const [res] = await owner.get<Array<{ id: string }>>('/properties/K1/reservations?q=Peter Kamau');
    const detail = await owner.get(`/properties/K1/reservations/${res.id}`);
    const stay = detail.stays[0];
    const folio = await owner.get(`/properties/K1/folios/${stay.folioId}`);
    const codes = folio.charges.map((c: { chargeCode: string }) => c.chargeCode);
    expect(codes.filter((c: string) => c === 'ROOM')).toHaveLength(1);
    expect(codes.filter((c: string) => c === 'MINIBAR')).toHaveLength(2); // the charge and its reversal
    expect(folio.charges.some((c: { posCheckId: string | null }) => c.posCheckId)).toBe(true); // POS room charge
    const moves = await owner.get(`/properties/K1/stays/${stay.id}/moves`);
    expect(moves).toHaveLength(1);
  });

  it('leaves open tables, kitchen tickets, a reviewed shift and a balanced Z report', async () => {
    const checks = await owner.get<Array<{ tableCode: string }>>('/properties/K1/pos/outlets/K1-COCKTAIL/checks?status=open');
    expect(checks.map((c) => c.tableCode)).toContain('T1');
    const kitchen = await owner.get<Array<{ status: string }>>('/properties/K1/pos/stations/KITCHEN/tickets');
    expect(kitchen.map((t) => t.status)).toEqual(expect.arrayContaining(['preparing', 'ready']));
    const shifts = await owner.get<Array<{ variance: string | null; reviewedBy: string | null; status: string }>>('/properties/K1/pos/shifts');
    expect(shifts).toEqual(expect.arrayContaining([expect.objectContaining({ variance: '-200.00', reviewedBy: 'K1 manager' }), expect.objectContaining({ status: 'open' })]));
    for (const [code, outlet] of [['K1', 'K1-SHOP'], ['SW', 'SW-SWIM'], ['KM', 'KM-POOL']]) {
      const days = await owner.get<Array<{ id: string; status: string }>>(`/properties/${code}/pos/outlets/${outlet}/days`);
      const z = await owner.get(`/properties/${code}/pos/days/${days[0].id}`);
      expect(z.status).toBe('closed');
      expect(z.totals.reconciliation.difference).toBe('0.00');
    }
    const sales = await owner.get(`/properties/K1/pos/reports/sales?from=${today}&to=${today}`);
    expect(sales.reconciliation.difference).toBe('0.00');
    expect(Number(sales.houseAccounts.total)).toBeGreaterThan(0);
  });

  it('adds the four loyalty demo members at each property with their opening balances', async () => {
    const loyalty = report.results.filter((r) => / member /.test(r.scenario));
    expect(loyalty).toHaveLength(12);
    const clubAtSw = (await owner.get<Array<{ number: string; points: { available: string }; wallet: { available: string }; club: unknown }>>(
      '/properties/SW/loyalty/members?q=%2B254755000505',
    ))[0];
    expect(clubAtSw).toMatchObject({ points: { available: '1000' }, wallet: { available: '5000.00' }, club: { tier: 'CLUB' } });
    const regular = (await owner.get<Array<{ points: { available: string } }>>('/properties/KM/loyalty/members?q=%2B254733000303'))[0];
    expect(regular.points.available).toBe('800');
  });

  it('does nothing when run again on the same date', async () => {
    const again = await runDemo({ apiUrl, password: process.env.SEED_PASSWORD!, today, log: () => undefined });
    // Loyalty members are found again by phone and left as they are.
    expect(again.results.filter((r) => !/already there/.test(r.detail))).toEqual([]);
    expect(again.skipped.map((s) => s.property)).toEqual(['K1', 'SW', 'KM']);
  });
});
