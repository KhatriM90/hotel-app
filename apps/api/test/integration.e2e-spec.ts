import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { login, ownerClient, startApp, uniqueKey } from './helpers';

describe('SAP integration outbox and worker pull API (INT-07, SAP-11, OPS-02)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let admin: string;
  let kmReception: string;
  const worker = { Authorization: `Bearer ${process.env.WORKER_TOKEN}` };

  beforeAll(async () => {
    app = await startApp();
    http = app.getHttpServer();
    admin = await login(app, 'admin');
    kmReception = await login(app, 'km.reception');
    // Start from a clean queue: post anything left from other suites.
    const owner = await ownerClient();
    await owner.query(`UPDATE integration_outbox SET status = 'posted', sap_doc_entry = 1 WHERE status <> 'posted'`);
    await owner.end();
  });

  afterAll(async () => {
    await app.close();
  });

  async function sampleInvoice(property = 'K1', key = uniqueKey()) {
    const res = await request(http)
      .post(`/api/properties/${property}/integration/sap/sample-invoice`)
      .set('Authorization', `Bearer ${admin}`)
      .set('Idempotency-Key', key)
      .send({})
      .expect(201);
    return res.body as { id: string; externalRef: string; status: string };
  }

  async function claim(workerId: string, limit = 10) {
    const res = await request(http).post('/api/integration/worker/claim').set(worker).send({ workerId, limit }).expect(200);
    return res.body.jobs as Array<{ id: string; externalRef: string; property: { code: string; sapDimension1: string } }>;
  }

  it('queues a numbered invoice exactly once per idempotency key', async () => {
    const key = uniqueKey();
    const a = await sampleInvoice('K1', key);
    const b = await sampleInvoice('K1', key);
    expect(a.externalRef).toMatch(/^K1-INV-\d{6}$/);
    expect(b).toEqual(a);
    expect(a.status).toBe('pending');
  });

  it('rejects the worker API without the worker token', async () => {
    await request(http).post('/api/integration/worker/claim').send({ workerId: 'hq-1' }).expect(401);
    await request(http)
      .post('/api/integration/worker/claim')
      .set('Authorization', `Bearer ${admin}`)
      .send({ workerId: 'hq-1' })
      .expect(401);
  });

  it('hands each job to one worker with property mapping context', async () => {
    const queued = await sampleInvoice('SW');
    const jobs = await claim('hq-1');
    const job = jobs.find((j) => j.id === queued.id);
    expect(job).toBeDefined();
    expect(job!.property).toMatchObject({ code: 'SW', sapDimension1: 'SW' });
    const second = await claim('hq-2');
    expect(second.find((j) => j.id === queued.id)).toBeUndefined();

    await request(http)
      .post(`/api/integration/worker/jobs/${queued.id}/result`)
      .set(worker)
      .send({ workerId: 'hq-1', outcome: 'posted', docEntry: 501, docNum: 10501 })
      .expect(200);
    // A duplicate result report is refused; the row is final.
    await request(http)
      .post(`/api/integration/worker/jobs/${queued.id}/result`)
      .set(worker)
      .send({ workerId: 'hq-1', outcome: 'posted', docEntry: 502 })
      .expect(409);
  });

  it('backs off retryable failures and dead-letters rejected documents for authorised replay (SAP-AT05, SAP-AT06)', async () => {
    const queued = await sampleInvoice('K1');
    await claim('hq-1');
    const failed = await request(http)
      .post(`/api/integration/worker/jobs/${queued.id}/result`)
      .set(worker)
      .send({ workerId: 'hq-1', outcome: 'failed', error: 'ECONNREFUSED', retryable: true })
      .expect(200);
    expect(failed.body.status).toBe('failed');
    expect(new Date(failed.body.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    expect((await claim('hq-1')).find((j) => j.id === queued.id)).toBeUndefined();

    const owner = await ownerClient();
    await owner.query(`UPDATE integration_outbox SET next_attempt_at = now() WHERE id = $1`, [queued.id]);
    await owner.end();
    expect((await claim('hq-1')).find((j) => j.id === queued.id)).toBeDefined();
    const dead = await request(http)
      .post(`/api/integration/worker/jobs/${queued.id}/result`)
      .set(worker)
      .send({ workerId: 'hq-1', outcome: 'failed', error: 'Invalid tax code', retryable: false })
      .expect(200);
    expect(dead.body.status).toBe('dead');

    const list = await request(http)
      .get('/api/properties/K1/integration/sap/outbox?status=dead')
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
    expect(list.body.map((r: { id: string }) => r.id)).toContain(queued.id);

    const replayed = await request(http)
      .post(`/api/properties/K1/integration/sap/outbox/${queued.id}/replay`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ reason: 'Tax code corrected in SAP' })
      .expect(200);
    expect(replayed.body.status).toBe('pending');
  });

  it('re-issues an expired claim to another worker and refuses the stale worker (SAP-AT04 safety)', async () => {
    const queued = await sampleInvoice('KM');
    await claim('hq-1');
    const owner = await ownerClient();
    await owner.query(`UPDATE integration_outbox SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [queued.id]);
    await owner.end();
    expect((await claim('hq-2')).find((j) => j.id === queued.id)).toBeDefined();
    await request(http)
      .post(`/api/integration/worker/jobs/${queued.id}/result`)
      .set(worker)
      .send({ workerId: 'hq-1', outcome: 'posted', docEntry: 9 })
      .expect(409);
  });

  it('hides another property’s integration queue (AT-18)', async () => {
    await request(http)
      .get('/api/properties/K1/integration/sap/outbox')
      .set('Authorization', `Bearer ${kmReception}`)
      .expect(403);
  });
});
