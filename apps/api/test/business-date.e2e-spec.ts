import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { addDays } from '@hotel/shared';
import { login, ownerClient, startApp, uniqueKey } from './helpers';

/**
 * The business date only moves when a manager closes the day. These checks
 * cover the overdue signal (expectedBusinessDate) and the refusal to close a
 * day that has not started yet. The app runs with ALLOW_FUTURE_DAY_CLOSE off,
 * as in production.
 */
describe('Business date catch-up and future-close guard', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const tokens: Record<string, string> = {};
  const KM = '/api/properties/KM';
  let original: string;
  let today: string;

  beforeAll(async () => {
    app = await startApp({ ALLOW_FUTURE_DAY_CLOSE: 'false' });
    http = app.getHttpServer();
    for (const u of ['owner', 'km.manager']) tokens[u] = await login(app, u);
    const o = await ownerClient();
    try {
      const { rows: [r] } = await o.query(
        `SELECT current_business_date::text AS d, (now() AT TIME ZONE timezone)::date::text AS today FROM properties WHERE code = 'KM'`,
      );
      original = r.d;
      today = r.today;
    } finally {
      await o.end();
    }
  });

  const setDate = async (d: string) => {
    const o = await ownerClient();
    try {
      await o.query(`UPDATE properties SET current_business_date = $1 WHERE code = 'KM'`, [d]);
    } finally {
      await o.end();
    }
  };

  afterAll(async () => {
    await setDate(original);
    await app.close();
  });

  const get = (path: string) => request(http).get(path).set('Authorization', `Bearer ${tokens.owner}`);
  const closeDay = (businessDate: string) =>
    request(http).post(`${KM}/front-desk/close-day`).set('Authorization', `Bearer ${tokens['km.manager']}`)
      .set('Idempotency-Key', uniqueKey()).send({ businessDate });

  it('reports the business date the clock expects, less the cut-off', async () => {
    const p = (await get(KM).expect(200)).body;
    expect(p.expectedBusinessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // With an 08:00 cut-off the expected date is today or, before 08:00, yesterday.
    expect([today, addDays(today, -1)]).toContain(p.expectedBusinessDate);
  });

  it('refuses to close a day that has not started yet', async () => {
    await setDate(addDays(today, 1));
    const res = await closeDay(addDays(today, 1)).expect(409);
    expect(res.body.error).toBe('business_date_in_future');
    const p = (await get(KM).expect(200)).body;
    expect(p.currentBusinessDate).toBe(addDays(today, 1));
  });

  it('lets a manager close past days one at a time to catch up', async () => {
    await setDate(addDays(today, -2));
    const behind = (await get(KM).expect(200)).body;
    expect(behind.expectedBusinessDate > behind.currentBusinessDate).toBe(true);
    await closeDay(addDays(today, -2)).expect(200);
    await closeDay(addDays(today, -1)).expect(200);
    const caughtUp = (await get(KM).expect(200)).body;
    expect(caughtUp.currentBusinessDate).toBe(today);
  });
});
