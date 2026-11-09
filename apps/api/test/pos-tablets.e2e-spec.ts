import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { login, ownerClient, startApp, uniqueKey } from './helpers';

/**
 * Fixes from the Kahama service-team meeting (9 Nov 2026):
 * - 2.2 a guest bill cannot be printed again unless it changed, or a manager approves (POS-10, SEC-02, SEC-04);
 * - 2.3 shared tablets: PIN sign-in by name on a registered tablet, PIN lockout,
 *   sessions tied to the tablet and its property (SEC-03).
 */
describe('Kahama POS fixes: bill reprint control and shared tablets', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const tokens: Record<string, string> = {};
  const USERS = ['km.waiter', 'km.manager', 'k1.waiter', 'k1.manager'];
  const KM = '/api/properties/KM';
  const POS = `${KM}/pos`;
  const MANAGER = { username: 'km.manager', password: process.env.SEED_PASSWORD! };
  let outlet = '';
  let water = '';
  let soda = '';

  const as = (token: string) => ({
    get: (path: string) => request(http).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}, key = uniqueKey()) =>
      request(http).post(path).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body),
    patch: (path: string, body: object) => request(http).patch(path).set('Authorization', `Bearer ${token}`).send(body),
  });
  const api = (user: string) => as(tokens[user]);
  const device = (token: string) => ({
    staff: () => request(http).get('/api/auth/pos-device').set('x-pos-device', token),
    pin: (userId: string, pin: string) => request(http).post('/api/auth/pin-login').set('x-pos-device', token).send({ userId, pin }),
  });

  const openCheck = async (user = 'km.waiter') => (await api(user).post(`${POS}/outlets/${outlet}/checks`, { serviceType: 'counter' }).expect(201)).body;
  const add = (checkId: string, portionId: string, user = 'km.waiter') =>
    api(user).post(`${POS}/checks/${checkId}/lines`, { lines: [{ portionId, quantity: '1' }] }).expect(200);

  beforeAll(async () => {
    app = await startApp();
    http = app.getHttpServer();
    for (const u of USERS) tokens[u] = await login(app, u);
    const owner = await ownerClient();
    try {
      await owner.query(`UPDATE properties SET current_business_date = (now() AT TIME ZONE 'Africa/Nairobi')::date WHERE code = 'KM'`);
      const { rows } = await owner.query<{ code: string }>(
        `SELECT o.code FROM outlets o JOIN outlet_menu_prices mp ON mp.outlet_id = o.id JOIN menu_items i ON i.id = mp.item_id
          WHERE o.property_id = (SELECT id FROM properties WHERE code = 'KM') AND o.pos_enabled AND o.is_active AND i.code = 'SD-WATER'
          ORDER BY o.code LIMIT 1`,
      );
      outlet = rows[0].code;
    } finally {
      await owner.end();
    }
    const menu = (await api('km.manager').get(`${POS}/outlets/${outlet}/menu`).expect(200)).body.items as Array<{ code: string; portionId: string; isAlcohol: boolean }>;
    water = menu.find((i) => i.code === 'SD-WATER')!.portionId;
    soda = menu.find((i) => i.code !== 'SD-WATER' && !i.isAlcohol)!.portionId;
  });

  afterAll(async () => {
    const owner = await ownerClient();
    try {
      await owner.query(
        `UPDATE pos_outlet_days SET status = 'closed', closed_at = now(), finalised_at = now(), totals = '{"test": true}'
          WHERE status = 'open' AND property_id = (SELECT id FROM properties WHERE code = 'KM')`,
      );
    } finally {
      await owner.end();
    }
    await app.close();
  });

  // ---------------------------------------------------------------------------
  describe('bill reprint control (meeting item 2.2)', () => {
    it('prints a bill once; an unchanged copy needs a reason and a manager; a changed bill prints freely', async () => {
      const check = await openCheck();
      await add(check.id, water);

      const first = await api('km.waiter').post(`${POS}/checks/${check.id}/print`).expect(200);
      expect(first.body).toMatchObject({ kind: 'bill', printNo: 1, changed: false });
      expect(first.body.html).toContain('BILL');
      expect(first.body.html).not.toContain('REPRINT');

      // Pressing print again with nothing new: refused.
      const again = await api('km.waiter').post(`${POS}/checks/${check.id}/print`).expect(409);
      expect(again.body).toMatchObject({ error: 'reprint_restricted', selfApprove: false, kind: 'bill' });
      // A reason alone is not enough for a waiter.
      const noManager = await api('km.waiter').post(`${POS}/checks/${check.id}/print`, { reason: 'Guest lost the bill' }).expect(403);
      expect(noManager.body.error).toBe('approval_required');
      // A waiter cannot approve with their own password.
      await api('km.waiter')
        .post(`${POS}/checks/${check.id}/print`, { reason: 'Guest lost the bill', approval: { username: 'km.waiter', password: process.env.SEED_PASSWORD } })
        .expect(403);
      const copy = await api('km.waiter').post(`${POS}/checks/${check.id}/print`, { reason: 'Guest lost the bill', approval: MANAGER }).expect(200);
      expect(copy.body).toMatchObject({ kind: 'bill', printNo: 2, changed: false });
      expect(copy.body.html).toContain('REPRINT #1');

      // A new item: the next print is an updated bill, no approval.
      await add(check.id, soda);
      const updated = await api('km.waiter').post(`${POS}/checks/${check.id}/print`).expect(200);
      expect(updated.body).toMatchObject({ printNo: 3, changed: true });
      expect(updated.body.html).toContain('UPDATED BILL');

      // A manager may approve their own copy but still gives a reason.
      const mgr = await api('km.manager').post(`${POS}/checks/${check.id}/print`).expect(409);
      expect(mgr.body.selfApprove).toBe(true);
      await api('km.manager').post(`${POS}/checks/${check.id}/print`, { reason: 'Printer jammed' }).expect(200);

      // Paid: the receipt prints once; a copy needs approval.
      const total = (await api('km.waiter').get(`${POS}/checks/${check.id}`).expect(200)).body.totals.total;
      await api('km.waiter').post(`${POS}/checks/${check.id}/payments`, { tenders: [{ tender: 'card', amount: total, reference: uniqueKey('AUTH') }] }).expect(200);
      const receipt = await api('km.waiter').post(`${POS}/checks/${check.id}/print`).expect(200);
      expect(receipt.body).toMatchObject({ kind: 'receipt', printNo: 1 });
      expect(receipt.body.html).toContain('RECEIPT');
      await api('km.waiter').post(`${POS}/checks/${check.id}/print`).expect(409);
      const receiptCopy = await api('km.waiter').post(`${POS}/checks/${check.id}/print`, { reason: 'Guest wants a copy', approval: MANAGER }).expect(200);
      expect(receiptCopy.body.html).toContain('REPRINT #1');

      // Every print is in the check history.
      const events = (await api('km.manager').get(`${POS}/checks/${check.id}/events`).expect(200)).body as Array<{ event: string }>;
      expect(events.filter((e) => e.event === 'bill_reprinted')).toHaveLength(3);
      expect(events.filter((e) => e.event === 'receipt_reprinted')).toHaveLength(1);

      // The manager's report lists copies apart from updated bills, with who approved.
      const today = (await api('km.manager').get(KM).expect(200)).body.currentBusinessDate;
      await api('km.waiter').get(`${POS}/reports/bill-reprints?from=${today}&to=${today}`).expect(403);
      const report = await api('km.manager').get(`${POS}/reports/bill-reprints?from=${today}&to=${today}`).expect(200);
      const mine = report.body.rows.filter((r: { checkNumber: string }) => r.checkNumber === check.number);
      expect(mine).toHaveLength(4);
      expect(mine.filter((r: { changed: boolean }) => !r.changed)).toHaveLength(3);
      expect(mine.find((r: { reason: string }) => r.reason === 'Guest lost the bill')).toMatchObject({ printedBy: 'Kahama waiter', approvedBy: 'Kahama manager' });
      expect(report.body.byUser.find((u: { printedBy: string }) => u.printedBy === 'Kahama waiter')).toMatchObject({ copies: 2, updated: 1 });
    });

    it('keeps bill prints append-only', async () => {
      const owner = await ownerClient();
      try {
        await expect(owner.query('UPDATE pos_bill_prints SET reason = $1', ['x'])).rejects.toThrow();
        await expect(owner.query('DELETE FROM pos_bill_prints')).rejects.toThrow();
      } finally {
        await owner.end();
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('shared tablets and PIN sign-in (meeting item 2.3)', () => {
    let deviceToken = '';
    let deviceId = '';
    let waiterId = '';

    it('only a manager registers a tablet; the token is shown once and staff appear once they set a PIN', async () => {
      await api('km.waiter').post(`${POS}/devices`, { name: 'Pool bar tablet' }).expect(403);
      const reg = await api('km.manager').post(`${POS}/devices`, { name: 'Pool bar tablet', idleSignoutSeconds: 90, signoutAfterSend: true }).expect(201);
      expect(reg.body).toMatchObject({ name: 'Pool bar tablet', idleSignoutSeconds: 90, signoutAfterSend: true });
      deviceToken = reg.body.token;
      deviceId = reg.body.id;
      expect(deviceToken.length).toBeGreaterThanOrEqual(40);
      const list = await api('km.manager').get(`${POS}/devices`).expect(200);
      expect(list.body.find((d: { id: string }) => d.id === deviceId).token).toBeUndefined();

      await device('not-a-real-device-token-not-a-real-device-token').staff().expect(401);
      const before = await device(deviceToken).staff().expect(200);
      expect(before.body.device).toMatchObject({ name: 'Pool bar tablet', propertyCode: 'KM', idleSignoutSeconds: 90, signoutAfterSend: true });
      expect(before.body.staff.map((s: { displayName: string }) => s.displayName)).not.toContain('Kahama waiter');

      waiterId = (await api('km.waiter').get('/api/auth/me').expect(200)).body.id;
      await api('km.waiter').post('/api/auth/pin', { currentPassword: 'wrong-password', pin: '4826' }).expect(401);
      expect((await api('km.waiter').post('/api/auth/pin', { currentPassword: process.env.SEED_PASSWORD, pin: '1234' }).expect(400)).body.error).toBe('pin_weak');
      await api('km.waiter').post('/api/auth/pin', { currentPassword: process.env.SEED_PASSWORD, pin: '7777' }).expect(400);
      await api('km.waiter').post('/api/auth/pin', { currentPassword: process.env.SEED_PASSWORD, pin: '4826' }).expect(200);

      const after = await device(deviceToken).staff().expect(200);
      expect(after.body.staff).toEqual(expect.arrayContaining([expect.objectContaining({ id: waiterId, displayName: 'Kahama waiter' })]));
      // Staff of another property never show on this tablet.
      await api('k1.waiter').post('/api/auth/pin', { currentPassword: process.env.SEED_PASSWORD, pin: '5193' }).expect(200);
      const k1Waiter = (await api('k1.waiter').get('/api/auth/me').expect(200)).body.id;
      expect(after.body.staff.map((s: { id: string }) => s.id)).not.toContain(k1Waiter);
      expect((await device(deviceToken).pin(k1Waiter, '5193').expect(401)).body.error).toBe('pin_invalid');

      const staff = await api('km.manager').get(`${POS}/staff-pins`).expect(200);
      expect(staff.body.find((s: { id: string }) => s.id === waiterId)).toMatchObject({ pinSet: true, pinLockedUntil: null });
    });

    it('a PIN session works only at the tablet’s property and records the tablet on bill prints', async () => {
      const res = await device(deviceToken).pin(waiterId, '4826').expect(200);
      expect(res.body).toMatchObject({ propertyCode: 'KM', user: { username: 'km.waiter' }, device: { id: deviceId } });
      const pinToken = res.body.accessToken as string;
      await as(pinToken).get(`${POS}/outlets`).expect(200);
      await as(pinToken).get('/api/properties/K1/pos/outlets').expect(403);
      // Without the tablet's token a PIN is useless.
      await request(http).post('/api/auth/pin-login').send({ userId: waiterId, pin: '4826' }).expect(401);

      const check = (await as(pinToken).post(`${POS}/outlets/${outlet}/checks`, { serviceType: 'counter' }).expect(201)).body;
      await as(pinToken).post(`${POS}/checks/${check.id}/lines`, { lines: [{ portionId: water, quantity: '1' }] }).expect(200);
      expect(check.waiter).toBe('Kahama waiter');
      await as(pinToken).post(`${POS}/checks/${check.id}/print`).expect(200);
      await as(pinToken).post(`${POS}/checks/${check.id}/print`, { reason: 'Guest asked again', approval: MANAGER }).expect(200);
      const today = (await api('km.manager').get(KM).expect(200)).body.currentBusinessDate;
      const report = await api('km.manager').get(`${POS}/reports/bill-reprints?from=${today}&to=${today}`).expect(200);
      expect(report.body.rows.find((r: { checkNumber: string }) => r.checkNumber === check.number)).toMatchObject({ device: 'Pool bar tablet' });
    });

    it('five wrong PINs lock the PIN; a manager clears it and the waiter sets a new one', async () => {
      for (let i = 0; i < 4; i++) expect((await device(deviceToken).pin(waiterId, '0000').expect(401)).body.message).toBe('Wrong PIN');
      expect((await device(deviceToken).pin(waiterId, '0000').expect(401)).body.message).toContain('locked');
      expect((await device(deviceToken).pin(waiterId, '4826').expect(423)).body.error).toBe('pin_locked');
      const staff = await api('km.manager').get(`${POS}/staff-pins`).expect(200);
      expect(staff.body.find((s: { id: string }) => s.id === waiterId).pinLockedUntil).not.toBeNull();

      await api('km.waiter').post(`${POS}/staff/${waiterId}/clear-pin`).expect(403);
      await api('km.manager').post(`${POS}/staff/${waiterId}/clear-pin`).expect(200);
      expect((await device(deviceToken).staff().expect(200)).body.staff.map((s: { id: string }) => s.id)).not.toContain(waiterId);
      await api('km.waiter').post('/api/auth/pin', { currentPassword: process.env.SEED_PASSWORD, pin: '3958' }).expect(200);
      await device(deviceToken).pin(waiterId, '3958').expect(200);
    });

    it('a manager changes the sign-out settings; unregistering the tablet ends its PIN sessions', async () => {
      const upd = await api('km.manager').patch(`${POS}/devices/${deviceId}`, { idleSignoutSeconds: 300, signoutAfterSend: false }).expect(200);
      expect(upd.body).toMatchObject({ idleSignoutSeconds: 300, signoutAfterSend: false });
      await api('km.manager').patch(`${POS}/devices/${deviceId}`, { idleSignoutSeconds: 5 }).expect(400);

      const pinToken = (await device(deviceToken).pin(waiterId, '3958').expect(200)).body.accessToken as string;
      await api('km.manager').post(`${POS}/devices/${deviceId}/revoke`).expect(200);
      expect((await as(pinToken).get(`${POS}/outlets`).expect(401)).body.error).toBe('device_revoked');
      await device(deviceToken).staff().expect(401);
      expect((await device(deviceToken).pin(waiterId, '3958').expect(401)).body.error).toBe('device_not_registered');
      // A password sign-in is not tied to a tablet and keeps working.
      await api('km.waiter').get(`${POS}/outlets`).expect(200);
    });
  });
});
