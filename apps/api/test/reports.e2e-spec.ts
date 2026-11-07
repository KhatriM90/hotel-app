import { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { Client } from 'pg';
import request from 'supertest';
import { addDays } from '@hotel/shared';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { runMigrations } from '../src/db/migrate';
import { seed } from '../src/seed';
import { nairobiToday, runDemo } from '../src/seed-demo';

/**
 * Reports and downloads (RPT-02, RPT-03, RPT-04, RPT-06, RPT-07, RPT-08,
 * AT-16, AT-18) on the demo data, in a database of their own. The demo starts
 * the day before today, so yesterday is a closed business day with posted
 * room nights, paid bills, a Z report and cash shifts.
 */
describe('reports', () => {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
  const ownerUrl = Object.assign(new URL(adminUrl), { pathname: '/hotel_api_reports' }).toString();
  const appUrl = Object.assign(new URL(ownerUrl), { username: 'hotel_app', password: 'hotel_app_test_pw' }).toString();
  const today = nairobiToday();
  const yesterday = addDays(today, -1);
  let app: INestApplication;
  const tokens: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const get = (user: string, path: string) => http().get(`/api${path}`).set('authorization', `Bearer ${tokens[user]}`);
  /** Supertest leaves binary bodies unparsed unless asked. */
  const download = (user: string, path: string) =>
    get(user, path).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS hotel_api_reports WITH (FORCE)');
    await admin.query('CREATE DATABASE hotel_api_reports');
    await admin.end();
    await runMigrations({ connectionString: ownerUrl, appRolePassword: 'hotel_app_test_pw', log: () => undefined });
    await seed(ownerUrl, process.env.SEED_PASSWORD!);
    const db = new Client({ connectionString: ownerUrl });
    await db.connect();
    await db.query(`UPDATE properties SET current_business_date = $1`, [yesterday]);
    await db.end();

    app = await createApp(loadConfig({ ...process.env, DATABASE_URL: appUrl }));
    await app.listen(0, '127.0.0.1');
    const apiUrl = `${await app.getUrl()}/api`.replace('[::1]', '127.0.0.1');
    const demo = await runDemo({ apiUrl, password: process.env.SEED_PASSWORD!, today, log: () => undefined });
    expect(demo.results.filter((r) => !r.ok)).toEqual([]);
    for (const u of ['owner', 'k1.manager', 'km.manager', 'k1.waiter', 'k1.reception']) {
      const res = await http().post('/api/auth/login').send({ username: u, password: process.env.SEED_PASSWORD });
      tokens[u] = res.body.accessToken;
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  describe('hotel report (RPT-02)', () => {
    it('counts yesterday’s posted room nights and derives occupancy, ADR and RevPAR from them', async () => {
      const res = await get('k1.manager', `/properties/K1/reports/hotel?from=${yesterday}&to=${today}`).expect(200);
      const [y, t] = res.body.days;
      expect(y.date).toBe(yesterday);
      expect(y.closed).toBe(true);
      expect(t.closed).toBe(false);
      expect(t.occupiedRooms).toBe(0); // tonight is not posted until the day closes
      expect(y.occupiedRooms).toBeGreaterThan(0);
      expect(y.availableRooms).toBeLessThanOrEqual(22);
      expect(y.roomsSold).toBe(y.occupiedRooms - y.compRooms);
      // Ratios, recomputed from the parts.
      expect(Number(y.occupancy)).toBeCloseTo((y.occupiedRooms / y.availableRooms) * 100, 2);
      expect(Number(y.adr)).toBeCloseTo(Number(y.roomRevenue) / y.roomsSold, 2);
      expect(Number(y.revpar)).toBeCloseTo(Number(y.roomRevenue) / y.availableRooms, 2);
      // Room revenue equals the room charges on the folios for that night, net of tax.
      const db = new Client({ connectionString: ownerUrl });
      await db.connect();
      const { rows: [f] } = await db.query(
        `SELECT coalesce(sum(net_amount), 0)::numeric(18,2)::text AS net FROM folio_charges fc JOIN properties p ON p.id = fc.property_id
          WHERE p.code = 'K1' AND fc.charge_code = 'ROOM' AND fc.room_night_date = $1
            AND NOT EXISTS (SELECT 1 FROM folio_charges r WHERE r.reversal_of = fc.id)`,
        [yesterday],
      );
      await db.end();
      expect(y.roomRevenue).toBe(f.net);
      expect(res.body.totals.occupiedRooms).toBe(y.occupiedRooms);
      expect(res.body.definitions.length).toBeGreaterThan(2);
    });

    it('lists cancellations and no-shows', async () => {
      const res = await get('owner', `/properties/K1/reports/hotel?from=${addDays(today, -30)}&to=${addDays(today, 30)}`).expect(200);
      const cancelled = res.body.days.reduce((a: number, d: { cancellations: number }) => a + d.cancellations, 0);
      expect(res.body.cancellations).toHaveLength(cancelled);
      for (const c of res.body.cancellations) expect(c.stayNumber).toMatch(/^K1-ST-/);
    });

    it('refuses a period longer than a year or backwards', async () => {
      await get('owner', `/properties/K1/reports/hotel?from=${today}&to=${yesterday}`).expect(400);
      await get('owner', `/properties/K1/reports/hotel?from=2025-01-01&to=2026-06-01`).expect(400);
    });
  });

  describe('downloads (RPT-06)', () => {
    it('sends the POS sales report as CSV that Excel can read, with every product and the same totals as the screen', async () => {
      const screen = await get('k1.manager', `/properties/K1/pos/reports/sales?from=${yesterday}&to=${today}`).expect(200);
      const res = await download('k1.manager', `/properties/K1/reports/pos-sales/export?from=${yesterday}&to=${today}&format=csv`).expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="K1-pos-sales-${yesterday}_${today}.csv"`);
      const text = (res.body as Buffer).toString('utf8');
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(text).toContain('K1 Klubhouse');
      expect(text).toContain(`Net sales (incl. tax),${screen.body.netSales}`);
      expect(text).toContain('By product');
      expect(screen.body.byItem.length).toBeGreaterThan(0);
      for (const item of screen.body.byItem.slice(0, 3)) expect(text).toContain(item.amount);
    });

    it('sends the same report as a PDF', async () => {
      const res = await download('k1.manager', `/properties/K1/reports/pos-sales/export?from=${yesterday}&to=${today}&format=pdf`).expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect((res.body as Buffer).length).toBeGreaterThan(2000);
    });

    it('exports the Z report, cash shifts and hotel report in both formats', async () => {
      const days = await get('owner', `/properties/K1/pos/outlets/K1-COCKTAIL/days`).expect(200);
      const shifts = await get('owner', `/properties/K1/reports/cash-shifts?from=${yesterday}&to=${today}`).expect(200);
      expect(shifts.body.length).toBeGreaterThan(0);
      for (const format of ['csv', 'pdf']) {
        await download('owner', `/properties/K1/reports/pos-days/${days.body[0].id}/export?format=${format}`).expect(200);
        await download('owner', `/properties/K1/reports/cash-shifts/export?from=${yesterday}&to=${today}&format=${format}`).expect(200);
        await download('owner', `/properties/K1/reports/hotel/export?from=${yesterday}&to=${today}&format=${format}`).expect(200);
      }
      const csv = await download('owner', `/properties/K1/reports/cash-shifts/export?from=${yesterday}&to=${today}&format=csv`).expect(200);
      expect((csv.body as Buffer).toString()).toContain(shifts.body[0].number);
    });

    it('refuses an unknown format and records each export in the audit log (SEC-04)', async () => {
      await get('k1.manager', `/properties/K1/reports/hotel/export?from=${yesterday}&to=${yesterday}&format=xls`).expect(400);
      const db = new Client({ connectionString: ownerUrl });
      await db.connect();
      const { rows } = await db.query(
        `SELECT new_values FROM audit_events e JOIN users u ON u.id = e.actor_user_id
          WHERE e.action = 'report.export' AND u.username = 'k1.manager' ORDER BY e.id`,
      );
      await db.end();
      expect(rows.map((r) => r.new_values.report)).toEqual(expect.arrayContaining(['pos-sales']));
      expect(rows[0].new_values.format).toBe('csv');
    });
  });

  describe('permissions and property scope (SEC-01, AT-18)', () => {
    it('keeps reports from a waiter and a receptionist', async () => {
      await get('k1.waiter', `/properties/K1/reports/hotel?from=${yesterday}&to=${yesterday}`).expect(403);
      await get('k1.waiter', `/properties/K1/reports/pos-sales/export?from=${yesterday}&to=${yesterday}&format=csv`).expect(403);
      await get('k1.reception', `/reports/flash?date=${yesterday}`).expect(403);
    });

    it('does not let the Kahama manager download K1 figures', async () => {
      await get('km.manager', `/properties/K1/reports/hotel/export?from=${yesterday}&to=${yesterday}&format=csv`).expect(403);
      await get('km.manager', `/properties/K1/reports/pos-sales/export?from=${yesterday}&to=${yesterday}&format=pdf`).expect(403);
    });
  });

  describe('daily flash (RPT-07, RPT-08)', () => {
    it('shows one property’s day from the same figures as the hotel and POS reports', async () => {
      const flash = await get('k1.manager', `/properties/K1/reports/flash?date=${yesterday}`).expect(200);
      const hotel = await get('k1.manager', `/properties/K1/reports/hotel?from=${yesterday}&to=${yesterday}`).expect(200);
      const sales = await get('k1.manager', `/properties/K1/pos/reports/sales?from=${yesterday}&to=${yesterday}`).expect(200);
      expect(flash.body.dayClosed).toBe(true);
      expect(flash.body.rooms.occupancy).toBe(hotel.body.days[0].occupancy);
      expect(flash.body.revenue.rooms).toBe(hotel.body.days[0].roomRevenue);
      expect(flash.body.revenue.posNetSales).toBe(sales.body.netSales);
      expect(flash.body.cash.byTender.length).toBeGreaterThan(0);
    });

    it('consolidates the group: the group column is the sum of the properties (AT-18)', async () => {
      const res = await get('owner', `/reports/flash?date=${yesterday}`).expect(200);
      const ps = res.body.properties as Array<{ code: string; rooms: { occupiedRooms: number; roomRevenue: string }; revenue: { posNetSales: string }; cash: { total: string } }>;
      expect(ps.map((p) => p.code).sort()).toEqual(['K1', 'KM', 'SW']);
      const cents = (xs: string[]) => xs.reduce((a, x) => a + Math.round(Number(x) * 100), 0);
      expect(res.body.group.occupiedRooms).toBe(ps.reduce((a, p) => a + p.rooms.occupiedRooms, 0));
      expect(Math.round(Number(res.body.group.roomRevenue) * 100)).toBe(cents(ps.map((p) => p.rooms.roomRevenue)));
      expect(Math.round(Number(res.body.group.posNetSales) * 100)).toBe(cents(ps.map((p) => p.revenue.posNetSales)));
      expect(Math.round(Number(res.body.group.cash) * 100)).toBe(cents(ps.map((p) => p.cash.total)));
    });

    it('shows a property manager only their own property in the group view', async () => {
      const res = await get('km.manager', `/reports/flash?date=${yesterday}`).expect(200);
      expect(res.body.properties.map((p: { code: string }) => p.code)).toEqual(['KM']);
    });

    it('downloads the consolidated flash as PDF and CSV', async () => {
      const pdf = await download('owner', `/reports/flash/export?date=${yesterday}&format=pdf`).expect(200);
      expect(pdf.headers['content-disposition']).toBe(`attachment; filename="GROUP-flash-${yesterday}.pdf"`);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      const csv = await download('owner', `/reports/flash/export?date=${yesterday}&format=csv`).expect(200);
      const text = (csv.body as Buffer).toString();
      expect(text).toContain('All properties');
      expect(text).toContain('Measure,K1 Klubhouse');
      expect(text).toContain(',Group');
    });
  });
  describe('report catalogue (RPT-04, RPT-06)', () => {
    const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const sheetOf = async (body: Buffer) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(body as unknown as ArrayBuffer);
      return wb.worksheets[0];
    };
    /** Finds the header row of the first table: the row whose first cell is `label`. */
    const headerRow = (ws: ExcelJS.Worksheet, label: string) => {
      for (let r = 1; r <= ws.rowCount; r++) if (ws.getCell(r, 1).value === label) return r;
      throw new Error(`no ${label} header`);
    };

    it('lists focused reports by area, only those the user may download', async () => {
      const res = await get('k1.manager', '/properties/K1/reports/catalog').expect(200);
      const names = res.body.map((e: { name: string }) => e.name);
      expect(names).toEqual(expect.arrayContaining(['room-sales', 'daily-flash', 'pos-products', 'pos-discounts', 'cash-shifts', 'money-received', 'guest-ledger', 'deposits-held']));
      expect(new Set(res.body.map((e: { area: string }) => e.area))).toEqual(new Set(['hotel', 'pos', 'money']));
      expect(res.body[0].build).toBeUndefined();
      await get('k1.waiter', '/properties/K1/reports/catalog').expect(403);
    });

    it('downloads every report as an Excel workbook with the property, title and period on top', async () => {
      const list = await get('k1.manager', '/properties/K1/reports/catalog').expect(200);
      for (const e of list.body as Array<{ name: string; title: string }>) {
        const res = await download('k1.manager', `/properties/K1/reports/catalog/${e.name}/export?from=${yesterday}&to=${yesterday}`).expect(200);
        expect(res.headers['content-type']).toBe(XLSX);
        expect(res.headers['content-disposition']).toMatch(new RegExp(`^attachment; filename="K1-${e.name}-.+\\.xlsx"$`));
        const ws = await sheetOf(res.body);
        expect(ws.getCell('A1').value).toBe('K1 Klubhouse');
        expect(String(ws.getCell('A2').value)).not.toBe('');
      }
    }, 60_000);

    it('keeps numbers as numbers in Excel: occupancy is a percentage, revenue an amount', async () => {
      const hotel = await get('k1.manager', `/properties/K1/reports/hotel?from=${yesterday}&to=${yesterday}`).expect(200);
      const res = await download('k1.manager', `/properties/K1/reports/catalog/room-sales/export?from=${yesterday}&to=${yesterday}`).expect(200);
      const ws = await sheetOf(res.body);
      const h = headerRow(ws, 'Date');
      const labels = (ws.getRow(h).values as unknown[]).slice(1);
      const col = (label: string) => labels.indexOf(label) + 1;
      const day = ws.getRow(h + 1);
      expect(day.getCell(col('Occupancy')).value).toBeCloseTo(Number(hotel.body.days[0].occupancy) / 100, 6);
      expect(day.getCell(col('Occupancy')).numFmt).toBe('0.0%');
      expect(day.getCell(col('Room revenue (net)')).value).toBe(Number(hotel.body.days[0].roomRevenue));
      expect(day.getCell(col('Room revenue (net)')).numFmt).toBe('#,##0.00');
      expect(day.getCell(1).value).toBeInstanceOf(Date);
      expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: h });
    });

    it('money received for a day matches the flash report', async () => {
      const flash = await get('k1.manager', `/properties/K1/reports/flash?date=${yesterday}`).expect(200);
      const res = await download('k1.manager', `/properties/K1/reports/catalog/money-received/export?from=${yesterday}&to=${yesterday}&format=csv`).expect(200);
      const lines = (res.body as Buffer).toString().split('\r\n');
      const total = lines.find((l) => l.startsWith('Total,'));
      expect(total?.split(',').pop()).toBe(flash.body.cash.total);
    });

    it('guest ledger balances match the folios, and deposits held are unapplied deposits', async () => {
      const db = new Client({ connectionString: ownerUrl });
      await db.connect();
      const { rows: [want] } = await db.query(
        `SELECT coalesce(sum(b.balance), 0)::numeric(18,2)::text AS balance, count(*)::int AS n
           FROM folios f JOIN folio_balances b ON b.folio_id = f.id JOIN properties p ON p.id = f.property_id
          WHERE p.code = 'K1' AND (f.status = 'open' OR b.balance <> 0)
            AND (b.charges_total <> 0 OR b.payments_confirmed <> 0 OR b.payments_pending <> 0)`,
      );
      const { rows: [dep] } = await db.query(
        `SELECT coalesce(sum(amount), 0)::numeric(18,2)::text AS amount, count(*)::int AS n FROM folio_payments fp JOIN properties p ON p.id = fp.property_id
          WHERE p.code = 'K1' AND status = 'confirmed' AND is_deposit AND deposit_applied_at IS NULL`,
      );
      await db.end();
      const ledger = await download('k1.manager', '/properties/K1/reports/catalog/guest-ledger/export?format=csv').expect(200);
      const text = (ledger.body as Buffer).toString();
      expect(ledger.headers['content-disposition']).toMatch(/^attachment; filename="K1-guest-ledger-As-at-\d{4}-\d{2}-\d{2}\.csv"$/);
      if (want.n > 0) expect(text.split('\r\n').find((l) => l.startsWith(`Folios: ${want.n},`))?.split(',').pop()).toBe(want.balance);
      else expect(text).toContain('Guest ledger');
      const deposits = await download('k1.manager', '/properties/K1/reports/catalog/deposits-held/export?format=csv').expect(200);
      const dtext = (deposits.body as Buffer).toString();
      if (dep.n > 0) expect(dtext.split('\r\n').find((l) => l.startsWith(`Deposits: ${dep.n},`))?.split(',').pop()).toBe(dep.amount);
    });

    it('lists every discounted and complimentary line, filtered by outlet, also as PDF', async () => {
      const db = new Client({ connectionString: ownerUrl });
      await db.connect();
      const { rows: [want] } = await db.query(
        `SELECT count(*)::int AS n FROM pos_check_lines l JOIN pos_checks c ON c.id = l.check_id JOIN properties p ON p.id = c.property_id
          WHERE p.code = 'K1' AND c.status = 'closed' AND c.business_date = $1 AND l.status NOT IN ('cancelled', 'wasted')
            AND (l.discount_amount > 0 OR l.rule_discount > 0 OR l.is_comp)`,
        [yesterday],
      );
      await db.end();
      const csv = await download('k1.manager', `/properties/K1/reports/catalog/pos-discounts/export?from=${yesterday}&to=${yesterday}&format=csv`).expect(200);
      const text = (csv.body as Buffer).toString();
      if (want.n > 0) expect(text).toContain(`Lines: ${want.n},`);
      else expect(text).toContain('Discounts and complimentaries');
      const pdf = await download('k1.manager', `/properties/K1/reports/catalog/pos-discounts/export?from=${yesterday}&to=${yesterday}&format=pdf`).expect(200);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      await get('k1.manager', `/properties/K1/reports/catalog/pos-discounts/export?from=${yesterday}&to=${yesterday}&outlet=NOPE`).expect(400);
    });

    it('refuses unknown reports, missing dates and other properties', async () => {
      await get('k1.manager', `/properties/K1/reports/catalog/nope/export?from=${yesterday}&to=${yesterday}`).expect(404);
      await get('k1.manager', '/properties/K1/reports/catalog/room-sales/export').expect(400);
      await get('k1.manager', `/properties/K1/reports/catalog/room-sales/export?from=${today}&to=${yesterday}`).expect(400);
      await get('km.manager', `/properties/K1/reports/catalog/guest-ledger/export`).expect(403);
      await get('k1.waiter', `/properties/K1/reports/catalog/pos-products/export?from=${yesterday}&to=${yesterday}`).expect(403);
    });

    it('shows the user their own recent downloads, newest first', async () => {
      const res = await get('k1.manager', '/properties/K1/reports/recent').expect(200);
      expect(res.body.length).toBeGreaterThan(3);
      expect(res.body[0].report).toBe('pos-discounts');
      expect(res.body[0].format).toBe('pdf');
      expect(res.body[0].file).toMatch(/^K1-/);
      const owner = await get('owner', '/properties/K1/reports/recent').expect(200);
      expect(owner.body.every((r: { file: string }) => !r.file.startsWith('K1-pos-discounts'))).toBe(true);
    });
  });
});
