import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { addDays } from '@hotel/shared';
import { login, ownerClient, startApp, uniqueKey } from './helpers';

/**
 * Door locks (INT-09, FD-03, FD-05): TEMIC20 guest key cards encoded by the
 * bridge on Kahama's reception PC. The bridge is played by this test through
 * the same pull API the real one uses.
 */
describe('Door locks: TEMIC20 key cards (INT-09)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const tokens: Record<string, string> = {};
  const USERS = ['km.reception', 'km.manager', 'k1.reception', 'k1.manager', 'km.waiter'];
  const KM = '/api/properties/KM';
  const DAY = '2031-07-07';
  let bridgeToken = '';
  const BRIDGE_ID = 'KM-RECEPTION-PC';

  const api = (user: string) => ({
    get: (path: string) => request(http).get(path).set('Authorization', `Bearer ${tokens[user]}`),
    post: (path: string, body: object = {}, key = uniqueKey()) =>
      request(http).post(path).set('Authorization', `Bearer ${tokens[user]}`).set('Idempotency-Key', key).send(body),
    put: (path: string, body: object) => request(http).put(path).set('Authorization', `Bearer ${tokens[user]}`).send(body),
  });
  const bridge = (token = bridgeToken) => ({
    claim: () => request(http).post('/api/door-locks/bridge/claim').set('Authorization', `Bearer ${token}`).send({ bridgeId: BRIDGE_ID, version: 'test', mode: 'mock' }),
    result: (id: string, body: object) =>
      request(http).post(`/api/door-locks/bridge/jobs/${id}/result`).set('Authorization', `Bearer ${token}`).send({ bridgeId: BRIDGE_ID, ...body }),
  });
  /** Encodes everything waiting, like the bridge's poll loop, and returns what it was given. */
  const drain = async (outcome: (job: { id: string; kind: string }) => object = () => ({ outcome: 'done' })) => {
    const done: Array<{ id: string; kind: string; keyCard?: Record<string, unknown>; read?: object }> = [];
    for (;;) {
      const res = await bridge().claim().expect(200);
      if (!res.body.job) return done;
      done.push(res.body.job);
      await bridge().result(res.body.job.id, outcome(res.body.job)).expect(200);
    }
  };

  let seq = 0;
  const rooms: Array<{ id: string; number: string; roomTypeCode: string }> = [];
  const checkedIn = async (roomIndex: number, nights = 3) => {
    const room = rooms[roomIndex];
    const res = await api('km.reception')
      .post(`${KM}/reservations`, {
        source: 'phone',
        guest: { firstName: 'Lock', lastName: `Guest${++seq}`, phone: `+4477009${String(10000 + seq)}`, nationality: 'GB' },
        arrival: DAY, departure: addDays(DAY, nights),
        rooms: [{ roomTypeCode: room.roomTypeCode, ratePlanCode: 'RACK', adults: 1, roomId: room.id }],
      })
      .expect(201);
    const stay = res.body.stays[0];
    await api('km.reception')
      .post(`${KM}/stays/${stay.id}/check-in`, { identity: { documentType: 'passport', documentNumber: `LK${100000 + seq}`, issuingCountry: 'GB' }, roomChargeAllowed: false })
      .expect(200);
    return stay as { id: string; number: string };
  };

  beforeAll(async () => {
    app = await startApp();
    http = app.getHttpServer();
    for (const u of USERS) tokens[u] = await login(app, u);
    const owner = await ownerClient();
    try {
      await owner.query(`UPDATE properties SET current_business_date = $1 WHERE code = 'KM'`, [DAY]);
      const { rows } = await owner.query(
        `SELECT r.id, r.number, t.code AS "roomTypeCode" FROM rooms r JOIN room_types t ON t.id = r.room_type_id JOIN properties p ON p.id = r.property_id
          WHERE p.code = 'KM' AND r.is_sellable AND EXISTS (SELECT 1 FROM rate_plans rp WHERE rp.property_id = p.id AND rp.code = 'RACK')
          ORDER BY t.code, r.number LIMIT 5`,
      );
      rooms.push(...rows);
      await owner.query(`UPDATE rooms SET hk_status = 'clean' WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
    } finally {
      await owner.end();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('is set up by a manager, not reception, and keeps the supplier codes from reception', async () => {
    await api('km.reception').put(`${KM}/door-locks/settings`, { comPort: 3 }).expect(403);
    const off = await api('km.reception').post(`${KM}/door-locks/read-card`).expect(409);
    expect(off.body.error).toBe('bridge_not_paired');
    const noCodes = await api('km.manager').put(`${KM}/door-locks/settings`, { enabled: true }).expect(400);
    expect(noCodes.body.message).toMatch(/SystemCode/);
    const set = await api('km.manager').put(`${KM}/door-locks/settings`, { systemCode: 'A1B2C3', hotelCode: '0042', comPort: 3, cardGraceMinutes: 15 }).expect(200);
    expect(set.body).toMatchObject({ enabled: false, systemCode: 'A1B2C3', hotelCode: '0042', comPort: 3, cardPass: '82A094FFFFFF', nextCardNo: 1 });
    const seen = await api('km.reception').get(`${KM}/door-locks/settings`).expect(200);
    expect(seen.body).toMatchObject({ systemCode: '••••', hotelCode: '••••', comPort: 3 });
    await api('km.waiter').get(`${KM}/door-locks/settings`).expect(403);
    const numbered = await api('km.manager').put(`${KM}/door-locks/settings`, { nextCardNo: 5000 }).expect(200);
    expect(numbered.body.nextCardNo).toBe(5000);
    const back = await api('km.manager').put(`${KM}/door-locks/settings`, { nextCardNo: 4999 }).expect(400);
    expect(back.body.message).toMatch(/only go up/);
  });

  it('refuses a card while key cards are switched off', async () => {
    const stay = await checkedIn(3, 1);
    const res = await api('km.reception').post(`${KM}/stays/${stay.id}/key-cards`, { kind: 'new' }).expect(409);
    expect(res.body.error).toBe('door_locks_disabled');
  });

  it('stores room lock addresses and checks them', async () => {
    await api('km.manager').put(`${KM}/door-locks/rooms`, { rooms: [{ number: rooms[0].number, lockAddress: '0101020060' }] }).expect(400);
    const dup = await api('km.manager')
      .put(`${KM}/door-locks/rooms`, { rooms: [{ number: rooms[0].number, lockAddress: '01010100100' }, { number: rooms[1].number, lockAddress: '01010100100' }] })
      .expect(400);
    expect(dup.body.message).toMatch(/two rooms/);
    await api('km.manager').put(`${KM}/door-locks/rooms`, { rooms: [{ number: 'NOPE', lockAddress: '01010100100' }] }).expect(400);
    const saved = await api('km.manager')
      .put(`${KM}/door-locks/rooms`, {
        rooms: [
          { number: rooms[0].number, lockAddress: '01010100100' },
          { number: rooms[1].number, lockAddress: '01010100200' },
          { number: rooms[2].number, lockAddress: '01010100300' },
        ],
      })
      .expect(200);
    expect(saved.body.find((r: { number: string }) => r.number === rooms[1].number).lockAddress).toBe('01010100200');
    // Swapping two addresses in one save works.
    await api('km.manager')
      .put(`${KM}/door-locks/rooms`, { rooms: [{ number: rooms[0].number, lockAddress: '01010100200' }, { number: rooms[1].number, lockAddress: '01010100100' }] })
      .expect(200);
    await api('km.manager')
      .put(`${KM}/door-locks/rooms`, { rooms: [{ number: rooms[0].number, lockAddress: '01010100100' }, { number: rooms[1].number, lockAddress: '01010100200' }] })
      .expect(200);
    await api('km.manager').put(`${KM}/door-locks/settings`, { enabled: true }).expect(200);
  });

  it('pairs the encoder PC with a token only that property accepts', async () => {
    const paired = await api('km.manager').post(`${KM}/door-locks/bridge/pair`).expect(200);
    bridgeToken = paired.body.token;
    expect(bridgeToken.length).toBeGreaterThanOrEqual(40);
    expect(paired.body.settings.bridge).toMatchObject({ paired: true, online: false });
    await bridge('not-a-real-token').claim().expect(401);
    await request(http).post('/api/door-locks/bridge/claim').set('Authorization', `Bearer ${tokens['km.manager']}`).send({ bridgeId: BRIDGE_ID, version: 'x', mode: 'mock' }).expect(401);
    const hello = await bridge().claim().expect(200);
    expect(hello.body).toMatchObject({ property: 'KM', job: null, comPort: 3 });
    const status = await api('km.reception').get(`${KM}/door-locks/settings`).expect(200);
    expect(status.body.bridge).toMatchObject({ online: true, bridgeId: BRIDGE_ID, mode: 'mock' });
    // The bridge token is not a user token.
    await request(http).get(`${KM}/door-locks/settings`).set('Authorization', `Bearer ${bridgeToken}`).expect(401);
  });

  let first: { id: string; number: string };
  let firstCardNo = 0;

  it('makes a new card and a copy at check-in (FD-03), in that order, with the stay’s dates', async () => {
    first = await checkedIn(0);
    const before = await api('km.reception').post(`${KM}/stays/${first.id}/key-cards`, { kind: 'duplicate' }).expect(409);
    expect(before.body.error).toBe('new_card_required');

    const key = uniqueKey();
    const res = await api('km.reception').post(`${KM}/stays/${first.id}/key-cards`, { kind: 'new', count: 2 }, key).expect(201);
    expect(res.body.map((c: { kind: string; status: string }) => [c.kind, c.status])).toEqual([['new', 'pending'], ['duplicate', 'pending']]);
    // Retrying the same request does not queue more cards.
    const again = await api('km.reception').post(`${KM}/stays/${first.id}/key-cards`, { kind: 'new', count: 2 }, key).expect(201);
    expect(again.body.map((c: { id: string }) => c.id)).toEqual(res.body.map((c: { id: string }) => c.id));

    const jobs = await drain();
    expect(jobs.map((j) => j.kind)).toEqual(['new', 'duplicate']);
    const [n, d] = jobs.map((j) => j.keyCard!);
    expect(n).toMatchObject({
      systemCode: 'A1B2C3', hotelCode: '0042', cardPass: '82A094FFFFFF', address: '01010100100', terminateOld: 1, levelPass: 3, passMode: 1,
      addressMode: 0, addressQty: 1, nBlock: 4, encrypt: 1, validTimes: 255, sdOut: '31-07-10', stOut: '10:15:00',
    });
    expect(d).toMatchObject({ roomPass: n.roomPass, terminateOld: 0, address: '01010100100' });
    expect(d.cardNo).toBe((n.cardNo as number) + 1);
    firstCardNo = n.cardNo as number;

    const list = await api('km.reception').get(`${KM}/stays/${first.id}/key-cards`).expect(200);
    expect(list.body).toMatchObject({ enabled: true, encoderOnline: true, canIssueNew: true, canIssueDuplicate: true, warnings: [] });
    expect(list.body.cards.map((c: { state: string }) => c.state)).toEqual(['active', 'active']);

    const extra = await api('km.reception').post(`${KM}/stays/${first.id}/key-cards`, { kind: 'duplicate' }).expect(201);
    const [dupJob] = await drain();
    expect(dupJob.id).toBe(extra.body[0].id);
    expect(dupJob.keyCard).toMatchObject({ roomPass: n.roomPass, terminateOld: 0 });
  });

  it('gives each new card for a room a newer room password', async () => {
    const r1 = await api('km.reception').post(`${KM}/stays/${first.id}/key-cards`, { kind: 'new' }).expect(201);
    const [a] = await drain();
    const r2 = await api('km.reception').post(`${KM}/stays/${first.id}/key-cards`, { kind: 'new' }).expect(201);
    const [b] = await drain();
    expect([a.id, b.id]).toEqual([r1.body[0].id, r2.body[0].id]);
    expect(parseInt(b.keyCard!.roomPass as string, 16)).toBeGreaterThan(parseInt(a.keyCard!.roomPass as string, 16));
  });

  it('cancels the copies when the new card fails, and reports the encoder error', async () => {
    const stay = await checkedIn(2);
    await api('km.reception').post(`${KM}/stays/${stay.id}/key-cards`, { kind: 'new', count: 3 }).expect(201);
    const claimed = await bridge().claim().expect(200);
    // One encoder: nothing else is handed out while a card is being written.
    expect((await bridge().claim().expect(200)).body.job).toBeNull();
    await bridge().result(claimed.body.job.id, { outcome: 'failed', errorCode: 3, error: 'KeyCard returned 3 (no card on the encoder?)' }).expect(200);
    await bridge().result(claimed.body.job.id, { outcome: 'done' }).expect(409);
    expect(await drain()).toEqual([]);
    const list = await api('km.reception').get(`${KM}/stays/${stay.id}/key-cards`).expect(200);
    expect(list.body.cards.map((c: { status: string }) => c.status).sort()).toEqual(['cancelled', 'cancelled', 'failed']);
    expect(list.body.cards.find((c: { status: string }) => c.status === 'failed')).toMatchObject({ errorCode: 3 });
    expect(list.body.canIssueDuplicate).toBe(false);
  });

  it('lets reception cancel a card still waiting for the encoder', async () => {
    const res = await api('km.reception').post(`${KM}/stays/${first.id}/key-cards`, { kind: 'duplicate' }).expect(201);
    const cancelled = await api('km.reception').post(`${KM}/door-locks/jobs/${res.body[0].id}/cancel`).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    await api('km.reception').post(`${KM}/door-locks/jobs/${res.body[0].id}/cancel`).expect(409);
    expect(await drain()).toEqual([]);
  });

  it('keeps the keys history through a room move (FD-05) and warns about the old room’s cards', async () => {
    const moved = await api('km.reception').post(`${KM}/stays/${first.id}/move`, { toRoomId: rooms[1].id, reason: 'Guest asked for a quieter room' }).expect(200);
    expect(moved.body.toRoom).toBe(rooms[1].number);
    const after = await api('km.reception').get(`${KM}/stays/${first.id}/key-cards`).expect(200);
    expect(after.body.cards.every((c: { state?: string }) => !c.state || c.state === 'moved')).toBe(true);
    expect(after.body.warnings.join(' ')).toMatch(/previous room/);
    expect(after.body.canIssueDuplicate).toBe(false);
    await api('km.reception').post(`${KM}/stays/${first.id}/key-cards`, { kind: 'new' }).expect(201);
    const [job] = await drain();
    expect(job.keyCard).toMatchObject({ address: '01010100200', terminateOld: 1 });
    const now = await api('km.reception').get(`${KM}/stays/${first.id}/key-cards`).expect(200);
    expect(now.body.cards[0]).toMatchObject({ roomNumber: rooms[1].number, state: 'active' });
    expect(now.body.cards.filter((c: { roomNumber: string }) => c.roomNumber === rooms[0].number).length).toBeGreaterThan(0);
  });

  it('reads a card on the encoder and finds whose it is', async () => {
    const req = await api('km.reception').post(`${KM}/door-locks/read-card`).expect(200);
    expect(req.body).toMatchObject({ kind: 'read', status: 'pending' });
    const [job] = await drain(() => ({ outcome: 'done', cardNo: firstCardNo, systemCode: 'A1B2C3' }));
    expect(job).toMatchObject({ id: req.body.id, kind: 'read', read: { nBlock: 4, encrypt: 1, cardPass: '82A094FFFFFF' } });
    const res = await api('km.reception').get(`${KM}/door-locks/jobs/${req.body.id}`).expect(200);
    expect(res.body).toMatchObject({ status: 'done', readCardNo: firstCardNo });
    expect(res.body.matched).toMatchObject({ stayNumber: first.number, roomNumber: rooms[0].number, state: 'moved', cardNo: firstCardNo });
  });

  it('refuses cards for a room without an address, and keeps other properties out', async () => {
    const stay = await checkedIn(4);
    const res = await api('km.reception').post(`${KM}/stays/${stay.id}/key-cards`, { kind: 'new' }).expect(409);
    expect(res.body.error).toBe('no_lock_address');
    await api('k1.reception').get(`${KM}/stays/${stay.id}/key-cards`).expect(403);
    await api('k1.reception').post(`/api/properties/K1/stays/${stay.id}/key-cards`, { kind: 'new' }).expect(404);
    await api('km.waiter').post(`${KM}/stays/${stay.id}/key-cards`, { kind: 'new' }).expect(403);
  });

  it('stops working with the old token once the PC is paired again', async () => {
    const old = bridgeToken;
    const paired = await api('km.manager').post(`${KM}/door-locks/bridge/pair`).expect(200);
    bridgeToken = paired.body.token;
    await bridge(old).claim().expect(401);
    await bridge().claim().expect(200);
  });
});
