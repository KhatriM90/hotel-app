import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { addDays, DEFAULT_LOYALTY_SETTINGS } from '@hotel/shared';
import { login, ownerClient, startApp, uniqueKey } from './helpers';

/**
 * Loyalty and club membership end to end (addendum v1.2). Acceptance tests
 * LAT01, LAT02, LAT05, LAT06, LAT08, LAT10, LAT11, LAT14, LAT15, LAT16 and
 * CAT01, CAT02, CAT05, CAT07, CAT08, CAT11, CAT12 run against PostgreSQL
 * through the same routes the tablets and back office use. Test dishes are
 * priced at 1.18 × a round amount, so eligible spend (before VAT 16% and
 * catering levy 2%) matches the addendum's examples exactly.
 */
describe('Loyalty and club (LOY, CLUB, LAT, CAT)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const tokens: Record<string, string> = {};
  const USERS = ['owner', 'group.accounts', 'k1.manager', 'k1.waiter', 'k1.cashier', 'k1.reception', 'km.waiter', 'km.manager', 'sw.manager', 'sw.reception', 'sw.waiter'];
  const K1 = '/api/properties/K1';
  const MANAGER = { username: 'k1.manager', password: process.env.SEED_PASSWORD! };
  const SW_MANAGER = { username: 'sw.manager', password: process.env.SEED_PASSWORD! };

  const api = (user: string) => ({
    get: (path: string) => request(http).get(path).set('Authorization', `Bearer ${tokens[user]}`),
    post: (path: string, body: object = {}, key = uniqueKey()) =>
      request(http).post(path).set('Authorization', `Bearer ${tokens[user]}`).set('Idempotency-Key', key).send(body),
    put: (path: string, body: object, key = uniqueKey()) =>
      request(http).put(path).set('Authorization', `Bearer ${tokens[user]}`).set('Idempotency-Key', key).send(body),
  });

  let phoneSeq = 0;
  const enrol = async (property = 'K1', user = 'k1.waiter', extra: Record<string, unknown> = {}) => {
    phoneSeq++;
    const res = await api(user)
      .post(`/api/properties/${property}/loyalty/members`, {
        firstName: 'Test', lastName: `Member${phoneSeq}`, phone: `+2547119${String(10000 + phoneSeq)}`, adultConfirmed: true, programmeAccepted: true,
        channel: user.includes('reception') ? 'reception' : 'pos', ...extra,
      })
      .expect(201);
    return res.body as { id: string; number: string };
  };
  const adjust = (memberId: string, unit: 'points' | 'wallet', amount: string, property = 'K1', user = 'k1.manager') =>
    api(user).post(`/api/properties/${property}/loyalty/members/${memberId}/adjust`, { unit, amount, reason: 'Opening balance for test' }).expect(201);
  const member = async (memberId: string) => (await api('k1.manager').get(`${K1}/loyalty/members/${memberId}`).expect(200)).body;
  const points = async (memberId: string) => Number((await member(memberId)).points.available);
  const wallet = async (memberId: string) => (await member(memberId)).wallet.available as string;

  const menus = new Map<string, Array<{ portionId: string; code: string; portionCode: string }>>();
  const portion = async (property: string, outlet: string, code: string) => {
    if (!menus.has(outlet)) menus.set(outlet, (await api('owner').get(`/api/properties/${property}/pos/outlets/${outlet}/menu`).expect(200)).body.items);
    const found = menus.get(outlet)!.find((i) => i.code === code);
    if (!found) throw new Error(`${code} not on ${outlet}`);
    return found.portionId;
  };
  /** An open bill with the given test dishes. */
  const bill = async (codes: string[], opts: { property?: string; outlet?: string; user?: string; stayId?: string } = {}) => {
    const property = opts.property ?? 'K1';
    const outlet = opts.outlet ?? 'K1-KOFFEE';
    const user = opts.user ?? 'k1.waiter';
    const check = (await api(user).post(`/api/properties/${property}/pos/outlets/${outlet}/checks`, { serviceType: 'counter', stayId: opts.stayId ?? null }).expect(201)).body;
    const lines = [];
    for (const c of codes) lines.push({ portionId: await portion(property, outlet, c), quantity: '1' });
    const res = await api(user).post(`/api/properties/${property}/pos/checks/${check.id}/lines`, { lines }).expect(200);
    return res.body as { id: string; number: string; totals: { total: string }; lines: Array<{ id: string; name: string; amount: string }> };
  };
  const attach = (checkId: string, memberId: string | null, property = 'K1', user = 'k1.waiter') =>
    api(user).put(`/api/properties/${property}/pos/checks/${checkId}/loyalty/member`, { memberId }).expect(200);
  const verify = async (memberId: string, checkId: string, property = 'K1', user = 'k1.waiter') => {
    const otp = (await api(user).post(`/api/properties/${property}/loyalty/members/${memberId}/otp`, { purpose: 'redeem', checkId }).expect(201)).body;
    expect(otp.demoCode).toMatch(/^\d{6}$/);
    const ok = (await api(user).post(`/api/properties/${property}/loyalty/verifications/${otp.verificationId}/verify`, { code: otp.demoCode }).expect(200)).body;
    expect(ok.verified).toBe(true);
    return otp.verificationId as string;
  };
  const redeem = (checkId: string, body: Record<string, unknown>, property = 'K1', user = 'k1.waiter') =>
    api(user).post(`/api/properties/${property}/pos/checks/${checkId}/loyalty/rewards`, body);
  const payCard = (checkId: string, amount: string, property = 'K1', user = 'k1.waiter', key = uniqueKey(), reference = uniqueKey('AUTH').slice(0, 20)) =>
    api(user).post(`/api/properties/${property}/pos/checks/${checkId}/payments`, { tenders: [{ tender: 'card', amount, reference }] }, key);
  const check = async (checkId: string, property = 'K1') => (await api('owner').get(`/api/properties/${property}/pos/checks/${checkId}`).expect(200)).body;
  const newVersion = async (patch: (s: typeof DEFAULT_LOYALTY_SETTINGS) => void, note: string) => {
    const current = (await api('owner').get('/api/loyalty/programme').expect(200)).body.current.settings;
    const settings = JSON.parse(JSON.stringify(current));
    patch(settings);
    const res = await api('owner').post('/api/loyalty/programme/versions', { settings, note });
    if (res.status !== 201) throw new Error(`programme version: ${res.status} ${JSON.stringify(res.body)}`);
    // A version takes effect from the moment it is saved; wait a tick so "now" is past it.
    await new Promise((r) => setTimeout(r, 20));
  };

  beforeAll(async () => {
    app = await startApp();
    http = app.getHttpServer();
    for (const u of USERS) tokens[u] = await login(app, u);
    const owner = await ownerClient();
    try {
      await owner.query(`UPDATE properties SET current_business_date = (now() AT TIME ZONE 'Africa/Nairobi')::date`);
      await owner.query(`UPDATE rooms SET hk_status = 'clean'`);
    } finally {
      await owner.end();
    }
  });

  afterAll(async () => {
    const owner = await ownerClient();
    try {
      await owner.query(
        `UPDATE pos_outlet_days SET status = 'closed', closed_at = now(), finalised_at = now(), totals = '{"test": true}' WHERE status = 'open'`,
      );
    } finally {
      await owner.end();
    }
    await app.close();
  });

  // ---------------------------------------------------------------------------
  describe('members (LOY11, LOY15, LOY24)', () => {
    it('enrols at the till; POS staff see a masked summary, reception the full profile and card', async () => {
      const m = await enrol();
      expect(m.number).toMatch(/^YS\d{6}$/);
      const pos = (await api('k1.waiter').get(`${K1}/loyalty/members?q=${m.number}`).expect(200)).body[0];
      expect(pos.name).toMatch(/^Test M\.$/);
      expect(pos.phone).toMatch(/•/);
      const full = (await api('k1.reception').get(`${K1}/loyalty/members/${m.id}`).expect(200)).body;
      expect(full.profile.enrolmentChannel).toBe('pos');
      expect(full.card.qr).toMatch(new RegExp(`^YS:${m.number}:`));
      const card = await api('k1.reception').get(`${K1}/loyalty/members/${m.id}/card`).expect(200);
      expect(card.text).toContain('<svg');
      const self = await request(http).get(full.selfServicePath).expect(200);
      expect(self.text).toContain(m.number);
    });

    it('refuses under-18s and warns about a duplicate phone', async () => {
      await api('k1.waiter')
        .post(`${K1}/loyalty/members`, { firstName: 'Kid', lastName: 'Test', phone: '+254711999001', adultConfirmed: false, programmeAccepted: true, channel: 'pos' })
        .expect(400);
      const m = await enrol();
      const again = (await member(m.id)).phone;
      const dup = await api('k1.waiter')
        .post(`${K1}/loyalty/members`, { firstName: 'Other', lastName: 'Person', phone: again, adultConfirmed: true, programmeAccepted: true, channel: 'pos' })
        .expect(409);
      expect(dup.body.error).toBe('possible_duplicate');
    });
  });

  // ---------------------------------------------------------------------------
  describe('earning and redemption (LAT01, LAT02, LAT06, LAT15)', () => {
    it('LAT01: KES 5,000 eligible earns 50 points once; replaying settlement changes nothing', async () => {
      const m = await enrol();
      const b = await bill(['LY-PLATTER']);
      expect(b.totals.total).toBe('5900.00');
      const preview = (await attach(b.id, m.id)).body;
      expect(preview.eligible.beforeRewards).toBe('5000.00');
      expect(preview.earnPreview.points).toBe(50);
      const key = uniqueKey();
      const ref = uniqueKey('AUTH').slice(0, 20);
      await payCard(b.id, '5900.00', 'K1', 'k1.waiter', key, ref).expect(200);
      await payCard(b.id, '5900.00', 'K1', 'k1.waiter', key, ref).expect(200);
      expect(await points(m.id)).toBe(50);
      const c = await check(b.id);
      expect(c.loyalty).toMatchObject({ final: true, pointsEarned: 50, closingPoints: 50 });
      const receipt = await api('k1.waiter').get(`${K1}/pos/checks/${b.id}/print`).expect(200);
      expect(receipt.text).toContain('Points earned');
    });

    it('LAT02: 800 points on a KES 5,000 bill leaves KES 4,200 eligible and 42 closing points; verification is required', async () => {
      const m = await enrol();
      await adjust(m.id, 'points', '800');
      const b = await bill(['LY-PLATTER']);
      await attach(b.id, m.id);
      const unverified = await redeem(b.id, { points: 800, verificationId: '00000000-0000-4000-8000-000000000000' }).expect(409);
      expect(unverified.body.error).toBe('verification_required');
      const v = await verify(m.id, b.id);
      const tooMany = await redeem(b.id, { points: 1001, verificationId: v }).expect(409);
      expect(tooMany.body.error).toBe('redeem_limit');
      const applied = (await redeem(b.id, { points: 800, verificationId: v }).expect(200)).body;
      expect(applied.applied.points).toBe(800);
      expect(applied.eligible.afterRewards).toBe('4200.00');
      expect((await check(b.id)).totals.total).toBe('4956.00'); // 4,200 + VAT and levy
      await payCard(b.id, '4956.00').expect(200);
      expect(await points(m.id)).toBe(42);
    });

    it('LAT06: two tills cannot spend the same 800 points', async () => {
      const m = await enrol();
      await adjust(m.id, 'points', '800');
      const a = await bill(['LY-PLATTER']);
      const b = await bill(['LY-PLATTER'], { user: 'k1.cashier' });
      await attach(a.id, m.id);
      await attach(b.id, m.id, 'K1', 'k1.cashier');
      const va = await verify(m.id, a.id);
      const vb = await verify(m.id, b.id, 'K1', 'k1.cashier');
      const results = await Promise.all([
        redeem(a.id, { points: 800, verificationId: va }),
        redeem(b.id, { points: 800, verificationId: vb }, 'K1', 'k1.cashier'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const reserved = Number((await member(m.id)).points.reserved);
      expect(reserved).toBe(800);
    });

    it('LAT15: a flagged staff member earns nothing on a bill they serve; it shows in the exception report', async () => {
      const m = await enrol('K1', 'k1.reception');
      await api('k1.manager').post(`${K1}/loyalty/members/${m.id}/staff`, { username: 'k1.waiter', reason: 'K1 waiter staff account' }).expect(201);
      const b = await bill(['LY-PLATTER']);
      const p = (await attach(b.id, m.id)).body;
      expect(p.earnPreview.points).toBe(0);
      await payCard(b.id, '5900.00').expect(200);
      expect(await points(m.id)).toBe(0);
      const ex = (await api('owner').get('/api/loyalty/reports/exceptions').expect(200)).body;
      expect(ex.staffOwn.map((r: { number: string }) => r.number)).toContain(m.number);
    });
  });

  // ---------------------------------------------------------------------------
  describe('returns (LAT05, CAT08)', () => {
    it('LAT05 partial: returning the KES 2,000 item refunds 1,680 + tax and leaves 345 points', async () => {
      const m = await enrol();
      await adjust(m.id, 'points', '800');
      const b = await bill(['LY-GRILL', 'LY-CAKE']);
      await attach(b.id, m.id);
      const v = await verify(m.id, b.id);
      await redeem(b.id, { points: 800, verificationId: v }).expect(200);
      await payCard(b.id, '4956.00').expect(200);
      expect(await points(m.id)).toBe(42);
      const cake = b.lines.find((l) => l.name.startsWith('Celebration cake'))!;
      const cashierTry = await api('k1.cashier').post(`${K1}/pos/checks/${b.id}/returns`, { lines: [{ lineId: cake.id, quantity: '1' }], reason: 'Guest did not like it' });
      expect(cashierTry.body.error).toBe('approval_required');
      const res = (await api('k1.cashier')
        .post(`${K1}/pos/checks/${b.id}/returns`, { lines: [{ lineId: cake.id, quantity: '1' }], reason: 'Guest did not like it', approval: MANAGER })
        .expect(200)).body;
      expect(res.return.amount).toBe('1982.40'); // 1,680 eligible + VAT and levy
      expect(res.return.loyalty).toEqual({ pointsRestored: 320, pointsReversed: 17, walletRestored: '0.00' });
      expect(await points(m.id)).toBe(345);
    });

    it('LAT05 full: a full return restores 800 and reverses all 42', async () => {
      const m = await enrol();
      await adjust(m.id, 'points', '800');
      const b = await bill(['LY-PLATTER']);
      await attach(b.id, m.id);
      const v = await verify(m.id, b.id);
      await redeem(b.id, { points: 800, verificationId: v }).expect(200);
      await payCard(b.id, '4956.00').expect(200);
      const res = (await api('k1.manager')
        .post(`${K1}/pos/checks/${b.id}/returns`, { lines: [{ lineId: b.lines[0].id, quantity: '1' }], reason: 'Wrong order' })
        .expect(200)).body;
      expect(res.return.loyalty).toEqual({ pointsRestored: 800, pointsReversed: 42, walletRestored: '0.00' });
      expect(await points(m.id)).toBe(800);
    });

    it('CAT08: KES 2,000 wallet plus card on a KES 10,000 bill; a full return restores the 2,000 once', async () => {
      const m = await enrol();
      await adjust(m.id, 'wallet', '2000.00');
      const b = await bill(['LY-FEAST']);
      await attach(b.id, m.id);
      const v = await verify(m.id, b.id);
      await redeem(b.id, { wallet: '2000.00', verificationId: v }).expect(200);
      expect((await check(b.id)).totals.total).toBe('9440.00'); // 8,000 + VAT and levy
      await payCard(b.id, '9440.00').expect(200);
      expect(await wallet(m.id)).toBe('0.00');
      const key = uniqueKey();
      const body = { lines: [{ lineId: b.lines[0].id, quantity: '1' }], reason: 'Event cancelled' };
      const first = (await api('k1.manager').post(`${K1}/pos/checks/${b.id}/returns`, body, key).expect(200)).body;
      await api('k1.manager').post(`${K1}/pos/checks/${b.id}/returns`, body, key).expect(200);
      expect(first.return.amount).toBe('9440.00');
      expect(first.return.loyalty.walletRestored).toBe('2000.00');
      expect(await wallet(m.id)).toBe('2000.00');
      await api('k1.manager').post(`${K1}/pos/checks/${b.id}/returns`, body).expect(400); // nothing left to return
    });
  });

  // ---------------------------------------------------------------------------
  describe('cross-property, corrections and merges (LAT10, LAT14)', () => {
    it('LAT14: earned at K1, redeemed at Kahama; each shows under its own property', async () => {
      const m = await enrol();
      const k1 = await bill(['LY-FEAST']);
      await attach(k1.id, m.id);
      await payCard(k1.id, '11800.00').expect(200);
      expect(await points(m.id)).toBe(100);
      const km = await bill(['LY-PLATTER'], { property: 'KM', outlet: 'KM-PITCHER', user: 'km.waiter' });
      await attach(km.id, m.id, 'KM', 'km.waiter');
      const v = await verify(m.id, km.id, 'KM', 'km.waiter');
      await redeem(km.id, { points: 100, verificationId: v }, 'KM', 'km.waiter').expect(200);
      await payCard(km.id, (5900 - 118).toFixed(2), 'KM', 'km.waiter').expect(200);
      const history = (await api('owner').get(`/api/properties/KM/loyalty/members/${m.id}/history?unit=points`).expect(200)).body.events;
      expect(history.find((e: { type: string; property: string }) => e.type === 'earn' && e.property === 'K1')).toBeTruthy();
      expect(history.find((e: { type: string; property: string }) => e.type === 'redeem' && e.property === 'KM')).toBeTruthy();
      // Kahama staff see the K1 earning as a line without its details.
      const kmView = (await api('km.waiter').get(`/api/properties/KM/loyalty/members/${m.id}/history?unit=points`).expect(200)).body.events;
      expect(kmView.find((e: { property: string; visible?: boolean }) => e.property === 'K1').visible).toBe(false);
    });

    it('LAT10: a waiter cannot post a correction; an approved merge keeps the totals', async () => {
      const a = await enrol();
      const b = await enrol();
      await api('k1.waiter').post(`${K1}/loyalty/members/${a.id}/adjust`, { unit: 'points', amount: '100', reason: 'Try' }).expect(403);
      await adjust(a.id, 'points', '300');
      await adjust(b.id, 'points', '200');
      await api('k1.reception').post(`${K1}/loyalty/members/${a.id}/merge`, { fromMemberId: b.id, reason: 'Same person, two cards' }).expect(403);
      await api('k1.reception').post(`${K1}/loyalty/members/${a.id}/merge`, { fromMemberId: b.id, reason: 'Same person, two cards', approval: MANAGER }).expect(201);
      expect(await points(a.id)).toBe(500);
      expect((await member(b.id)).status).toBe('merged');
    });

    it('a negative balance after a return blocks redemption (S17)', async () => {
      const m = await enrol();
      const b = await bill(['LY-FEAST']);
      await attach(b.id, m.id);
      await payCard(b.id, '11800.00').expect(200); // earns 100
      const spend = await bill(['LY-PLATTER']);
      await attach(spend.id, m.id);
      const v = await verify(m.id, spend.id);
      await redeem(spend.id, { points: 100, verificationId: v }).expect(200);
      await payCard(spend.id, '5782.00').expect(200);
      await api('k1.manager').post(`${K1}/pos/checks/${b.id}/returns`, { lines: [{ lineId: b.lines[0].id, quantity: '1' }], reason: 'Returned' }).expect(200);
      // 100 earned, 100 spent, 49 earned on the rest of that bill; taking back the 100 leaves −51.
      expect(await points(m.id)).toBe(-51);
      const next = await bill(['LY-PLATTER']);
      const p = (await attach(next.id, m.id)).body;
      expect(p.redeem.maxPoints).toBe(0);
      expect(p.redeem.blocked[0]).toMatch(/negative/);
    });
  });

  // ---------------------------------------------------------------------------
  describe('room charges and company bills (LAT08)', () => {
    it('room-charged spend stays pending until checkout; a company bill until finance confirms payment', async () => {
      const today = (await api('owner').get('/api/properties/SW').expect(200)).body.currentBusinessDate;
      const companies = (await api('owner').get('/api/companies?kind=company').expect(200)).body;
      const acme = companies.find((c: { name: string }) => c.name === 'Acme Logistics Ltd');
      const res = await api('sw.reception')
        .post('/api/properties/SW/reservations', {
          source: 'phone', companyId: acme.id,
          guest: { firstName: 'Loyal', lastName: 'Guest', phone: '+254711888001', nationality: 'KE' },
          arrival: today, departure: addDays(today, 1), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1 }],
        })
        .expect(201);
      const stay = res.body.stays[0];
      await api('sw.reception')
        .post(`/api/properties/SW/stays/${stay.id}/check-in`, {
          identity: { documentType: 'national_id', documentNumber: '48800001', issuingCountry: 'KE' }, roomChargeAllowed: true,
        })
        .expect(200);
      const m = await enrol('SW', 'sw.reception', { guestId: stay.primaryGuestId });
      const b = await bill(['LY-PLATTER'], { property: 'SW', outlet: 'SW-KITCHEN', user: 'sw.waiter', stayId: stay.id });
      await attach(b.id, m.id, 'SW', 'sw.waiter');
      await api('sw.waiter')
        .post(`/api/properties/SW/pos/checks/${b.id}/room-charge`, { stayId: stay.id, acknowledgement: { method: 'staff_verified', signedName: 'Loyal Guest' } })
        .expect(200);
      expect(await points(m.id)).toBe(0);
      expect((await member(m.id)).points.pendingEligible).not.toBe('0.00');
      await api('sw.reception')
        .post(`/api/properties/SW/stays/${stay.id}/check-out`, { creditTransfer: { companyId: acme.id, reason: 'Company pays' }, approval: SW_MANAGER })
        .expect(200);
      expect(await points(m.id)).toBe(0); // company has not paid yet
      const pending = (await api('owner').get('/api/loyalty/reports/pending').expect(200)).body;
      const mine = pending.filter((p: { number: string }) => p.number === m.number);
      expect(mine.every((p: { status: string }) => p.status === 'awaiting_company_payment')).toBe(true);
      await api('sw.manager').post(`/api/properties/SW/loyalty/folios/${stay.folioId}/company-paid`, { reason: 'Paid' }).expect(403);
      const key = uniqueKey();
      await api('group.accounts').post(`/api/properties/SW/loyalty/folios/${stay.folioId}/company-paid`, { reason: 'Acme paid invoice' }, key).expect(200);
      await api('group.accounts').post(`/api/properties/SW/loyalty/folios/${stay.folioId}/company-paid`, { reason: 'Acme paid invoice' }).expect(200);
      expect(await points(m.id)).toBeGreaterThanOrEqual(50); // POS 5,000 plus the room night, once
      const again = await points(m.id);
      await api('group.accounts').post(`/api/properties/SW/loyalty/folios/${stay.folioId}/company-paid`, { reason: 'Acme paid invoice' }).expect(200);
      expect(await points(m.id)).toBe(again);
    });
  });

  // ---------------------------------------------------------------------------
  describe('club cashback and month end (CLUB02–CLUB07, CAT01, CAT05, CAT07, CAT11, CAT12)', () => {
    const month = () => new Date().toISOString().slice(0, 7);
    let clubMember: { id: string; number: string };

    it('a club member chooses discount or cashback per bill when stacking is off (CLUB02, CAT02)', async () => {
      clubMember = await enrol('K1', 'k1.reception');
      await api('k1.waiter')
        .put(`${K1}/loyalty/members/${clubMember.id}/club`, { tierCode: 'CLUB', status: 'active', startsOn: `${month()}-01`, reason: 'x' })
        .expect(403);
      await api('k1.manager')
        .put(`${K1}/loyalty/members/${clubMember.id}/club`, { tierCode: 'CLUB', status: 'active', startsOn: `${month()}-01`, reason: 'Joined the club' })
        .expect(200);
      const b = await bill(['LY-FEAST']);
      const p = (await attach(b.id, clubMember.id)).body;
      expect(p.club).toMatchObject({ discountPercent: '10.00', cashbackPercent: '15.00', benefit: 'discount' });
      expect(p.memberDiscount).toBe('1180.00');
      expect(p.earnPreview).toMatchObject({ points: 0, cashback: '0.00' });
      const cb = (await api('k1.waiter').put(`${K1}/pos/checks/${b.id}/loyalty/benefit`, { benefit: 'cashback' }).expect(200)).body;
      expect(cb.memberDiscount).toBe('0.00');
      expect(cb.earnPreview.cashback).toBe('1500.00');
      await payCard(b.id, '11800.00').expect(200);
    });

    it('CAT01/CAT05: month-end preview, approval by finance, posting once and a safe rerun', async () => {
      await api('k1.cashier').get(`/api/loyalty/cashback/preview?month=${month()}`).expect(403);
      const preview = (await api('group.accounts').get(`/api/loyalty/cashback/preview?month=${month()}`).expect(200)).body;
      const line = preview.lines.find((l: { number: string }) => l.number === clubMember.number);
      expect(line).toMatchObject({ spend: '10000.00', entitlement: '1500.00', amount: '1500.00' });
      const batch = (await api('group.accounts').post('/api/loyalty/cashback/batches', { month: month() }).expect(201)).body;
      expect(batch.kind).toBe('regular');
      await api('group.accounts').post(`/api/loyalty/cashback/batches/${batch.id}/post`).expect(409); // not approved
      await api('k1.manager').post(`/api/loyalty/cashback/batches/${batch.id}/approve`, { reason: 'x' }).expect(403);
      // Maker-checker: the preparer cannot approve their own batch alone.
      const self = await api('group.accounts').post(`/api/loyalty/cashback/batches/${batch.id}/approve`, { reason: 'Checked against sales' }).expect(403);
      expect(self.body.error).toBe('approval_required');
      await api('group.accounts')
        .post(`/api/loyalty/cashback/batches/${batch.id}/approve`, { reason: 'Checked against sales', approval: { username: 'group.accounts', password: process.env.SEED_PASSWORD } })
        .expect(403);
      await api('group.accounts')
        .post(`/api/loyalty/cashback/batches/${batch.id}/approve`, { reason: 'Checked against sales', approval: { username: 'owner', password: process.env.SEED_PASSWORD } })
        .expect(200);
      const key = uniqueKey();
      const posted = (await api('group.accounts').post(`/api/loyalty/cashback/batches/${batch.id}/post`, {}, key).expect(200)).body;
      expect(posted.status).toBe('posted');
      await api('group.accounts').post(`/api/loyalty/cashback/batches/${batch.id}/post`, {}, key).expect(200);
      await api('group.accounts').post(`/api/loyalty/cashback/batches/${batch.id}/post`).expect(409);
      expect(await wallet(clubMember.id)).toBe('1500.00');
      const again = await api('group.accounts').post('/api/loyalty/cashback/batches', { month: month() });
      if (again.status === 201) {
        // Other suites' club sales may be waiting; this member is not in the adjustment.
        expect(again.body.lines.find((l: { number: string }) => l.number === clubMember.number)).toBeUndefined();
        await api('group.accounts').post(`/api/loyalty/cashback/batches/${again.body.id}/discard`, { reason: 'Not needed' }).expect(200);
      } else {
        expect(again.body.error).toBe('nothing_to_adjust');
      }
      // The SAP journal is queued and waits for the G/L accounts (CLUB07).
      const owner = await ownerClient();
      try {
        const { rows } = await owner.query(`SELECT payload FROM integration_outbox WHERE event_type = 'LOYALTY_JOURNAL' AND external_ref LIKE $1`, [`CB-%-${batch.id.slice(0, 8)}-K1`]);
        expect(rows[0].payload.lines[0]).toMatchObject({ account: 'UNMAPPED', debit: '1500.00' });
      } finally {
        await owner.end();
      }
    });

    it('CAT07: a return after posting reduces the entitlement through an adjustment batch', async () => {
      const b = await bill(['LY-PLATTER']);
      await attach(b.id, clubMember.id);
      await api('k1.waiter').put(`${K1}/pos/checks/${b.id}/loyalty/benefit`, { benefit: 'cashback' }).expect(200);
      await payCard(b.id, '5900.00').expect(200); // +750 accrues
      await api('k1.manager').post(`${K1}/pos/checks/${b.id}/returns`, { lines: [{ lineId: b.lines[0].id, quantity: '1' }], reason: 'Returned' }).expect(200);
      const preview = (await api('group.accounts').get(`/api/loyalty/cashback/preview?month=${month()}`).expect(200)).body;
      const line = preview.lines.find((l: { number: string }) => l.number === clubMember.number);
      expect(line).toMatchObject({ spend: '15000.00', returns: '-5000.00', entitlement: '1500.00', previouslyCredited: '1500.00', amount: '0.00' });
    });

    it('CAT11: a cashier cannot change rates or post manual credit; changes are versioned', async () => {
      await api('k1.cashier').post('/api/loyalty/programme/versions', { settings: DEFAULT_LOYALTY_SETTINGS, note: 'try' }).expect(403);
      await api('k1.cashier').put('/api/loyalty/programme/tiers/CLUB', { discountPercent: '50', cashbackPercent: '50', reason: 'try' }).expect(403);
      await api('k1.cashier').post(`${K1}/loyalty/members/${clubMember.id}/adjust`, { unit: 'wallet', amount: '100', reason: 'try' }).expect(403);
    });

    it('LAT16: with stacking on and a 25% ceiling, discount + points + wallet stop at KES 2,500 of 10,000', async () => {
      await newVersion((s) => {
        s.stacking.enabled = true;
      }, 'Stacking on for LAT16');
      try {
        await adjust(clubMember.id, 'points', '1000');
        await adjust(clubMember.id, 'wallet', '3000.00');
        const b = await bill(['LY-FEAST']);
        const p = (await attach(b.id, clubMember.id)).body;
        expect(p.memberDiscount).toBe('1180.00'); // 10% of 11,800
        expect(p.redeem.ceiling.billRoom).toBe('1770.00'); // 25% of 11,800 less the discount
        const v = await verify(clubMember.id, b.id);
        const over = await redeem(b.id, { points: 900, wallet: '1000.00', verificationId: v }).expect(409);
        expect(over.body.error).toBe('benefit_ceiling');
        await redeem(b.id, { points: 500, wallet: '1000.00', verificationId: v }).expect(200);
        const c = await check(b.id);
        expect(Number(c.totals.memberDiscount) + Number(c.totals.rewards)).toBeLessThanOrEqual(2950);
      } finally {
        await newVersion((s) => {
          s.stacking.enabled = false;
        }, 'Stacking back off');
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('reports (LAT11, LOY19, LOY21, CAT12)', () => {
    it('ledger movement reconciles: opening + movements = closing and the ledger equals the lots', async () => {
      const r = (await api('owner').get('/api/loyalty/reports/movement').expect(200)).body;
      expect(r.reconciled).toBe(true);
      const liability = (await api('group.accounts').get('/api/loyalty/reports/liability').expect(200)).body;
      expect(Number(liability.totals.points)).toBeGreaterThan(0);
      await api('k1.waiter').get('/api/loyalty/reports/liability').expect(403);
    });
  });
});
