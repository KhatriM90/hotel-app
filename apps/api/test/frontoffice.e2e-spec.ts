import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { addDays } from '@hotel/shared';
import { appClient, login, ownerClient, startApp, uniqueKey } from './helpers';

/**
 * Reservations, front desk and basic folio, end to end against PostgreSQL.
 * Acceptance tests from brief §10: AT-01 (full stay), AT-05 (room move),
 * AT-08 (double-book race), AT-18 (property isolation).
 */
describe('Reservations, front desk and folio (RES, FD, BIL-01/06/09)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const tokens: Record<string, string> = {};
  const USERS = ['owner', 'group.accounts', 'k1.manager', 'k1.reception', 'k1.waiter', 'k1.cashier', 'km.reception', 'sw.reception'];
  const K1 = '/api/properties/K1';

  const api = (user: string) => ({
    get: (path: string) => request(http).get(path).set('Authorization', `Bearer ${tokens[user]}`),
    post: (path: string, body: object = {}, key = uniqueKey()) =>
      request(http).post(path).set('Authorization', `Bearer ${tokens[user]}`).set('Idempotency-Key', key).send(body),
    patch: (path: string, body: object) => request(http).patch(path).set('Authorization', `Bearer ${tokens[user]}`).send(body),
  });

  const bd = async (code = 'K1'): Promise<string> =>
    (await api('owner').get(`/api/properties/${code}`).expect(200)).body.currentBusinessDate;

  const roomId = async (number: string, code = 'K1'): Promise<string> => {
    const res = await api('owner').get(`/api/properties/${code}/rooms`).expect(200);
    const room = res.body.find((r: { number: string }) => r.number === number);
    if (!room) throw new Error(`room ${number} not found`);
    return room.id;
  };

  let guestSeq = 0;
  const newGuest = () => ({ firstName: 'Test', lastName: `Guest${++guestSeq}`, phone: `+2547100${String(10000 + guestSeq)}`, nationality: 'KE' });
  const identity = () => ({ documentType: 'national_id', documentNumber: `${30000000 + guestSeq}`, issuingCountry: 'KE' });

  const book = (user: string, body: Record<string, unknown>, code = 'K1') =>
    api(user).post(`/api/properties/${code}/reservations`, { source: 'phone', guest: newGuest(), ...body });

  beforeAll(async () => {
    app = await startApp();
    http = app.getHttpServer();
    for (const u of USERS) tokens[u] = await login(app, u);
    // Business date = today in Nairobi, so policy windows measured against now() behave as at a real desk.
    const owner = await ownerClient();
    try {
      await owner.query(`UPDATE properties SET current_business_date = (now() AT TIME ZONE 'Africa/Nairobi')::date`);
    } finally {
      await owner.end();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('test master data (CFG-02, RES-05)', () => {
    it('seeds 13 rooms at K1, 42 at Small World and 32 at Kahama', async () => {
      for (const [code, n] of [['K1', 13], ['SW', 42], ['KM', 32]] as const) {
        const res = await api('owner').get(`/api/properties/${code}/rooms`).expect(200);
        expect(res.body).toHaveLength(n);
        const types = await api('owner').get(`/api/properties/${code}/room-types`).expect(200);
        expect(types.body.reduce((a: number, t: { roomCount: number }) => a + t.roomCount, 0)).toBe(n);
      }
    });

    it('has rate plans with weekday/weekend prices, seasons and negotiated rates', async () => {
      const km = await api('owner').get('/api/properties/KM/rate-plans').expect(200);
      const rack = km.body.find((p: { code: string }) => p.code === 'RACK');
      expect(rack.prices.some((p: { seasonName: string }) => p.seasonName.startsWith('High season'))).toBe(true);
      const k1 = await api('owner').get(`${K1}/rate-plans`).expect(200);
      const corp = k1.body.find((p: { code: string }) => p.code === 'CORPACME');
      expect(corp).toMatchObject({ isNegotiated: true, companyName: 'Acme Logistics Ltd' });
    });

    it('prices the festive season above base at Small World (RES-05)', async () => {
      const res = await api('sw.reception')
        .post('/api/properties/SW/rates/quote', { roomTypeCode: 'STD', ratePlanCode: 'RACK', arrival: '2026-12-21', departure: '2026-12-22', adults: 2 })
        .expect(200);
      expect(res.body.nights[0]).toMatchObject({ seasonName: 'Festive', amount: '9500.00' });
      const extra = await api('sw.reception')
        .post('/api/properties/SW/rates/quote', { roomTypeCode: 'EXE', ratePlanCode: 'RACK', arrival: '2027-02-01', departure: '2027-02-02', adults: 3 })
        .expect(200);
      expect(extra.body.nights[0]).toMatchObject({ seasonName: 'Base', base: '12000.00', supplement: '2500.00', amount: '14500.00' });
    });
  });

  describe('booking lifecycle (RES-02, RES-03, RES-04)', () => {
    it('creates a confirmed booking with permanent numbers, agreed prices, a room and a folio', async () => {
      const arrival = addDays(await bd(), 30);
      const res = await book('k1.reception', { arrival, departure: addDays(arrival, 2), rooms: [{ roomTypeCode: 'DLX', ratePlanCode: 'RACK', adults: 2 }] }).expect(201);
      expect(res.body.number).toMatch(/^K1-BK-\d{6}$/);
      const stay = res.body.stays[0];
      expect(stay.number).toMatch(/^K1-ST-\d{6}$/);
      expect(stay.folioNumber).toMatch(/^K1-FO-\d{6}$/);
      expect(stay.status).toBe('confirmed');
      expect(stay.roomNumber).toMatch(/^20[1-4]$/);
      expect(stay.nights).toHaveLength(2);
      // K1 deposit policy: first night (RES-07)
      expect(res.body.deposit.required).toBe(stay.nights[0].amount);
    });

    it('an enquiry holds no room; a timed hold does, until it expires (RES-03, RES-04)', async () => {
      const arrival = addDays(await bd(), 40);
      const departure = addDays(arrival, 1);
      const enquiry = await book('k1.reception', { status: 'enquiry', arrival, departure, rooms: [{ roomTypeCode: 'STE', ratePlanCode: 'RACK', adults: 2 }] }).expect(201);
      expect(enquiry.body.stays[0].roomNumber).toBeNull();

      const held = await api('k1.reception').post(`${K1}/reservations/${enquiry.body.id}/hold`, { holdMinutes: 30 }).expect(200);
      expect(held.body.stays[0]).toMatchObject({ status: 'hold' });
      expect(held.body.stays[0].roomNumber).not.toBeNull();

      // let the hold lapse
      const owner = await ownerClient();
      try {
        await owner.query(`UPDATE stays SET hold_expires_at = now() - interval '1 minute' WHERE reservation_id = $1`, [enquiry.body.id]);
      } finally {
        await owner.end();
      }
      const free = await api('k1.reception').get(`${K1}/availability/rooms?roomTypeCode=STE&arrival=${arrival}&departure=${departure}`).expect(200);
      expect(free.body).toHaveLength(2); // both suites free again
      const after = await api('k1.reception').get(`${K1}/reservations/${enquiry.body.id}`).expect(200);
      expect(after.body.stays[0]).toMatchObject({ status: 'enquiry', roomNumber: null });

      const confirmed = await api('k1.reception').post(`${K1}/reservations/${enquiry.body.id}/confirm`).expect(200);
      expect(confirmed.body.stays[0].status).toBe('confirmed');
    });

    it('rejects transitions outside the lifecycle, in the API and in the database (RES-03)', async () => {
      const arrival = addDays(await bd(), 45);
      const res = await book('k1.reception', { status: 'enquiry', arrival, departure: addDays(arrival, 1), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1 }] }).expect(201);
      await api('k1.reception').post(`${K1}/stays/${res.body.stays[0].id}/check-in`, { roomChargeAllowed: false }).expect(409);
      await api('k1.reception').post(`${K1}/reservations/${res.body.id}/no-show`).expect(409);
      const owner = await ownerClient();
      try {
        await expect(owner.query(`UPDATE stays SET status = 'checked_out' WHERE id = $1`, [res.body.stays[0].id])).rejects.toThrow(/cannot move from enquiry to checked_out/);
      } finally {
        await owner.end();
      }
    });

    it('refuses negotiated rates without the company (RES-05)', async () => {
      const arrival = addDays(await bd(), 50);
      await book('k1.reception', { arrival, departure: addDays(arrival, 1), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'CORPACME', adults: 1 }] }).expect(422);
    });

    it('keeps occupancy within the room type (RES-02)', async () => {
      const arrival = addDays(await bd(), 50);
      await book('k1.reception', { arrival, departure: addDays(arrival, 1), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 3 }] }).expect(422);
    });
  });

  describe('AT-08 double-book race (RES-04)', () => {
    it('two receptionists request the last suite for overlapping dates: at most one succeeds', async () => {
      const arrival = addDays(await bd(), 60);
      // take one of the two suites
      await book('k1.reception', { arrival, departure: addDays(arrival, 3), rooms: [{ roomTypeCode: 'STE', ratePlanCode: 'RACK', adults: 2 }] }).expect(201);
      const [a, b] = await Promise.all([
        book('k1.reception', { arrival: addDays(arrival, 1), departure: addDays(arrival, 4), rooms: [{ roomTypeCode: 'STE', ratePlanCode: 'RACK', adults: 2 }] }),
        book('k1.manager', { arrival, departure: addDays(arrival, 2), rooms: [{ roomTypeCode: 'STE', ratePlanCode: 'RACK', adults: 2 }] }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.error).toBe('no_availability');
    });

    it('many simultaneous requests for one specific room create exactly one booking', async () => {
      const arrival = addDays(await bd(), 70);
      const room = await roomId('103');
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          book(i % 2 ? 'k1.manager' : 'k1.reception', { arrival, departure: addDays(arrival, 2), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1, roomId: room }] }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      const owner = await ownerClient();
      try {
        const { rows } = await owner.query(
          `SELECT count(*)::int AS n FROM room_allocations WHERE room_id = $1 AND released_at IS NULL AND during && daterange($2::date, $3::date)`,
          [room, arrival, addDays(arrival, 2)],
        );
        expect(rows[0].n).toBe(1);
      } finally {
        await owner.end();
      }
    });

    it('a maintenance block takes the room out of availability (RES-01)', async () => {
      const arrival = addDays(await bd(), 80);
      const room = await roomId('104');
      const block = await api('k1.reception').post(`${K1}/rooms/${room}/blocks`, { from: arrival, to: addDays(arrival, 2), reason: 'Bathroom retiling' }).expect(201);
      await book('k1.reception', { arrival, departure: addDays(arrival, 1), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1, roomId: room }] }).expect(409);
      const grid = await api('k1.reception').get(`${K1}/availability?from=${arrival}&days=3`).expect(200);
      const row = grid.body.rooms.find((r: { number: string }) => r.number === '104');
      expect(row.cells.map((c: { state: string }) => c.state)).toEqual(['blocked', 'blocked', 'free']);
      await api('k1.reception').post(`${K1}/blocks/${block.body.id}/release`).expect(200);
    });
  });

  describe('amendments, overrides and multi-room bookings (RES-05, RES-06, RES-08)', () => {
    it('extending keeps the agreed price of existing nights and prices only the new night at today’s rate', async () => {
      const arrival = addDays(await bd(), 90);
      const res = await book('k1.reception', { arrival, departure: addDays(arrival, 2), rooms: [{ roomTypeCode: 'DLX', ratePlanCode: 'RACK', adults: 2 }] }).expect(201);
      const before = res.body.stays[0].nights.map((n: { amount: string }) => n.amount);
      // the manager raises prices for that period afterwards
      await api('k1.manager')
        .post(`${K1}/rate-plans/RACK/prices`, { roomTypeCode: 'DLX', seasonName: 'Price rise test', validFrom: arrival, validTo: addDays(arrival, 10), priority: 50, weekdayPrice: '9999.00', weekendPrice: '9999.00' })
        .expect(201);
      const amended = await api('k1.reception')
        .post(`${K1}/stays/${res.body.stays[0].id}/amend`, { departure: addDays(arrival, 3), reason: 'Guest stays one more night' })
        .expect(200);
      const nights = amended.body.reservation.stays[0].nights.map((n: { amount: string }) => n.amount);
      expect(nights).toEqual([...before, '9999.00']);
      expect(amended.body.priceDifference).toBe('9999.00');
      expect(amended.body.reservation.amendments).toHaveLength(1);
    });

    it('rate overrides need a manager’s approval, which is recorded (RES-06, SEC-02)', async () => {
      const arrival = addDays(await bd(), 95);
      const body = { arrival, departure: addDays(arrival, 1), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1, rateOverride: { amountPerNight: '5000.00', reason: 'Returning guest' } }] };
      const denied = await book('k1.reception', body).expect(403);
      expect(denied.body.error).toBe('approval_required');
      await book('k1.reception', { ...body, approval: { username: 'k1.reception', password: process.env.SEED_PASSWORD } }).expect(403);
      const ok = await book('k1.reception', { ...body, approval: { username: 'k1.manager', password: process.env.SEED_PASSWORD } }).expect(201);
      expect(ok.body.stays[0].nights[0]).toMatchObject({ amount: '5000.00', isOverride: true });
      const owner = await ownerClient();
      try {
        const { rows } = await owner.query(
          `SELECT r.username AS requested, a.username AS approved FROM approvals x JOIN users r ON r.id = x.requested_by JOIN users a ON a.id = x.approved_by
            WHERE x.entity_id = $1`,
          [ok.body.stays[0].id],
        );
        expect(rows).toEqual([{ requested: 'k1.reception', approved: 'k1.manager' }]);
      } finally {
        await owner.end();
      }
    });

    it('links several rooms under one reference with separate occupants, stays and folios (RES-08)', async () => {
      const arrival = addDays(await bd(), 100);
      const res = await book('k1.reception', {
        arrival,
        departure: addDays(arrival, 2),
        rooms: [
          { roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 2 },
          { roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1, guest: newGuest() },
          { roomTypeCode: 'DLX', ratePlanCode: 'RACK', adults: 2, children: 1, guest: newGuest() },
        ],
      }).expect(201);
      const stays = res.body.stays;
      expect(stays).toHaveLength(3);
      expect(new Set(stays.map((s: { number: string }) => s.number)).size).toBe(3);
      expect(new Set(stays.map((s: { folioNumber: string }) => s.folioNumber)).size).toBe(3);
      expect(new Set(stays.map((s: { roomNumber: string }) => s.roomNumber)).size).toBe(3);
      expect(new Set(stays.map((s: { guest: { id: string } }) => s.guest.id)).size).toBe(3);
      // cancel only one room; the others stay confirmed
      const cancelled = await api('k1.reception').post(`${K1}/reservations/${res.body.id}/cancel`, { stayIds: [stays[1].id], reason: 'One colleague cannot travel' }).expect(200);
      expect(cancelled.body.stays.map((s: { status: string }) => s.status)).toEqual(['confirmed', 'cancelled', 'confirmed']);
    });

    it('issues a numbered pro forma linked to the reservation (BIL-09)', async () => {
      const arrival = addDays(await bd(), 110);
      const res = await book('k1.reception', { arrival, departure: addDays(arrival, 2), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 2 }] }).expect(201);
      const pf = await api('k1.reception').post(`${K1}/reservations/${res.body.id}/proforma`).expect(201);
      expect(pf.body.number).toMatch(/^K1-PF-\d{6}$/);
      const html = await api('k1.reception').get(`${K1}/documents/${pf.body.id}/html`).expect(200);
      expect(html.headers['content-type']).toMatch(/text\/html/);
      expect(html.text).toContain('K1 Klubhouse');
      expect(html.text).toContain(res.body.number);
    });
  });

  describe('deposits and policies (RES-07)', () => {
    it('a payment before arrival is a deposit and counts towards the deposit required', async () => {
      const arrival = addDays(await bd(), 120);
      const res = await book('k1.reception', { arrival, departure: addDays(arrival, 2), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 2 }] }).expect(201);
      const folioId = res.body.stays[0].folioId;
      const pay = await api('k1.reception').post(`${K1}/folios/${folioId}/payments`, { tenders: [{ tender: 'mpesa', amount: '3000.00', reference: uniqueKey('QK') }] }).expect(201);
      expect(pay.body.payments[0]).toMatchObject({ isDeposit: true, status: 'confirmed' });
      expect(pay.body.payments[0].receiptNumber).toMatch(/^K1-RCT-\d{6}$/);
      const after = await api('k1.reception').get(`${K1}/reservations/${res.body.id}`).expect(200);
      expect(after.body.deposit.received).toBe('3000.00');
      expect(after.body.stays[0].balance.depositsUnapplied).toBe('3000.00');
    });

    it('free cancellation outside the window; first night charged inside it unless a manager waives it', async () => {
      const today = await bd();
      const far = await book('k1.reception', { arrival: addDays(today, 10), departure: addDays(today, 12), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1 }] }).expect(201);
      const c1 = await api('k1.reception').post(`${K1}/reservations/${far.body.id}/cancel`, { reason: 'Plans changed' }).expect(200);
      expect(c1.body.stays[0].balance.chargesTotal).toBe('0.00');

      // arriving today: inside K1's 24-hour window
      const late = await book('k1.reception', { arrival: today, departure: addDays(today, 1), rooms: [{ roomTypeCode: 'DLX', ratePlanCode: 'RACK', adults: 1 }] }).expect(201);
      const nightly = late.body.stays[0].nights[0].amount;
      const c2 = await api('k1.reception').post(`${K1}/reservations/${late.body.id}/cancel`, { reason: 'Flight cancelled' }).expect(200);
      expect(c2.body.stays[0].balance.chargesTotal).toBe(nightly);

      const waived = await book('k1.reception', { arrival: today, departure: addDays(today, 1), rooms: [{ roomTypeCode: 'DLX', ratePlanCode: 'RACK', adults: 1 }] }).expect(201);
      await api('k1.reception').post(`${K1}/reservations/${waived.body.id}/cancel`, { reason: 'Medical emergency', waiveFee: true }).expect(403);
      const c3 = await api('k1.reception')
        .post(`${K1}/reservations/${waived.body.id}/cancel`, { reason: 'Medical emergency', waiveFee: true, approval: { username: 'k1.manager', password: process.env.SEED_PASSWORD } })
        .expect(200);
      expect(c3.body.stays[0]).toMatchObject({ status: 'cancelled' });
      expect(c3.body.stays[0].balance.chargesTotal).toBe('0.00');
    });

    it('a no-show is charged the first night and frees the room', async () => {
      const today = await bd();
      const res = await book('k1.reception', { arrival: today, departure: addDays(today, 2), rooms: [{ roomTypeCode: 'DLX', ratePlanCode: 'RACK', adults: 2 }] }).expect(201);
      const ns = await api('k1.reception').post(`${K1}/reservations/${res.body.id}/no-show`, { reason: 'Did not arrive' }).expect(200);
      expect(ns.body.stays[0].status).toBe('no_show');
      expect(ns.body.stays[0].balance.chargesTotal).toBe(res.body.stays[0].nights[0].amount);
    });
  });

  describe('guest profiles and identity (FD-02, AT-14)', () => {
    it('identity documents are masked in profiles and hidden from waiters', async () => {
      const g = await api('k1.reception').post('/api/guests', newGuest()).expect(201);
      await api('k1.reception').post(`/api/guests/${g.body.id}/identity-documents`, { documentType: 'passport', documentNumber: 'AB1234567', issuingCountry: 'GB' }).expect(201);
      const profile = await api('k1.reception').get(`/api/guests/${g.body.id}`).expect(200);
      expect(profile.body.identityDocuments[0].documentNumber).toBe('******567');
      await api('k1.waiter').get(`/api/guests/${g.body.id}/identity-documents`).expect(403);
      await api('k1.waiter').get(`/api/guests/${g.body.id}`).expect(403);
      const full = await api('k1.manager').get(`/api/guests/${g.body.id}/identity-documents`).expect(200);
      expect(full.body[0].documentNumber).toBe('AB1234567');
    });
  });

  describe('AT-05 room move', () => {
    it('moves a guest from 101 to 205; charges stay on the same stay; the next guest in 101 inherits none', async () => {
      const today = await bd();
      const r101 = await roomId('101');
      const r205 = await roomId('205');
      const owner = await ownerClient();
      try {
        await owner.query(`UPDATE rooms SET hk_status = 'clean' WHERE id = ANY($1)`, [[r101, r205]]);
      } finally {
        await owner.end();
      }
      const res = await book('k1.reception', { arrival: today, departure: addDays(today, 3), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1, roomId: r101 }] }).expect(201);
      const stay = res.body.stays[0];
      expect(stay.roomNumber).toBe('101');
      await api('k1.reception').post(`${K1}/stays/${stay.id}/check-in`, { identity: identity(), roomChargeAllowed: true }).expect(200);
      await api('k1.reception').post(`${K1}/folios/${stay.folioId}/charges`, { chargeCode: 'BEVERAGE', unitPrice: '450.00', quantity: '2', outletCode: 'K1-COCKTAIL' }).expect(201);
      await api('k1.reception').post(`${K1}/folios/${stay.folioId}/charges`, { chargeCode: 'LAUNDRY', unitPrice: '600.00', outletCode: 'K1-LAUNDRY' }).expect(201);

      const moved = await api('k1.reception').post(`${K1}/stays/${stay.id}/move`, { toRoomId: r205, reason: 'Upgrade: air conditioning fault in 101' }).expect(200);
      expect(moved.body).toMatchObject({ stayNumber: stay.number, fromRoom: '101', toRoom: '205' });

      const folio = await api('k1.reception').get(`${K1}/folios/${stay.folioId}`).expect(200);
      expect(folio.body).toMatchObject({ number: stay.folioNumber, stayNumber: stay.number, roomNumber: '205' });
      expect(folio.body.charges).toHaveLength(2);
      expect(folio.body.balance.chargesTotal).toBe('1500.00');
      const history = await api('k1.reception').get(`${K1}/stays/${stay.id}/moves`).expect(200);
      expect(history.body).toEqual([expect.objectContaining({ fromRoom: '101', toRoom: '205' })]);

      // 101 was left dirty; housekeeping cleans it and a new guest takes it
      await api('k1.reception').patch(`${K1}/rooms/${r101}/hk-status`, { hkStatus: 'clean' }).expect(200);
      const next = await book('k1.reception', { arrival: today, departure: addDays(today, 1), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1, roomId: r101 }] }).expect(201);
      await api('k1.reception').post(`${K1}/stays/${next.body.stays[0].id}/check-in`, { identity: identity(), roomChargeAllowed: true }).expect(200);
      const nextFolio = await api('k1.reception').get(`${K1}/folios/${next.body.stays[0].folioId}`).expect(200);
      expect(nextFolio.body.charges).toHaveLength(0);
      expect(nextFolio.body.balance.chargesTotal).toBe('0.00');
      expect(nextFolio.body.stayNumber).not.toBe(stay.number);
    });
  });

  describe('check-in controls (FD-03, FD-04, FD-06, BIL-02, BIL-17)', () => {
    let stay: { id: string; folioId: string; number: string };
    const doc = identity();

    beforeAll(async () => {
      const today = await bd();
      const owner = await ownerClient();
      try {
        await owner.query(`UPDATE rooms SET hk_status = 'dirty' WHERE number = '106' AND property_id = (SELECT id FROM properties WHERE code = 'K1')`);
      } finally {
        await owner.end();
      }
      const res = await book('k1.reception', { arrival: today, departure: addDays(today, 2), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 2, roomId: await roomId('106') }] }).expect(201);
      stay = res.body.stays[0];
    });

    it('needs a verified identity document', async () => {
      const res = await api('k1.reception').post(`${K1}/stays/${stay.id}/check-in`, { roomChargeAllowed: true }).expect(409);
      expect(res.body.error).toBe('identity_required');
    });

    it('refuses a dirty room unless a manager approves', async () => {
      const res = await api('k1.reception').post(`${K1}/stays/${stay.id}/check-in`, { identity: identity(), roomChargeAllowed: true }).expect(409);
      expect(res.body.error).toBe('room_not_ready');
    });

    it('checks in to another ready room with occupants, an early check-in fee and a signed registration card', async () => {
      const r107 = await roomId('107');
      const owner = await ownerClient();
      try {
        await owner.query(`UPDATE rooms SET hk_status = 'inspected' WHERE id = $1`, [r107]);
      } finally {
        await owner.end();
      }
      const res = await api('k1.reception')
        .post(`${K1}/stays/${stay.id}/check-in`, {
          roomId: r107,
          identity: doc,
          occupants: [newGuest()],
          roomChargeAllowed: true,
          creditLimit: '2000.00',
          earlyCheckIn: true,
          registration: { method: 'paper_signature', signedName: 'Test Guest' },
        })
        .expect(200);
      const s = res.body.stays[0];
      expect(s).toMatchObject({ status: 'checked_in', roomNumber: '107', roomChargeAllowed: true, creditLimit: '2000.00' });
      expect(s.occupants).toHaveLength(2);
      expect(s.balance.chargesTotal).toBe('2000.00'); // K1 early check-in fee
      const card = await api('k1.reception').get(`${K1}/stays/${stay.id}/registration-card`).expect(200);
      expect(card.text).toContain('Registration card');
      expect(card.text).toContain('Paper signature');
      expect(card.text).not.toContain(doc.documentNumber); // identity number masked
      expect(card.text).toContain(doc.documentNumber.slice(-3));
    });

    it('enforces the credit limit and outlet property on room charges (BIL-02, BIL-17)', async () => {
      const over = await api('k1.reception').post(`${K1}/folios/${stay.folioId}/charges`, { chargeCode: 'FOOD', unitPrice: '500.00', outletCode: 'K1-KOFFEE' }).expect(409);
      expect(over.body.error).toBe('credit_limit');
      await api('k1.reception').post(`${K1}/folios/${stay.folioId}/charges`, { chargeCode: 'FOOD', unitPrice: '500.00', outletCode: 'SW-MAINBAR' }).expect(422);
      await api('k1.reception').post(`${K1}/folios/${stay.folioId}/charges`, { chargeCode: 'ROOM', unitPrice: '500.00' }).expect(422);
    });

    it('charges a late check-out fee and records the revised departure time (FD-06)', async () => {
      const res = await api('k1.reception').post(`${K1}/stays/${stay.id}/late-checkout`, { departureTime: '15:00' }).expect(200);
      expect(res.body.stays[0]).toMatchObject({ departureTime: '15:00:00' });
      expect(res.body.stays[0].balance.chargesTotal).toBe('4500.00');
    });

    it('reverses a charge only with approval, as a linked negative entry (BIL-07)', async () => {
      const folio = await api('k1.reception').get(`${K1}/folios/${stay.folioId}`).expect(200);
      const fee = folio.body.charges.find((c: { chargeCode: string }) => c.chargeCode === 'LATE_CHECKOUT');
      await api('k1.reception').post(`${K1}/folios/${stay.folioId}/charges/${fee.id}/reverse`, { reason: 'Waived for loyalty' }).expect(403);
      const rev = await api('k1.manager').post(`${K1}/folios/${stay.folioId}/charges/${fee.id}/reverse`, { reason: 'Waived for loyalty' }).expect(201);
      expect(rev.body).toMatchObject({ amount: '-2500.00', reversalOf: fee.id });
      await api('k1.manager').post(`${K1}/folios/${stay.folioId}/charges/${fee.id}/reverse`, { reason: 'Again' }).expect(409);
      const after = await api('k1.reception').get(`${K1}/folios/${stay.folioId}`).expect(200);
      expect(after.body.balance.chargesTotal).toBe('2000.00');
      expect(after.body.charges).toHaveLength(3); // original, fee, reversal: nothing deleted
    });

    it('guest requests carry an owner, status and handover notes (FD-07)', async () => {
      const staff = await api('k1.reception').get(`${K1}/staff`).expect(200);
      const owner = staff.body.find((u: { displayName: string }) => u.displayName === 'K1 manager');
      const r = await api('k1.reception').post(`${K1}/guest-requests`, { stayId: stay.id, category: 'linen', description: 'Two extra towels', ownerUserId: owner.id }).expect(201);
      await api('k1.reception').patch(`${K1}/guest-requests/${r.body.id}`, { status: 'in_progress', note: 'Housekeeping on the way' }).expect(200);
      await api('k1.reception').patch(`${K1}/guest-requests/${r.body.id}`, { status: 'done', note: 'Delivered' }).expect(200);
      const list = await api('k1.reception').get(`${K1}/guest-requests`).expect(200);
      const item = list.body.find((x: { id: string }) => x.id === r.body.id);
      expect(item).toMatchObject({ status: 'done', owner: 'K1 manager', roomNumber: '107' });
      expect(item.notes.map((n: { note: string }) => n.note)).toEqual(['Housekeeping on the way', 'Delivered']);
    });

    it('the dashboard shows in-house guests, arrivals and room readiness (FD-01)', async () => {
      const res = await api('k1.reception').get(`${K1}/front-desk/dashboard`).expect(200);
      expect(res.body.counts.rooms).toBe(13);
      expect(res.body.inHouse.map((s: { number: string }) => s.number)).toContain(stay.number);
      expect(res.body.outstandingBalances.map((s: { number: string }) => s.number)).toContain(stay.number);
      expect(res.body.roomReadiness.length).toBeGreaterThan(0);
    });
  });

  describe('payments (BIL-06, AT-03)', () => {
    let folioId: string;

    beforeAll(async () => {
      const today = await bd('SW');
      const res = await book('sw.reception', { arrival: today, departure: addDays(today, 1), rooms: [{ roomTypeCode: 'TWN', ratePlanCode: 'RACK', adults: 2 }] }, 'SW').expect(201);
      folioId = res.body.stays[0].folioId;
    });

    it('replays a retried payment and refuses a reused M-PESA code', async () => {
      const key = uniqueKey('pay');
      const ref = uniqueKey('QKX');
      const body = { tenders: [{ tender: 'mpesa', amount: '1000.00', reference: ref }] };
      const first = await api('sw.reception').post(`/api/properties/SW/folios/${folioId}/payments`, body, key).expect(201);
      const retry = await api('sw.reception').post(`/api/properties/SW/folios/${folioId}/payments`, body, key).expect(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body.payments[0].id).toBe(first.body.payments[0].id);
      const dup = await api('sw.reception').post(`/api/properties/SW/folios/${folioId}/payments`, body).expect(409);
      expect(dup.body.error).toBe('duplicate_payment');
    });

    it('keeps pending payments out of the balance until confirmed; split tenders in one go', async () => {
      const res = await api('sw.reception')
        .post(`/api/properties/SW/folios/${folioId}/payments`, {
          tenders: [
            { tender: 'cash', amount: '500.00' },
            { tender: 'bank_transfer', amount: '2000.00', reference: uniqueKey('EFT'), status: 'pending' },
          ],
        })
        .expect(201);
      expect(res.body.payments.map((p: { status: string }) => p.status)).toEqual(['confirmed', 'pending']);
      expect(res.body.payments[1].receiptNumber).toBeNull();
      expect(res.body.balance).toMatchObject({ paymentsConfirmed: '1500.00', paymentsPending: '2000.00' });
      const confirmed = await api('sw.reception').post(`/api/properties/SW/payments/${res.body.payments[1].id}/confirm`).expect(200);
      expect(confirmed.body.receiptNumber).toMatch(/^SW-RCT-\d{6}$/);
      await api('sw.reception').post(`/api/properties/SW/payments/${res.body.payments[1].id}/fail`, { reason: 'Too late' }).expect(409);
      const owner = await ownerClient();
      try {
        await expect(owner.query(`UPDATE folio_payments SET amount = 1 WHERE id = $1`, [res.body.payments[0].id])).rejects.toThrow(/immutable/);
        await expect(owner.query(`DELETE FROM folio_payments WHERE id = $1`, [res.body.payments[0].id])).rejects.toThrow(/append-only/);
      } finally {
        await owner.end();
      }
    });
  });

  describe('AT-18 property isolation', () => {
    let k1: { reservationId: string; stayId: string; folioId: string; guestId: string };

    beforeAll(async () => {
      const arrival = addDays(await bd(), 130);
      const res = await book('k1.reception', { arrival, departure: addDays(arrival, 1), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1 }] }).expect(201);
      k1 = { reservationId: res.body.id, stayId: res.body.stays[0].id, folioId: res.body.stays[0].folioId, guestId: res.body.booker.id };
    });

    it('a Kahama receptionist cannot view or post K1 reservations, rooms, folios or documents', async () => {
      const km = api('km.reception');
      await km.get(`${K1}/reservations`).expect(403);
      await km.get(`${K1}/reservations/${k1.reservationId}`).expect(403);
      await km.get(`${K1}/rooms`).expect(403);
      await km.get(`${K1}/front-desk/dashboard`).expect(403);
      await km.get(`${K1}/folios/${k1.folioId}`).expect(403);
      await km.post(`${K1}/folios/${k1.folioId}/payments`, { tenders: [{ tender: 'cash', amount: '100.00' }] }).expect(403);
      await km.post(`${K1}/reservations`, { source: 'phone', guest: newGuest(), arrival: '2027-01-10', departure: '2027-01-11', rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1 }] }).expect(403);
      // using a K1 id on a Kahama route finds nothing
      await km.get(`/api/properties/KM/reservations/${k1.reservationId}`).expect(404);
      await km.get(`/api/properties/KM/folios/${k1.folioId}`).expect(404);
      await km.post(`/api/properties/KM/stays/${k1.stayId}/check-in`, { roomChargeAllowed: false }).expect(404);
    });

    it('guest stay history only shows stays at the caller’s properties', async () => {
      const kmView = await api('km.reception').get(`/api/guests/${k1.guestId}`).expect(200);
      expect(kmView.body.stays).toEqual([]);
      const groupView = await api('group.accounts').get(`/api/guests/${k1.guestId}`).expect(200);
      expect(groupView.body.stays.map((s: { propertyCode: string }) => s.propertyCode)).toEqual(['K1']);
    });

    it('group accounts can see all three properties', async () => {
      for (const code of ['K1', 'SW', 'KM']) {
        await api('group.accounts').get(`/api/properties/${code}/reservations`).expect(200);
        await api('group.accounts').get(`/api/properties/${code}/front-desk/dashboard`).expect(200);
      }
      const k1List = await api('group.accounts').get(`${K1}/reservations`).expect(200);
      expect(k1List.body.some((r: { id: string }) => r.id === k1.reservationId)).toBe(true);
    });

    it('row-level security hides other properties’ stays from the database role itself', async () => {
      const owner = await ownerClient();
      let kmId: string;
      try {
        ({ rows: [{ id: kmId }] } = await owner.query(`SELECT id FROM properties WHERE code = 'KM'`));
      } finally {
        await owner.end();
      }
      const c = await appClient();
      try {
        await c.query('BEGIN');
        expect((await c.query(`SELECT count(*)::int AS n FROM stays`)).rows[0].n).toBe(0); // no scope: fail closed
        await c.query(`SELECT set_config('app.property_ids', $1, true)`, [`{${kmId}}`]);
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM stays s JOIN reservations r ON r.id = s.reservation_id WHERE r.number LIKE 'K1-%'`);
        expect(rows[0].n).toBe(0);
        await c.query('ROLLBACK');
      } finally {
        await c.end();
      }
    });
  });

  describe('checkout controls (FD-08, BIL-11)', () => {
    it('blocks checkout while a payment is pending or a balance is due, and after checkout nothing more posts', async () => {
      const today = await bd('KM');
      const owner = await ownerClient();
      try {
        await owner.query(`UPDATE rooms SET hk_status = 'clean' WHERE property_id = (SELECT id FROM properties WHERE code = 'KM')`);
      } finally {
        await owner.end();
      }
      const res = await book('km.reception', { arrival: today, departure: addDays(today, 1), rooms: [{ roomTypeCode: 'DLX', ratePlanCode: 'RACK', adults: 2 }] }, 'KM').expect(201);
      const stay = res.body.stays[0];
      const KM = '/api/properties/KM';
      await api('km.reception').post(`${KM}/stays/${stay.id}/check-in`, { identity: identity(), roomChargeAllowed: true }).expect(200);
      const pending = await api('km.reception').post(`${KM}/folios/${stay.folioId}/payments`, { tenders: [{ tender: 'card', amount: '1000.00', reference: uniqueKey('AUTH'), status: 'pending' }] }).expect(201);
      const blocked = await api('km.reception').post(`${KM}/stays/${stay.id}/check-out`, {}).expect(409);
      expect(blocked.body.error).toBe('pending_payments');
      await api('km.reception').post(`${KM}/payments/${pending.body.payments[0].id}/fail`, { reason: 'Card declined' }).expect(200);
      const due = await api('km.reception').post(`${KM}/stays/${stay.id}/check-out`, {}).expect(409);
      expect(due.body).toMatchObject({ error: 'balance_not_zero', balance: stay.nights[0].amount });
      const out = await api('km.reception').post(`${KM}/stays/${stay.id}/check-out`, { tenders: [{ tender: 'cash', amount: stay.nights[0].amount }] }).expect(200);
      expect(out.body.invoice.number).toMatch(/^KM-INV-\d{6}$/);
      await api('km.reception').post(`${KM}/folios/${stay.folioId}/charges`, { chargeCode: 'FOOD', unitPrice: '100.00' }).expect(409);
      await api('km.reception').post(`${KM}/folios/${stay.folioId}/payments`, { tenders: [{ tender: 'cash', amount: '1.00' }] }).expect(409);
    });

    it('a charge racing checkout is either on the settled bill or rejected: no hidden debt (§9, AT-09)', async () => {
      const today = await bd('KM');
      const KM = '/api/properties/KM';
      const res = await book('km.reception', { arrival: today, departure: addDays(today, 1), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1 }] }, 'KM').expect(201);
      const stay = res.body.stays[0];
      await api('km.reception').post(`${KM}/stays/${stay.id}/check-in`, { identity: identity(), roomChargeAllowed: true }).expect(200);
      const [charge, out] = await Promise.all([
        api('km.reception').post(`${KM}/folios/${stay.folioId}/charges`, { chargeCode: 'BEVERAGE', unitPrice: '300.00', outletCode: 'KM-COCKTAIL' }),
        api('km.reception').post(`${KM}/stays/${stay.id}/check-out`, { tenders: [{ tender: 'cash', amount: stay.nights[0].amount }] }),
      ]);
      const folio = await api('km.reception').get(`${KM}/folios/${stay.folioId}`).expect(200);
      if (out.status === 200) {
        expect(charge.status).toBe(409); // arrived after the freeze
        expect(folio.body.balance.balance).toBe('0.00');
      } else {
        expect(charge.status).toBe(201); // landed first, so settlement no longer balanced
        expect(out.body.error).toBe('balance_not_zero');
        expect(folio.body.status).toBe('open');
      }
    });
  });

  describe('AT-01 full stay', () => {
    it('two nights, deposit 5,000, meals, drinks and laundry, settled with two tenders: 16,500 = 5,000 + 11,500, balance zero', async () => {
      const today = await bd();
      const companies = await api('k1.reception').get('/api/companies?kind=company').expect(200);
      const acme = companies.body.find((c: { name: string }) => c.name === 'Acme Logistics Ltd');
      const owner = await ownerClient();
      try {
        await owner.query(`UPDATE rooms SET hk_status = 'clean' WHERE number = '102' AND property_id = (SELECT id FROM properties WHERE code = 'K1')`);
      } finally {
        await owner.end();
      }

      // 1. Book two nights at the Acme corporate rate (5,500 every night).
      const res = await book('k1.reception', {
        source: 'email', companyId: acme.id, arrival: today, departure: addDays(today, 2),
        rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'CORPACME', adults: 1, roomId: await roomId('102') }],
      }).expect(201);
      const stay = res.body.stays[0];
      expect(stay.total).toBe('11000.00');

      // 2. Deposit 5,000.
      const dep = await api('k1.reception').post(`${K1}/folios/${stay.folioId}/payments`, { tenders: [{ tender: 'mpesa', amount: '5000.00', reference: uniqueKey('QAT01') }] }).expect(201);
      expect(dep.body.payments[0].isDeposit).toBe(true);

      // 3. Check in, then meals, drinks and laundry: 2,500 + 1,500 + 1,500.
      await api('k1.reception').post(`${K1}/stays/${stay.id}/check-in`, { identity: identity(), roomChargeAllowed: true }).expect(200);
      await api('k1.reception').post(`${K1}/folios/${stay.folioId}/charges`, { chargeCode: 'FOOD', description: 'Dinner', unitPrice: '1250.00', quantity: '2', outletCode: 'K1-KOFFEE' }).expect(201);
      await api('k1.reception').post(`${K1}/folios/${stay.folioId}/charges`, { chargeCode: 'BEVERAGE', description: 'Drinks', unitPrice: '1500.00', outletCode: 'K1-COCKTAIL' }).expect(201);
      await api('k1.reception').post(`${K1}/folios/${stay.folioId}/charges`, { chargeCode: 'LAUNDRY', description: 'Laundry', unitPrice: '1500.00', outletCode: 'K1-LAUNDRY' }).expect(201);

      // 4. Two nights pass: each day close posts that night's room charge once.
      const d1 = await api('k1.manager').post(`${K1}/front-desk/close-day`, { businessDate: today }).expect(200);
      expect(d1.body.businessDate).toBe(addDays(today, 1));
      await api('k1.manager').post(`${K1}/front-desk/close-day`, { businessDate: today }).expect(409); // already closed
      await api('k1.manager').post(`${K1}/front-desk/close-day`, { businessDate: addDays(today, 1) }).expect(200);

      // 5. Preview: 16,500 charged, 5,000 paid, 11,500 due.
      const preview = await api('k1.reception').get(`${K1}/folios/${stay.folioId}`).expect(200);
      expect(preview.body.balance).toMatchObject({ chargesTotal: '16500.00', paymentsConfirmed: '5000.00', balance: '11500.00' });
      expect(preview.body.charges.filter((c: { chargeCode: string }) => c.chargeCode === 'ROOM')).toHaveLength(2);
      const vat = preview.body.taxSummary.find((t: { taxCode: string }) => t.taxCode === 'O1');
      const levy = preview.body.taxSummary.find((t: { taxCode: string }) => t.taxCode === 'C1');
      expect(vat).toBeDefined();
      expect(levy).toBeDefined(); // catering levy on its own line (BIL-16)
      const statement = await api('k1.reception').get(`${K1}/folios/${stay.folioId}/statement`).expect(200);
      expect(statement.text).toContain('11,500.00');

      // 6. Settle 11,500 with two tenders: cash 8,000 + card 3,500.
      const out = await api('k1.reception')
        .post(`${K1}/stays/${stay.id}/check-out`, {
          tenders: [
            { tender: 'cash', amount: '8000.00' },
            { tender: 'card', amount: '3500.00', reference: uniqueKey('AUTH') },
          ],
        })
        .expect(200);
      expect(out.body.totals).toMatchObject({ chargesTotal: '16500.00', paymentsConfirmed: '16500.00', balance: '0.00' });
      expect(out.body.invoice.number).toMatch(/^K1-INV-\d{6}$/);

      const closed = await api('k1.reception').get(`${K1}/folios/${stay.folioId}`).expect(200);
      expect(closed.body.status).toBe('closed');
      expect(closed.body.payments.map((p: { receiptNumber: string }) => p.receiptNumber).every((n: string) => /^K1-RCT-/.test(n))).toBe(true);
      expect(closed.body.payments).toHaveLength(3);
      expect(closed.body.documents.map((d: { documentType: string }) => d.documentType).sort()).toEqual(['INVOICE', 'RECEIPT', 'RECEIPT', 'RECEIPT']);
      const invoice = await api('k1.reception').get(`${K1}/documents/${out.body.invoice.id}/html`).expect(200);
      expect(invoice.text).toContain('16,500.00');
      expect(invoice.text).toContain('Acme Logistics Ltd');

      // Room is dirty for housekeeping, the stay is frozen.
      const rooms = await api('k1.reception').get(`${K1}/rooms`).expect(200);
      expect(rooms.body.find((r: { number: string }) => r.number === '102').hkStatus).toBe('dirty');
      const o = await ownerClient();
      try {
        await expect(o.query(`UPDATE folios SET number = 'X' WHERE id = $1`, [stay.folioId])).rejects.toThrow();
        await expect(o.query(`UPDATE stays SET notes = 'edit' WHERE id = $1`, [stay.id])).rejects.toThrow(/checked_out and cannot be changed/);
        await expect(o.query(`DELETE FROM folio_charges WHERE folio_id = $1`, [stay.folioId])).rejects.toThrow(/append-only/);
      } finally {
        await o.end();
      }
    });
  });
});
