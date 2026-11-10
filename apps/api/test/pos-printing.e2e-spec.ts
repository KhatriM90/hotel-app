import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { login, ownerClient, startApp, uniqueKey } from './helpers';

/**
 * Network printing through the POS bridge (INT-04), from the Kahama meeting
 * (item 2.4): tickets print on the station's printer, failures are retried,
 * moved to a backup printer and shown as alerts until someone deals with them.
 */
describe('POS printing through the property bridge (INT-04)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const tokens: Record<string, string> = {};
  const USERS = ['km.waiter', 'km.manager', 'k1.manager'];
  const KM = '/api/properties/KM';
  const POS = `${KM}/pos`;
  const BRIDGE_ID = 'KM-CASHIER-PC';
  let bridgeToken = '';
  let outlet = '';
  let station = '';
  let water = '';
  let mainPrinter = '';
  let backupPrinter = '';

  const api = (user: string) => ({
    get: (path: string) => request(http).get(path).set('Authorization', `Bearer ${tokens[user]}`),
    post: (path: string, body: object = {}, key = uniqueKey()) =>
      request(http).post(path).set('Authorization', `Bearer ${tokens[user]}`).set('Idempotency-Key', key).send(body),
    put: (path: string, body: object) => request(http).put(path).set('Authorization', `Bearer ${tokens[user]}`).send(body),
    patch: (path: string, body: object) => request(http).patch(path).set('Authorization', `Bearer ${tokens[user]}`).send(body),
  });
  const bridge = (token = bridgeToken) => ({
    claim: () => request(http).post('/api/pos-bridge/claim').set('Authorization', `Bearer ${token}`).send({ bridgeId: BRIDGE_ID, version: 'test', mode: 'mock' }),
    result: (id: string, outcome: 'printed' | 'failed', error?: string) =>
      request(http).post(`/api/pos-bridge/jobs/${id}/result`).set('Authorization', `Bearer ${token}`).send({ bridgeId: BRIDGE_ID, outcome, error }),
  });
  const sql = async (text: string, params: unknown[] = []) => {
    const owner = await ownerClient();
    try {
      return (await owner.query(text, params)).rows;
    } finally {
      await owner.end();
    }
  };
  /** Makes retries due at once instead of after their back-off. */
  const due = () => sql(`UPDATE print_jobs SET next_attempt_at = now() WHERE status = 'queued'`);
  const sendOrder = async () => {
    const check = (await api('km.waiter').post(`${POS}/outlets/${outlet}/checks`, { serviceType: 'counter' }).expect(201)).body;
    await api('km.waiter').post(`${POS}/checks/${check.id}/lines`, { lines: [{ portionId: water, quantity: '2', notes: 'No ice' }] }).expect(200);
    const sent = await api('km.waiter').post(`${POS}/checks/${check.id}/send`).expect(200);
    return { check, ticket: sent.body.tickets[0] as { id: string; number: string; printer: string | null; printJobId: string | null } };
  };

  beforeAll(async () => {
    app = await startApp();
    http = app.getHttpServer();
    for (const u of USERS) tokens[u] = await login(app, u);
    await sql(`UPDATE properties SET current_business_date = (now() AT TIME ZONE 'Africa/Nairobi')::date WHERE code = 'KM'`);
    const rows = await sql(
      `SELECT o.code AS outlet, s.code AS station FROM outlets o
         JOIN outlet_menu_prices mp ON mp.outlet_id = o.id JOIN menu_items i ON i.id = mp.item_id AND i.code = 'SD-WATER'
         JOIN menu_categories mc ON mc.id = i.category_id
         JOIN outlet_station_routes r ON r.outlet_id = o.id JOIN pos_stations s ON s.id = r.station_id
        WHERE o.property_id = (SELECT id FROM properties WHERE code = 'KM') AND o.pos_enabled AND o.is_active
          -- Not the first such outlet: the tablets suite trades there and closes its day when it ends.
          AND o.code > (SELECT min(o2.code) FROM outlets o2 JOIN outlet_menu_prices mp2 ON mp2.outlet_id = o2.id
                          JOIN menu_items i2 ON i2.id = mp2.item_id AND i2.code = 'SD-WATER'
                         WHERE o2.property_id = o.property_id AND o2.pos_enabled AND o2.is_active)
        ORDER BY o.code, r.route = 'bar' DESC LIMIT 1`,
    );
    outlet = rows[0].outlet;
    const menu = (await api('km.manager').get(`${POS}/outlets/${outlet}/menu`).expect(200)).body.items as Array<{ code: string; portionId: string }>;
    water = menu.find((i) => i.code === 'SD-WATER')!.portionId;
    // Whichever station the water goes to gets the printer.
    const probe = (await api('km.waiter').post(`${POS}/outlets/${outlet}/checks`, { serviceType: 'counter' }).expect(201)).body;
    await api('km.waiter').post(`${POS}/checks/${probe.id}/lines`, { lines: [{ portionId: water, quantity: '1' }] }).expect(200);
    const sent = (await api('km.waiter').post(`${POS}/checks/${probe.id}/send`).expect(200)).body;
    station = sent.tickets[0].station;
    expect(sent.tickets[0].printer).toBeNull(); // no printer yet: nothing queued
    void rows;
  });

  afterAll(async () => {
    await sql(
      `UPDATE pos_outlet_days SET status = 'closed', closed_at = now(), finalised_at = now(), totals = '{"test": true}'
        WHERE status = 'open' AND property_id = (SELECT id FROM properties WHERE code = 'KM')`,
    );
    await app.close();
  });

  it('managers set up printers, a backup, the station and the receipt printer; waiters cannot', async () => {
    await api('km.waiter').post(`${POS}/printers`, { code: 'BAR-P', name: 'Bar printer', connection: 'network', host: '192.168.1.50' }).expect(403);
    await api('km.manager').post(`${POS}/printers`, { code: 'NOHOST', name: 'No host', connection: 'network' }).expect(400);
    backupPrinter = (await api('km.manager').post(`${POS}/printers`, { code: 'CASHIER-P', name: 'Cashier printer', connection: 'windows', windowsName: 'EPSON TM-T20III Receipt' }).expect(201)).body.id;
    const main = await api('km.manager')
      .post(`${POS}/printers`, { code: 'BAR-P', name: 'Bar printer', connection: 'network', host: '192.168.1.50', backupPrinterId: backupPrinter })
      .expect(201);
    mainPrinter = main.body.id;
    expect(main.body).toMatchObject({ connection: 'network', host: '192.168.1.50', port: 9100, paperMm: 80, backupPrinterName: 'Cashier printer' });
    await api('km.manager').post(`${POS}/printers`, { code: 'BAR-P', name: 'Again', connection: 'network', host: '10.0.0.1' }).expect(409);
    await api('km.manager').patch(`${POS}/printers/${mainPrinter}`, { backupPrinterId: mainPrinter }).expect(409);
    // A printer elsewhere cannot be used here.
    await api('k1.manager').put('/api/properties/K1/pos/printer-assignments', { station, printerId: mainPrinter }).expect(404);

    await api('km.manager').put(`${POS}/printer-assignments`, { station, printerId: mainPrinter }).expect(200);
    await api('km.manager').put(`${POS}/printer-assignments`, { outlet, printerId: backupPrinter }).expect(200);
    const setup = await api('km.manager').get(`${POS}/printers`).expect(200);
    expect(setup.body.stations.find((s: { code: string }) => s.code === station).printerId).toBe(mainPrinter);
    expect(setup.body.outlets.find((o: { code: string }) => o.code === outlet).printerId).toBe(backupPrinter);
    expect(setup.body.bridge).toMatchObject({ paired: false, online: false });
  });

  it('pairs the bridge; only its token can claim, and only for its property', async () => {
    await bridge('not-a-token-not-a-token-not-a-token').claim().expect(401);
    const pair = await api('km.manager').post(`${POS}/bridge/pair`).expect(200);
    bridgeToken = pair.body.token;
    const res = await bridge().claim().expect(200);
    expect(res.body).toMatchObject({ property: 'KM', job: null });
    const setup = await api('km.manager').get(`${POS}/printers`).expect(200);
    expect(setup.body.bridge).toMatchObject({ paired: true, online: true, bridgeId: BRIDGE_ID, mode: 'mock' });
    // A door-lock or user token is not a POS bridge token.
    await request(http).post('/api/pos-bridge/claim').set('Authorization', `Bearer ${tokens['km.manager']}`).send({ bridgeId: BRIDGE_ID, version: 't', mode: 'mock' }).expect(401);
  });

  it('a sent order prints on the station printer as ESC/POS and the ticket shows it printed', async () => {
    const { ticket } = await sendOrder();
    expect(ticket).toMatchObject({ printer: 'Bar printer' });
    const claim = await bridge().claim().expect(200);
    const job = claim.body.job;
    expect(job).toMatchObject({ id: ticket.printJobId, attempt: 1, printer: { name: 'Bar printer', connection: 'network', host: '192.168.1.50', port: 9100 } });
    const bytes = Buffer.from(job.payloadBase64, 'base64');
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]); // ESC @
    const text = bytes.toString('latin1');
    expect(text).toContain(ticket.number);
    expect(text).toContain('2 x Mineral water');
    expect(text).toContain('NOTE: No ice');
    // Nothing else is due while that one prints.
    expect((await bridge().claim().expect(200)).body.job).toBeNull();
    expect((await bridge().result(job.id, 'printed').expect(200)).body.status).toBe('printed');
    await bridge().result(job.id, 'printed').expect(409);
    const tickets = (await api('km.manager').get(`${POS}/stations/${station}/tickets`).expect(200)).body as Array<{ id: string; print: { status: string; printer: string } }>;
    expect(tickets.find((t) => t.id === ticket.id)!.print).toMatchObject({ status: 'printed', printer: 'Bar printer' });
  });

  it('retries a failing printer three times, then moves the ticket to the backup and raises an alert', async () => {
    const { ticket } = await sendOrder();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await due();
      const job = (await bridge().claim().expect(200)).body.job;
      expect(job).toMatchObject({ id: ticket.printJobId, attempt });
      await bridge().result(job.id, 'failed', 'Paper out').expect(200);
    }
    const failed = (await api('km.waiter').get(`${POS}/print-jobs/${ticket.printJobId}`).expect(200)).body;
    expect(failed).toMatchObject({ status: 'failed', attempts: 3, replacedByPrinter: 'Cashier printer', replacedByStatus: 'queued' });
    expect(failed.error).toBe('Paper out Sent to Cashier printer instead.');

    const alerts = (await api('km.waiter').get(`${POS}/print-alerts?outlet=${outlet}`).expect(200)).body as Array<{ id: string; title: string }>;
    expect(alerts.map((a) => a.id)).toContain(ticket.printJobId);
    expect((await api('km.manager').get(`${POS}/print-alerts?station=${station}`).expect(200)).body.map((a: { id: string }) => a.id)).toContain(ticket.printJobId);

    // The backup copy prints; it does not move on again if it fails.
    const copy = (await bridge().claim().expect(200)).body.job;
    expect(copy).toMatchObject({ id: failed.replacedById, printer: { name: 'Cashier printer', connection: 'windows', windowsName: 'EPSON TM-T20III Receipt' } });
    expect(copy.title).toContain('(backup printer)');
    await bridge().result(copy.id, 'printed').expect(200);

    // The waiter deals with the alert.
    await api('km.waiter').post(`${POS}/print-jobs/${ticket.printJobId}/acknowledge`).expect(200);
    await api('km.waiter').post(`${POS}/print-jobs/${ticket.printJobId}/acknowledge`).expect(409);
    expect((await api('km.waiter').get(`${POS}/print-alerts?outlet=${outlet}`).expect(200)).body.map((a: { id: string }) => a.id)).not.toContain(ticket.printJobId);
  });

  it('a staff member sends a failed print again; a reprinted ticket prints too', async () => {
    const { ticket } = await sendOrder();
    await sql(`UPDATE pos_printers SET backup_printer_id = NULL WHERE id = $1`, [mainPrinter]);
    for (let i = 0; i < 3; i++) {
      await due();
      const job = (await bridge().claim().expect(200)).body.job;
      await bridge().result(job.id, 'failed', 'Cover open').expect(200);
    }
    const failed = (await api('km.waiter').get(`${POS}/print-jobs/${ticket.printJobId}`).expect(200)).body;
    expect(failed).toMatchObject({ status: 'failed', error: 'Cover open', replacedById: null });
    await api('km.waiter').post(`${POS}/print-jobs/${ticket.printJobId}/retry`, { printerId: backupPrinter }).expect(200);
    await api('km.waiter').post(`${POS}/print-jobs/${ticket.printJobId}/retry`).expect(200); // still failed: may go again
    const after = (await api('km.waiter').get(`${POS}/print-alerts?outlet=${outlet}`).expect(200)).body.map((a: { id: string }) => a.id);
    expect(after).not.toContain(ticket.printJobId);
    let job = (await bridge().claim().expect(200)).body.job;
    expect(job.printer.name).toBe('Cashier printer');
    await bridge().result(job.id, 'printed').expect(200);
    job = (await bridge().claim().expect(200)).body.job;
    await bridge().result(job.id, 'printed').expect(200);

    const re = await api('km.manager').post(`${POS}/tickets/${ticket.id}/reprint`, { reason: 'Kitchen lost it' }).expect(200);
    expect(re.body.printer).toBe('Bar printer');
    job = (await bridge().claim().expect(200)).body.job;
    expect(Buffer.from(job.payloadBase64, 'base64').toString('latin1')).toContain('REPRINT #2');
    await bridge().result(job.id, 'printed').expect(200);
  });

  it('a bill goes to the outlet receipt printer; the tablet does not have to print it', async () => {
    const { check } = await sendOrder();
    await due();
    const t = (await bridge().claim().expect(200)).body.job;
    await bridge().result(t.id, 'printed').expect(200);
    const bill = await api('km.waiter').post(`${POS}/checks/${check.id}/print`).expect(200);
    expect(bill.body).toMatchObject({ kind: 'bill', printer: 'Cashier printer' });
    const job = (await bridge().claim().expect(200)).body.job;
    expect(job.id).toBe(bill.body.printJobId);
    const text = Buffer.from(job.payloadBase64, 'base64').toString('latin1');
    expect(text).toContain('BILL');
    expect(text).toContain('BALANCE DUE');
    expect(text).toContain('KRA PIN');
    await bridge().result(job.id, 'printed').expect(200);
  });

  it('a claim nobody answers counts as a failed try; when the bridge stops, waiting jobs fail with a clear message', async () => {
    const { ticket } = await sendOrder();
    const job = (await bridge().claim().expect(200)).body.job;
    await sql(`UPDATE print_jobs SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [job.id]);
    const lapsed = (await api('km.waiter').get(`${POS}/print-jobs/${ticket.printJobId}`).expect(200)).body;
    expect(lapsed).toMatchObject({ status: 'queued', attempts: 1, error: 'The POS bridge did not report back from the printer.' });
    await bridge().result(job.id, 'printed').expect(409); // too late

    // The bridge PC goes off.
    await sql(`UPDATE pos_bridges SET last_seen_at = now() - interval '10 minutes' WHERE property_id = (SELECT id FROM properties WHERE code = 'KM')`);
    const { ticket: second } = await sendOrder();
    await sql(`UPDATE print_jobs SET created_at = now() - interval '2 minutes' WHERE id = $1`, [second.printJobId]);
    const alerts = (await api('km.waiter').get(`${POS}/print-alerts?outlet=${outlet}`).expect(200)).body as Array<{ id: string; error: string }>;
    expect(alerts.find((a) => a.id === second.printJobId)!.error).toContain('POS bridge at this property is not running');
  });

  it('test prints, the back-office job list, and unpairing', async () => {
    const t = await api('km.manager').post(`${POS}/printers/${mainPrinter}/test`).expect(200);
    expect(t.body).toMatchObject({ kind: 'test', status: 'queued', printer: 'Bar printer' });
    await api('km.waiter').post(`${POS}/printers/${mainPrinter}/test`).expect(403);
    const all = (await api('km.manager').get(`${POS}/print-jobs`).expect(200)).body as Array<{ status: string }>;
    expect(all.some((j) => j.status === 'printed')).toBe(true);
    const failedOnly = (await api('km.manager').get(`${POS}/print-jobs?failed=true`).expect(200)).body as Array<{ status: string }>;
    expect(failedOnly.length).toBeGreaterThan(0);
    expect(failedOnly.every((j) => j.status === 'failed')).toBe(true);
    await api('km.manager').post(`${POS}/bridge/unpair`).expect(200);
    await bridge().claim().expect(401);
  });
});
