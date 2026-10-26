import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { login, ownerClient, startApp, uniqueKey } from './helpers';

describe('API: auth, property scope and idempotency', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    app = await startApp();
    http = app.getHttpServer();
    for (const u of ['owner', 'group.accounts', 'k1.manager', 'k1.waiter', 'km.reception']) {
      tokens[u] = await login(app, u);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });

  describe('authentication (SEC-03)', () => {
    it('health is public', async () => {
      const res = await request(http).get('/api/health').expect(200);
      expect(res.body).toMatchObject({ status: 'ok', db: 'ok' });
      expect(res.headers['x-request-id']).toBeDefined();
    });

    it('rejects a wrong password and unknown users the same way', async () => {
      await request(http).post('/api/auth/login').send({ username: 'owner', password: 'wrong-password' }).expect(401);
      await request(http).post('/api/auth/login').send({ username: 'nobody', password: 'wrong-password' }).expect(401);
    });

    it('rejects missing and forged tokens', async () => {
      await request(http).get('/api/properties').expect(401);
      await request(http).get('/api/properties').set('Authorization', 'Bearer not-a-jwt').expect(401);
    });

    it('returns the current user with roles', async () => {
      const res = await request(http).get('/api/auth/me').set(auth('km.reception')).expect(200);
      expect(res.body).toMatchObject({ username: 'km.reception', roles: ['receptionist'], allProperties: false });
    });

    it('locks out a deactivated user immediately, even with a valid token', async () => {
      const owner = await ownerClient();
      try {
        await owner.query(`UPDATE users SET is_active = false WHERE username = 'k1.waiter'`);
        await request(http).get('/api/auth/me').set(auth('k1.waiter')).expect(401);
      } finally {
        await owner.query(`UPDATE users SET is_active = true WHERE username = 'k1.waiter'`);
        await owner.end();
      }
    });
  });

  describe('property isolation (SEC-06, AT-18)', () => {
    it('a Kahama receptionist sees only Kahama', async () => {
      const res = await request(http).get('/api/properties').set(auth('km.reception')).expect(200);
      expect(res.body.map((p: { code: string }) => p.code)).toEqual(['KM']);
    });

    it('a Kahama receptionist cannot read K1 outlets', async () => {
      await request(http).get('/api/properties/K1/outlets').set(auth('km.reception')).expect(403);
      await request(http).get('/api/properties/K1').set(auth('km.reception')).expect(403);
    });

    it('group accounts see all three properties', async () => {
      const res = await request(http).get('/api/properties').set(auth('group.accounts')).expect(200);
      expect(res.body.map((p: { code: string }) => p.code)).toEqual(['K1', 'KM', 'SW']);
    });

    it('scopes property routes to that property only', async () => {
      const res = await request(http).get('/api/properties/SW/outlets').set(auth('owner')).expect(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body.every((o: { code: string }) => o.code.startsWith('SW-'))).toBe(true);
    });

    it('a K1 manager cannot create outlets at Small World', async () => {
      await request(http)
        .post('/api/properties/SW/outlets')
        .set(auth('k1.manager'))
        .set('Idempotency-Key', uniqueKey())
        .send({ code: 'SW-POOL', name: 'Pool bar', type: 'bar', revenueCentre: 'BAR' })
        .expect(403);
    });
  });

  describe('permissions (SEC-02)', () => {
    it('a waiter cannot manage outlets', async () => {
      await request(http)
        .post('/api/properties/K1/outlets')
        .set(auth('k1.waiter'))
        .set('Idempotency-Key', uniqueKey())
        .send({ code: 'K1-NOPE', name: 'Nope', type: 'bar', revenueCentre: 'BAR' })
        .expect(403);
    });
  });

  describe('idempotency (§9, BIL-04, AT-03)', () => {
    const outlet = (code: string) => ({
      code,
      name: 'Pool bar (test)',
      type: 'bar',
      revenueCentre: 'BAR',
      issuingWarehouseCode: '8', // PSH_COCKTAIL BAR
      sellsAlcohol: true,
    });

    it('requires an Idempotency-Key header', async () => {
      const res = await request(http).post('/api/properties/K1/outlets').set(auth('k1.manager')).send(outlet('K1-T1')).expect(400);
      expect(res.body.message).toMatch(/Idempotency-Key/);
    });

    it('replays the original response on retry and creates exactly one record', async () => {
      const key = uniqueKey();
      const first = await request(http)
        .post('/api/properties/K1/outlets')
        .set(auth('k1.manager'))
        .set('Idempotency-Key', key)
        .send(outlet('K1-T2'))
        .expect(201);
      const retry = await request(http)
        .post('/api/properties/K1/outlets')
        .set(auth('k1.manager'))
        .set('Idempotency-Key', key)
        .send(outlet('K1-T2'))
        .expect(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);

      const list = await request(http).get('/api/properties/K1/outlets').set(auth('k1.manager')).expect(200);
      expect(list.body.filter((o: { code: string }) => o.code === 'K1-T2')).toHaveLength(1);
    });

    it('rejects reuse of a key with a different body', async () => {
      const key = uniqueKey();
      await request(http).post('/api/properties/K1/outlets').set(auth('k1.manager')).set('Idempotency-Key', key).send(outlet('K1-T3')).expect(201);
      await request(http).post('/api/properties/K1/outlets').set(auth('k1.manager')).set('Idempotency-Key', key).send(outlet('K1-T4')).expect(422);
    });

    it('concurrent duplicates produce one record and identical responses', async () => {
      const key = uniqueKey();
      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          request(http).post('/api/properties/K1/outlets').set(auth('k1.manager')).set('Idempotency-Key', key).send(outlet('K1-T5')),
        ),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(6).fill(201));
      expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    });

    it('frees the key when the request fails, so a corrected retry can succeed', async () => {
      const key = uniqueKey();
      await request(http)
        .post('/api/properties/K1/outlets')
        .set(auth('k1.manager'))
        .set('Idempotency-Key', key)
        .send({ ...outlet('K1-T6'), issuingWarehouseCode: '27' }) // SWCC_MAIN BAR
        .expect(400);
      await request(http)
        .post('/api/properties/K1/outlets')
        .set(auth('k1.manager'))
        .set('Idempotency-Key', key)
        .send({ ...outlet('K1-T6'), issuingWarehouseCode: '27' })
        .expect(400);
      // 400 from service validation inside the transaction → rolled back → no stored key
      const owner = await ownerClient();
      try {
        const { rowCount } = await owner.query('SELECT 1 FROM idempotency_keys WHERE key = $1', [key]);
        expect(rowCount).toBe(0);
      } finally {
        await owner.end();
      }
    });
  });

  describe('audit (SEC-04)', () => {
    it('records who created an outlet, in the same transaction', async () => {
      const res = await request(http)
        .post('/api/properties/K1/outlets')
        .set(auth('k1.manager'))
        .set('Idempotency-Key', uniqueKey())
        .send({ code: 'K1-T7', name: 'Audit test', type: 'other', revenueCentre: 'OTHER' })
        .expect(201);
      const owner = await ownerClient();
      try {
        const { rows } = await owner.query(
          `SELECT a.action, u.username, a.request_id IS NOT NULL AS has_request
             FROM audit_events a JOIN users u ON u.id = a.actor_user_id
            WHERE a.entity_type = 'outlet' AND a.entity_id = $1`,
          [res.body.id],
        );
        expect(rows).toEqual([{ action: 'outlet.create', username: 'k1.manager', has_request: true }]);
      } finally {
        await owner.end();
      }
    });
  });
});
