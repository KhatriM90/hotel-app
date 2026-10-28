import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { addDays } from '@hotel/shared';
import { login, ownerClient, startApp, uniqueKey } from './helpers';

/**
 * Point of sale end to end against PostgreSQL. Acceptance tests from brief §10:
 * AT-02 (room charge), AT-03 (duplicate payment), AT-04 (outlet price and
 * isolation), AT-07 (partial payment then room charge), AT-09 (charge racing
 * checkout), AT-10 (void after preparation), AT-13 (cash out), AT-14 (waiter
 * refund), AT-18 (property isolation); BIL-02, BIL-11; POS-01 … POS-19; POS day close.
 */
describe('Point of sale (POS, BIL-02/11/12, AT-02/03/07/09/10/13/14/18)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const tokens: Record<string, string> = {};
  const USERS = [
    'owner', 'k1.manager', 'k1.waiter', 'k1.cashier', 'k1.bartender', 'k1.kitchen', 'k1.reception',
    'sw.manager', 'sw.waiter', 'sw.reception', 'km.waiter', 'km.manager',
  ];
  const K1 = '/api/properties/K1';
  const POS = `${K1}/pos`;
  const MANAGER = { username: 'k1.manager', password: process.env.SEED_PASSWORD! };

  const api = (user: string) => ({
    get: (path: string) => request(http).get(path).set('Authorization', `Bearer ${tokens[user]}`),
    post: (path: string, body: object = {}, key = uniqueKey()) =>
      request(http).post(path).set('Authorization', `Bearer ${tokens[user]}`).set('Idempotency-Key', key).send(body),
    put: (path: string, body: object, key = uniqueKey()) =>
      request(http).put(path).set('Authorization', `Bearer ${tokens[user]}`).set('Idempotency-Key', key).send(body),
    patch: (path: string, body: object, key = uniqueKey()) =>
      request(http).patch(path).set('Authorization', `Bearer ${tokens[user]}`).set('Idempotency-Key', key).send(body),
  });

  const ALL_DAY = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opensAt: '00:00', closesAt: '00:00' }));

  type MenuItem = { priceId: string; portionId: string; code: string; portionCode: string; price: string };
  const menus = new Map<string, MenuItem[]>();
  const item = async (outlet: string, code: string, portion = 'STD', property = 'K1'): Promise<MenuItem> => {
    if (!menus.has(outlet)) {
      const res = await api('owner').get(`/api/properties/${property}/pos/outlets/${outlet}/menu`).expect(200);
      menus.set(outlet, res.body.items);
    }
    const found = menus.get(outlet)!.find((i) => i.code === code && i.portionCode === portion);
    if (!found) throw new Error(`${code}/${portion} not on ${outlet}`);
    return found;
  };
  const modifier = async (group: string, code: string, outlet = 'K1-COCKTAIL') => {
    const res = await api('owner').get(`${POS}/outlets/${outlet}/menu`).expect(200);
    return res.body.modifierGroups.find((g: { code: string }) => g.code === group).options.find((o: { code: string }) => o.code === code).id as string;
  };

  const openCheck = async (user: string, outlet: string, body: Record<string, unknown> = {}, property = 'K1') => {
    const res = await api(user).post(`/api/properties/${property}/pos/outlets/${outlet}/checks`, { serviceType: 'counter', ...body }).expect(201);
    return res.body;
  };
  const add = (user: string, checkId: string, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}, property = 'K1') =>
    api(user).post(`/api/properties/${property}/pos/checks/${checkId}/lines`, { lines, ...extra });

  let guestSeq = 0;
  const checkedInStay = async (extra: Record<string, unknown> = {}, code = 'SW', user = 'sw.reception') => {
    const today = (await api('owner').get(`/api/properties/${code}`).expect(200)).body.currentBusinessDate;
    guestSeq++;
    const owner = await ownerClient();
    try {
      await owner.query(`UPDATE rooms SET hk_status = 'clean' WHERE property_id = (SELECT id FROM properties WHERE code = $1)`, [code]);
    } finally {
      await owner.end();
    }
    const res = await api(user)
      .post(`/api/properties/${code}/reservations`, {
        source: 'phone',
        guest: { firstName: 'Pos', lastName: `Guest${guestSeq}`, phone: `+2547200${String(10000 + guestSeq)}`, nationality: 'KE' },
        arrival: today,
        departure: addDays(today, 1),
        rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1 }],
      })
      .expect(201);
    const stay = res.body.stays[0];
    await api(user)
      .post(`/api/properties/${code}/stays/${stay.id}/check-in`, {
        identity: { documentType: 'national_id', documentNumber: `${40000000 + guestSeq}`, issuingCountry: 'KE' },
        roomChargeAllowed: true,
        ...extra,
      })
      .expect(200);
    return stay as { id: string; folioId: string; number: string; nights: Array<{ amount: string }> };
  };

  beforeAll(async () => {
    app = await startApp();
    http = app.getHttpServer();
    for (const u of USERS) tokens[u] = await login(app, u);
    const owner = await ownerClient();
    try {
      await owner.query(`UPDATE properties SET current_business_date = (now() AT TIME ZONE 'Africa/Nairobi')::date`);
    } finally {
      await owner.end();
    }
    // Licensed hours that cover the whole day, so tests do not depend on the clock (POS-17 is tested below).
    for (const outlet of ['K1-COCKTAIL', 'K1-SHED', 'K1-HEAVEN']) {
      await api('k1.manager').put(`${POS}/outlets/${outlet}/settings`, { liquorHours: ALL_DAY }).expect(200);
    }
    await api('sw.manager').put('/api/properties/SW/pos/outlets/SW-MAINBAR/settings', { liquorHours: ALL_DAY }).expect(200);
    // The happy-hour rule at the Shed Bar would make prices depend on the time of day.
    const o = await ownerClient();
    try {
      await o.query(`UPDATE price_rules SET is_active = false WHERE name = 'Happy hour beer'`);
    } finally {
      await o.end();
    }
  });

  afterAll(async () => {
    // Leave no K1 trading day open behind, so the front-desk suite can close K1's business day.
    const owner = await ownerClient();
    try {
      await owner.query(
        `UPDATE pos_outlet_days SET status = 'closed', closed_at = now(), finalised_at = now(), totals = '{"test": true}'
          WHERE status = 'open' AND property_id = (SELECT id FROM properties WHERE code = 'K1')`,
      );
    } finally {
      await owner.end();
    }
    await app.close();
  });

  // ---------------------------------------------------------------------------
  describe('business day and POS settings (CFG-01, CFG-03)', () => {
    it('lists POS outlets with the 08:00 cut-off; non-selling outlets are left out', async () => {
      const res = await api('k1.waiter').get(`${POS}/outlets`).expect(200);
      const codes = res.body.map((o: { code: string }) => o.code);
      expect(codes).toEqual(expect.arrayContaining(['K1-COCKTAIL', 'K1-KOFFEE', 'K1-SHOP']));
      expect(codes).not.toContain('K1-ROOMS');
      expect(codes).not.toContain('K1-LAUNDRY');
      expect(res.body.find((o: { code: string }) => o.code === 'K1-COCKTAIL').cutoff).toBe('08:00');
    });

    it('only managers change the cut-off; an outlet may override it and go back to the property default', async () => {
      await api('k1.waiter').put(`${POS}/settings`, { businessDayCutoff: '07:00' }).expect(403);
      await api('k1.cashier').put(`${POS}/outlets/K1-KOFFEE/settings`, { businessDayCutoff: '06:00' }).expect(403);

      const prop = await api('k1.manager').put(`${POS}/settings`, { businessDayCutoff: '07:30' }).expect(200);
      expect(prop.body.property.businessDayCutoff).toBe('07:30');
      await api('k1.manager').put(`${POS}/settings`, { businessDayCutoff: '08:00' }).expect(200);

      const own = await api('k1.manager').put(`${POS}/outlets/K1-KOFFEE/settings`, { businessDayCutoff: '06:00' }).expect(200);
      expect(own.body.businessDayCutoff).toBe('06:00');
      let outlets = await api('k1.waiter').get(`${POS}/outlets`).expect(200);
      expect(outlets.body.find((o: { code: string }) => o.code === 'K1-KOFFEE')).toMatchObject({ cutoff: '06:00', ownCutoff: '06:00' });

      await api('k1.manager').put(`${POS}/outlets/K1-KOFFEE/settings`, { businessDayCutoff: null }).expect(200);
      outlets = await api('k1.waiter').get(`${POS}/outlets`).expect(200);
      expect(outlets.body.find((o: { code: string }) => o.code === 'K1-KOFFEE')).toMatchObject({ cutoff: '08:00', ownCutoff: null });

      await api('k1.manager').put(`${POS}/settings`, { businessDayCutoff: '25:00' }).expect(400);
    });

    it('routes kitchen and bar tickets to stations per outlet', async () => {
      const res = await api('k1.manager').get(`${POS}/settings`).expect(200);
      const cocktail = res.body.outlets.find((o: { code: string }) => o.code === 'K1-COCKTAIL');
      expect(cocktail.routes).toEqual({ kitchen: 'KITCHEN', bar: 'COCKTAIL' });
      await api('k1.manager').put(`${POS}/outlets/K1-COCKTAIL/settings`, { routes: { bar: 'NOPE' } }).expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  describe('menus and prices (POS-01, POS-02, POS-03, POS-19, CFG-05)', () => {
    it('serves the outlet menu with portions, modifiers, favourites and tables', async () => {
      const res = await api('k1.waiter').get(`${POS}/outlets/K1-COCKTAIL/menu`).expect(200);
      expect(res.body.liquorAllowedNow).toBe(true);
      const jw = res.body.items.filter((i: { code: string }) => i.code === 'SP-JW-BLACK').map((i: { portionCode: string }) => i.portionCode);
      expect(jw).toEqual(['TOT', 'DBL', 'BTL']);
      expect(res.body.items.some((i: { isFavourite: boolean }) => i.isFavourite)).toBe(true);
      expect(res.body.modifierGroups.map((g: { code: string }) => g.code)).toEqual(expect.arrayContaining(['MIXER', 'ICE']));
      expect(res.body.tables.length).toBeGreaterThan(0);
      // Klub Koffee is not licensed: no alcohol on its menu.
      const koffee = await api('k1.waiter').get(`${POS}/outlets/K1-KOFFEE/menu`).expect(200);
      expect(koffee.body.items.some((i: { isAlcohol: boolean }) => i.isAlcohol)).toBe(false);
    });

    it('prices an item per outlet: a change at one bar leaves the others alone (POS-03, AT-04)', async () => {
      const shed = await item('K1-SHED', 'BR-TUSKER');
      await api('k1.waiter').patch(`${POS}/outlets/K1-SHED/prices/${shed.priceId}`, { price: '300.00' }).expect(403);
      await api('k1.manager').patch(`${POS}/outlets/K1-SHED/prices/${shed.priceId}`, { price: '300.00' }).expect(200);
      menus.clear();
      expect((await item('K1-SHED', 'BR-TUSKER')).price).toBe('300.00');
      expect((await item('K1-COCKTAIL', 'BR-TUSKER')).price).toBe('350.00');
    });

    it('copies an outlet as a template (POS-19)', async () => {
      const res = await api('owner').post('/api/pos/outlets/copy', { fromOutletCode: 'K1-COCKTAIL', toOutletCode: 'K1-FLAVOUR' }).expect(200);
      expect(res.body.pricesCopied).toBeGreaterThan(20);
      await api('k1.waiter').post('/api/pos/outlets/copy', { fromOutletCode: 'K1-COCKTAIL', toOutletCode: 'K1-FLAVOUR' }).expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  describe('orders and tickets (POS-04 … POS-07)', () => {
    let check: { id: string; number: string; lines: Array<{ id: string; status: string; route: string }> };

    it('a waiter opens a table, adds drinks and food with modifiers; prices include VAT and levy', async () => {
      const menu = await api('k1.waiter').get(`${POS}/outlets/K1-COCKTAIL/menu`).expect(200);
      const table = menu.body.tables[0];
      check = await openCheck('k1.waiter', 'K1-COCKTAIL', { serviceType: 'table', tableId: table.id, covers: 2 });
      expect(check.number).toMatch(/^K1-CHK-\d{6}$/);

      const res = await add('k1.waiter', check.id, [
        { portionId: (await item('K1-COCKTAIL', 'BR-TUSKER')).portionId, quantity: '2' },
        { portionId: (await item('K1-COCKTAIL', 'ST-SAMOSA')).portionId, quantity: '1', notes: 'no chilli' },
        { portionId: (await item('K1-COCKTAIL', 'SP-JW-BLACK', 'TOT')).portionId, quantity: '1', modifierOptionIds: [await modifier('MIXER', 'TONIC')] },
      ]).expect(200);
      check = res.body;
      expect(res.body.totals.total).toBe('1550.00'); // 2 × 350 + 350 + (450 + 50 tonic)
      const jw = res.body.lines.find((l: { name: string }) => l.name.startsWith('Johnnie'));
      expect(jw).toMatchObject({ amount: '500.00', status: 'draft' });
      expect(jw.taxes.map((t: { code: string }) => t.code)).toEqual(['O1', 'C1']);
    });

    it('rejects a mandatory modifier left out and items from another outlet’s menu', async () => {
      const k = await openCheck('k1.waiter', 'K1-KOFFEE');
      const burger = await item('K1-KOFFEE', 'MN-BURGER');
      const res = await add('k1.waiter', k.id, [{ portionId: burger.portionId, quantity: '1' }]).expect(400);
      expect(res.body.message).toMatch(/Cooking/);
      const jw = await item('K1-COCKTAIL', 'SP-JW-BLACK', 'TOT');
      await add('k1.waiter', k.id, [{ portionId: jw.portionId, quantity: '1' }]).expect(422);
      await api('k1.waiter').post(`${POS}/checks/${k.id}/void`, { reason: 'Test check', approval: MANAGER }).expect(200);
    });

    it('send routes food to the kitchen and drinks to the bar; the kitchen bumps tickets', async () => {
      const sent = await api('k1.waiter').post(`${POS}/checks/${check.id}/send`).expect(200);
      expect(sent.body.tickets.map((t: { station: string }) => t.station).sort()).toEqual(['COCKTAIL', 'KITCHEN']);
      await api('k1.waiter').post(`${POS}/checks/${check.id}/send`).expect(409); // nothing new

      const kitchen = await api('k1.kitchen').get(`${POS}/stations/KITCHEN/tickets`).expect(200);
      const ticket = kitchen.body.find((t: { content: { checkNumber: string } }) => t.content.checkNumber === check.number);
      expect(ticket.content.lines[0]).toMatchObject({ name: 'Beef samosas (3)', notes: 'no chilli' });
      await api('k1.waiter').get(`${POS}/stations/KITCHEN/tickets`).expect(403); // waiters do not run the pass

      await api('k1.kitchen').post(`${POS}/tickets/${ticket.id}/status`, { status: 'preparing' }).expect(200);
      await api('k1.kitchen').post(`${POS}/tickets/${ticket.id}/status`, { status: 'preparing' }).expect(409);
      const view = await api('k1.waiter').get(`${POS}/checks/${check.id}`).expect(200);
      expect(view.body.lines.find((l: { route: string }) => l.route === 'kitchen').status).toBe('preparing');

      const first = await api('k1.kitchen').get(`${POS}/tickets/${ticket.id}/print`).expect(200);
      expect(first.text).not.toContain('REPRINT');
      await api('k1.kitchen').post(`${POS}/tickets/${ticket.id}/reprint`, { reason: 'Printer jam' }).expect(200);
      const again = await api('k1.kitchen').get(`${POS}/tickets/${ticket.id}/print`).expect(200);
      expect(again.text).toContain('REPRINT #2');
    });

    it('cancelling a sent drink needs a manager; preparing food becomes waste (POS-11, AT-10)', async () => {
      const view = (await api('k1.waiter').get(`${POS}/checks/${check.id}`).expect(200)).body;
      const beer = view.lines.find((l: { name: string }) => l.name.startsWith('Tusker'));
      const samosa = view.lines.find((l: { name: string }) => l.name.startsWith('Beef'));

      const denied = await api('k1.waiter').post(`${POS}/checks/${check.id}/cancel-lines`, { lineIds: [beer.id], reason: 'Guest changed mind' }).expect(403);
      expect(denied.body.error).toBe('approval_required');
      const cancelled = await api('k1.waiter')
        .post(`${POS}/checks/${check.id}/cancel-lines`, { lineIds: [beer.id], reason: 'Guest changed mind', approval: MANAGER })
        .expect(200);
      expect(cancelled.body.lines.find((l: { id: string }) => l.id === beer.id).status).toBe('cancelled');

      await api('k1.waiter').post(`${POS}/checks/${check.id}/cancel-lines`, { lineIds: [samosa.id], reason: 'Dropped', approval: MANAGER }).expect(200);
      const after = (await api('k1.waiter').get(`${POS}/checks/${check.id}`).expect(200)).body;
      expect(after.lines.find((l: { id: string }) => l.id === samosa.id).status).toBe('wasted');
      expect(after.totals.total).toBe('500.00'); // only the whisky is left to pay

      // The bar got a cancellation ticket for the beer.
      const bar = await api('k1.bartender').get(`${POS}/stations/COCKTAIL/tickets`).expect(200);
      expect(bar.body.some((t: { kind: string; content: { checkNumber: string } }) => t.kind === 'cancellation' && t.content.checkNumber === check.number)).toBe(true);
      // Nothing about a cancelled or wasted line can be changed again.
      await api('k1.waiter').post(`${POS}/checks/${check.id}/cancel-lines`, { lineIds: [beer.id], reason: 'Again', approval: MANAGER }).expect(409);
    });

    it('records every step in the check history', async () => {
      const res = await api('k1.waiter').get(`${POS}/checks/${check.id}/events`).expect(200);
      const names = res.body.map((e: { event: string }) => e.event);
      expect(names).toEqual(expect.arrayContaining(['opened', 'line_added', 'sent', 'preparing', 'ticket_reprinted', 'cancelled', 'wasted']));
    });

    it('the database refuses to edit or delete a check event or a ticket', async () => {
      const owner = await ownerClient();
      try {
        await expect(owner.query('DELETE FROM pos_check_events WHERE check_id = $1', [check.id])).rejects.toThrow();
        await expect(owner.query(`UPDATE pos_tickets SET content = '{}' WHERE check_id = $1`, [check.id])).rejects.toThrow();
      } finally {
        await owner.end();
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('availability, stock and liquor hours (POS-12, POS-17)', () => {
    it('an item marked unavailable cannot be sold; stock counts warn or block', async () => {
      const wings = await item('K1-HEAVEN', 'ST-WINGS', 'HALF');
      await api('k1.kitchen').post(`${POS}/outlets/K1-HEAVEN/prices/${wings.priceId}/availability`, { isAvailable: false }).expect(200);
      const c = await openCheck('k1.waiter', 'K1-HEAVEN');
      const res = await add('k1.waiter', c.id, [{ portionId: wings.portionId, quantity: '1' }]).expect(409);
      expect(res.body.error).toBe('item_unavailable');
      await api('k1.kitchen').post(`${POS}/outlets/K1-HEAVEN/prices/${wings.priceId}/availability`, { isAvailable: true }).expect(200);

      const chips = await item('K1-HEAVEN', 'ST-CHIPS');
      await api('k1.manager').patch(`${POS}/outlets/K1-HEAVEN/prices/${chips.priceId}`, { stockRemaining: '2' }).expect(200);
      const warn = await add('k1.waiter', c.id, [{ portionId: chips.portionId, quantity: '3' }]).expect(409);
      expect(warn.body.error).toBe('warning');
      await add('k1.waiter', c.id, [{ portionId: chips.portionId, quantity: '3' }], { acknowledgeWarnings: true }).expect(200);

      await api('k1.manager').put(`${POS}/outlets/K1-HEAVEN/settings`, { stockPolicy: 'block' }).expect(200);
      await api('k1.manager').patch(`${POS}/outlets/K1-HEAVEN/prices/${chips.priceId}`, { stockRemaining: '1' }).expect(200);
      const blocked = await add('k1.waiter', c.id, [{ portionId: chips.portionId, quantity: '2' }], { acknowledgeWarnings: true }).expect(409);
      expect(blocked.body.error).toBe('out_of_stock');
      await add('k1.waiter', c.id, [{ portionId: chips.portionId, quantity: '1' }]).expect(200);
      const menu = await api('k1.waiter').get(`${POS}/outlets/K1-HEAVEN/menu`).expect(200);
      expect(menu.body.items.find((i: { priceId: string }) => i.priceId === chips.priceId).stockRemaining).toBe('0.0000');
      await api('k1.waiter').post(`${POS}/checks/${c.id}/void`, { reason: 'Test check', approval: MANAGER }).expect(200);
    });

    it('blocks alcohol outside licensed hours unless a manager overrides with a reason (POS-17)', async () => {
      await api('k1.manager').put(`${POS}/outlets/K1-SPICE/settings`, { liquorHours: [] }).expect(200);
      const c = await openCheck('k1.waiter', 'K1-SPICE');
      const beer = await item('K1-SPICE', 'BR-TUSKER');
      const soda = await item('K1-SPICE', 'SD-SODA');
      await add('k1.waiter', c.id, [{ portionId: soda.portionId, quantity: '1' }]).expect(200); // soft drinks are fine
      const blocked = await add('k1.waiter', c.id, [{ portionId: beer.portionId, quantity: '1' }]).expect(409);
      expect(blocked.body.error).toBe('liquor_hours');
      await add('k1.waiter', c.id, [{ portionId: beer.portionId, quantity: '1' }], { liquorOverrideReason: 'Licence extension for event' }).expect(403);
      const ok = await add('k1.waiter', c.id, [{ portionId: beer.portionId, quantity: '1' }], { liquorOverrideReason: 'Licence extension for event', approval: MANAGER }).expect(200);
      expect(ok.body.lines.find((l: { name: string }) => l.name.startsWith('Tusker')).liquorOverride).toBe(true);

      await api('k1.manager').put(`${POS}/outlets/K1-SPICE/settings`, { liquorPolicy: 'warn' }).expect(200);
      const warn = await add('k1.waiter', c.id, [{ portionId: beer.portionId, quantity: '1' }]).expect(409);
      expect(warn.body.error).toBe('warning');
      await add('k1.waiter', c.id, [{ portionId: beer.portionId, quantity: '1' }], { acknowledgeWarnings: true }).expect(200);
      await api('k1.manager').put(`${POS}/outlets/K1-SPICE/settings`, { liquorPolicy: 'block', liquorHours: ALL_DAY }).expect(200);
      await api('k1.waiter').post(`${POS}/checks/${c.id}/void`, { reason: 'Test check', approval: MANAGER }).expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('discounts and comps (POS-03, SEC-02)', () => {
    it('small discounts are free; larger ones and comps need a manager; a fully comped check closes at zero', async () => {
      await api('k1.manager').put(`${POS}/settings`, { posDiscountFreePercent: '10' }).expect(200);
      const c = await openCheck('k1.waiter', 'K1-COCKTAIL');
      const dawa = await item('K1-COCKTAIL', 'CK-DAWA');
      await add('k1.waiter', c.id, [{ portionId: dawa.portionId, quantity: '2' }]).expect(200);

      const ten = await api('k1.waiter').post(`${POS}/checks/${c.id}/discount`, { percent: '10', reason: 'Regular guest' }).expect(200);
      expect(ten.body.totals.total).toBe('1170.00');
      const denied = await api('k1.waiter').post(`${POS}/checks/${c.id}/discount`, { percent: '25', reason: 'Complaint' }).expect(403);
      expect(denied.body.error).toBe('approval_required');
      const wrong = await api('k1.waiter')
        .post(`${POS}/checks/${c.id}/discount`, { percent: '25', reason: 'Complaint', approval: { username: 'k1.cashier', password: process.env.SEED_PASSWORD } })
        .expect(403);
      expect(wrong.body.error).toBe('approval_rejected');
      const quarter = await api('k1.waiter').post(`${POS}/checks/${c.id}/discount`, { percent: '25', reason: 'Complaint', approval: MANAGER }).expect(200);
      expect(quarter.body.totals.total).toBe('975.00');
      expect(quarter.body.lines[0].discountReason).toBe('Complaint');

      await api('k1.waiter').post(`${POS}/checks/${c.id}/discount`, { percent: '100', reason: 'Spilled drink' }).expect(403);
      const comp = await api('k1.waiter').post(`${POS}/checks/${c.id}/discount`, { percent: '100', reason: 'Spilled drink', approval: MANAGER }).expect(200);
      expect(comp.body.totals.total).toBe('0.00');
      expect(comp.body.lines[0].isComp).toBe(true);
      const closed = await api('k1.waiter').post(`${POS}/checks/${c.id}/close`).expect(200);
      expect(closed.body).toMatchObject({ status: 'closed', settlement: 'zero' });
    });
  });

  // ---------------------------------------------------------------------------
  describe('split, merge and transfer (POS-05, POS-08)', () => {
    it('splits part of a line to a new check, moves a table and merges back without losing a cent', async () => {
      const menu = await api('k1.waiter').get(`${POS}/outlets/K1-COCKTAIL/menu`).expect(200);
      const [t1, t2] = menu.body.tables;
      const c = await openCheck('k1.waiter', 'K1-COCKTAIL', { serviceType: 'table', tableId: t1.id, covers: 3 });
      const res = await add('k1.waiter', c.id, [
        { portionId: (await item('K1-COCKTAIL', 'BR-GUINNESS')).portionId, quantity: '3' },
        { portionId: (await item('K1-COCKTAIL', 'ST-CHIPS')).portionId, quantity: '1' },
      ]).expect(200);
      expect(res.body.totals.total).toBe('1590.00');
      const guinness = res.body.lines.find((l: { name: string }) => l.name.startsWith('Guinness'));

      const split = await api('k1.waiter').post(`${POS}/checks/${c.id}/split`, { parts: [{ lineId: guinness.id, quantity: '1' }] }).expect(200);
      expect(split.body.from.totals.total).toBe('1210.00');
      expect(split.body.to.totals.total).toBe('380.00');

      const moved = await api('k1.waiter').post(`${POS}/checks/${split.body.to.id}/transfer`, { tableId: t2.id }).expect(200);
      expect(moved.body.tableCode).toBe(t2.code);

      const merged = await api('k1.waiter').post(`${POS}/checks/${c.id}/merge`, { fromCheckIds: [split.body.to.id] }).expect(200);
      expect(merged.body.totals.total).toBe('1590.00');
      const gone = await api('k1.waiter').get(`${POS}/checks/${split.body.to.id}`).expect(200);
      expect(gone.body).toMatchObject({ status: 'merged', mergedIntoId: c.id });
      await api('k1.waiter').post(`${POS}/checks/${c.id}/void`, { reason: 'Test check', approval: MANAGER }).expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('payments, cashier shift and refunds (POS-10, POS-11, POS-13, AT-03, AT-13, AT-14)', () => {
    let check: { id: string; number: string };
    let shiftId: string;

    it('cash needs an open shift; payment closes the check, gives change and queues the SAP sale', async () => {
      check = await openCheck('k1.cashier', 'K1-COCKTAIL');
      await add('k1.cashier', check.id, [
        { portionId: (await item('K1-COCKTAIL', 'BR-TUSKER')).portionId, quantity: '3' },
        { portionId: (await item('K1-COCKTAIL', 'SD-SODA')).portionId, quantity: '2' },
      ]).expect(200); // 1,050 + 300 = 1,350
      const noShift = await api('k1.cashier').post(`${POS}/checks/${check.id}/payments`, { tenders: [{ tender: 'cash', amount: '1350.00' }] }).expect(409);
      expect(noShift.body.error).toBe('no_open_shift');

      const shift = await api('k1.cashier').post(`${POS}/shifts`, { outletCode: 'K1-COCKTAIL', openingFloat: '5000.00' }).expect(201);
      shiftId = shift.body.id;
      expect(shift.body.number).toMatch(/^K1-SFT-\d{6}$/);
      await api('k1.cashier').post(`${POS}/shifts`, { outletCode: 'K1-COCKTAIL', openingFloat: '100.00' }).expect(409); // one at a time

      const over = await api('k1.cashier').post(`${POS}/checks/${check.id}/payments`, { tenders: [{ tender: 'mpesa', amount: '2000.00', reference: uniqueKey('Q') }] }).expect(409);
      expect(over.body.error).toBe('overpayment');

      const paid = await api('k1.cashier')
        .post(`${POS}/checks/${check.id}/payments`, {
          tenders: [
            { tender: 'mpesa', amount: '350.00', reference: 'QAT03POS01' },
            { tender: 'cash', amount: '1000.00', tendered: '2000.00' },
          ],
        })
        .expect(200);
      expect(paid.body).toMatchObject({ status: 'closed', settlement: 'payment', change: '1000.00' });
      expect(paid.body.lines.every((l: { status: string }) => l.status !== 'draft')).toBe(true); // paying sends the order

      const owner = await ownerClient();
      try {
        const { rows } = await owner.query(`SELECT event_type, payload FROM integration_outbox WHERE external_ref IN ($1, $2) ORDER BY event_type`, [
          check.number, `${check.number}-PAY`,
        ]);
        expect(rows.map((r) => r.event_type)).toEqual(['AR_INVOICE', 'INCOMING_PAYMENT']);
        expect(rows[0].payload.lines[0]).toMatchObject({ itemCode: 'POS-BEVERAGE', taxCode: 'O1' });
        expect(rows[1].payload).toMatchObject({ cashSum: '1000.00', transferSum: '350.00' });
      } finally {
        await owner.end();
      }
      const receipt = await api('k1.cashier').get(`${POS}/checks/${check.id}/print`).expect(200);
      expect(receipt.text).toContain('RECEIPT');
      expect(receipt.text).toContain('1,350.00');
      expect(receipt.text).toContain('Powered by YeaStay');
    });

    it('a duplicate M-PESA reference is refused; a replayed request records the payment once (AT-03)', async () => {
      const c = await openCheck('k1.cashier', 'K1-COCKTAIL');
      await add('k1.cashier', c.id, [{ portionId: (await item('K1-COCKTAIL', 'SD-WATER')).portionId, quantity: '1' }]).expect(200);
      const dup = await api('k1.cashier').post(`${POS}/checks/${c.id}/payments`, { tenders: [{ tender: 'mpesa', amount: '120.00', reference: 'qat03pos01' }] }).expect(409);
      expect(dup.body.error).toBe('duplicate_payment');

      const key = uniqueKey('pay');
      const body = { tenders: [{ tender: 'card', amount: '120.00', reference: uniqueKey('AUTH') }] };
      const first = await api('k1.cashier').post(`${POS}/checks/${c.id}/payments`, body, key).expect(200);
      const replay = await api('k1.cashier').post(`${POS}/checks/${c.id}/payments`, body, key).expect(200);
      expect(replay.body).toEqual(first.body);
      expect(first.body.payments).toHaveLength(1);
    });

    it('a pending M-PESA payment holds the check open until confirmed (AT-15 style)', async () => {
      const c = await openCheck('k1.waiter', 'K1-COCKTAIL');
      await add('k1.waiter', c.id, [{ portionId: (await item('K1-COCKTAIL', 'SD-SODA')).portionId, quantity: '1' }]).expect(200);
      const pending = await api('k1.waiter')
        .post(`${POS}/checks/${c.id}/payments`, { tenders: [{ tender: 'mpesa', amount: '150.00', reference: uniqueKey('QP'), status: 'pending' }] })
        .expect(200);
      expect(pending.body.status).toBe('open');
      const done = await api('k1.waiter').post(`${POS}/payments/${pending.body.payments[0].id}/resolve`, { outcome: 'confirmed' }).expect(200);
      expect(done.body.status).toBe('closed');
    });

    it('waiters can never refund; a cashier refunds with a manager’s approval (POS-11, AT-14)', async () => {
      const view = (await api('k1.cashier').get(`${POS}/checks/${check.id}`).expect(200)).body;
      const cash = view.payments.find((p: { tender: string }) => p.tender === 'cash');
      await api('k1.waiter').post(`${POS}/checks/${check.id}/refunds`, { paymentId: cash.id, amount: '350.00', reason: 'Warm beer', approval: MANAGER }).expect(403);
      const denied = await api('k1.cashier').post(`${POS}/checks/${check.id}/refunds`, { paymentId: cash.id, amount: '350.00', reason: 'Warm beer' }).expect(403);
      expect(denied.body.error).toBe('approval_required');
      const res = await api('k1.cashier').post(`${POS}/checks/${check.id}/refunds`, { paymentId: cash.id, amount: '350.00', reason: 'Warm beer', approval: MANAGER }).expect(200);
      expect(res.body.refund.number).toMatch(/^K1-RF-\d{6}$/);
      expect(res.body.check.totals.refunded).toBe('350.00');
      const tooMuch = await api('k1.cashier').post(`${POS}/checks/${check.id}/refunds`, { paymentId: cash.id, amount: '700.00', reason: 'Again', approval: MANAGER }).expect(409);
      expect(tooMuch.body.error).toBe('refund_too_large');
    });

    it('cash out needs a manager (AT-13); the count is blind and a variance is reviewed (POS-13)', async () => {
      const out = await api('k1.cashier').post(`${POS}/shifts/current/movements`, { kind: 'paid_out', amount: '200.00', reason: 'Ice from market' }).expect(403);
      expect(out.body.error).toBe('approval_required');
      await api('k1.cashier').post(`${POS}/shifts/current/movements`, { kind: 'paid_out', amount: '200.00', reason: 'Ice from market', approval: MANAGER }).expect(201);
      await api('k1.cashier').post(`${POS}/shifts/current/movements`, { kind: 'drop', amount: '1000.00', reason: 'Safe drop' }).expect(201);

      const current = await api('k1.cashier').get(`${POS}/shifts/current`).expect(200);
      expect(current.body).not.toHaveProperty('expectedAmount');
      expect(current.body).not.toHaveProperty('breakdown');
      expect(current.body.movements).toHaveLength(2);

      // Expected: 5,000 float + 1,000 cash − 350 refund − 200 paid out − 1,000 drop = 4,450. Count 4,400: 50 short.
      const closed = await api('k1.cashier').post(`${POS}/shifts/${shiftId}/close`, { countedAmount: '4400.00' }).expect(200);
      expect(closed.body).toMatchObject({ status: 'closed', expectedAmount: '4450.00', variance: '-50.00' });
      await api('k1.cashier').post(`${POS}/shifts/${shiftId}/close`, { countedAmount: '4400.00' }).expect(409);

      await api('k1.cashier').post(`${POS}/shifts/${shiftId}/review`, { note: 'Short 50' }).expect(403);
      const list = await api('k1.manager').get(`${POS}/shifts?unreviewed=true`).expect(200);
      expect(list.body.map((s: { id: string }) => s.id)).toContain(shiftId);
      const reviewed = await api('k1.manager').post(`${POS}/shifts/${shiftId}/review`, { note: 'Short 50, cashier to repay' }).expect(200);
      expect(reviewed.body).toMatchObject({ reviewedBy: 'K1 manager', reviewNote: 'Short 50, cashier to repay' });

      const owner = await ownerClient();
      try {
        await expect(owner.query(`UPDATE cashier_shifts SET counted_amount = 4450 WHERE id = $1`, [shiftId])).rejects.toThrow(/finalised/);
      } finally {
        await owner.end();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Small World has the most rooms, so these stays never take rooms the front-desk suite books at K1.
  describe('charge to room (POS-09, BIL-02, BIL-11, BIL-12, AT-02, AT-07, AT-09)', () => {
    const SW = '/api/properties/SW';
    const SWPOS = `${SW}/pos`;
    const SW_MANAGER = { username: 'sw.manager', password: process.env.SEED_PASSWORD! };
    const ack = { method: 'staff_verified', signedName: 'Pos Guest' };

    it('AT-07: part paid by M-PESA, the rest charged to the room as itemised folio lines; revenue counted once', async () => {
      const stay = await checkedInStay();
      const before = (await api('sw.reception').get(`${SW}/folios/${stay.folioId}`).expect(200)).body.balance;

      const tables = (await api('sw.waiter').get(`${SWPOS}/outlets/SW-KITCHEN/menu`).expect(200)).body.tables;
      const c = await openCheck('sw.waiter', 'SW-KITCHEN', { serviceType: 'table', tableId: tables[0].id }, 'SW');
      const res = await add('sw.waiter', c.id, [
        { portionId: (await item('SW-KITCHEN', 'MN-CURRY', 'STD', 'SW')).portionId, quantity: '1', modifierOptionIds: [await modifier('SIDE', 'RICE', 'K1-KOFFEE')] },
        { portionId: (await item('SW-KITCHEN', 'MN-BURGER', 'STD', 'SW')).portionId, quantity: '1', modifierOptionIds: [await modifier('DONENESS', 'MEDIUM', 'K1-KOFFEE')] },
        { portionId: (await item('SW-KITCHEN', 'CF-LATTE', 'STD', 'SW')).portionId, quantity: '1' },
      ], {}, 'SW').expect(200);
      expect(res.body.totals.total).toBe('2670.00'); // 1,250 + 1,100 + 320

      await api('sw.waiter').post(`${SWPOS}/checks/${c.id}/payments`, { tenders: [{ tender: 'mpesa', amount: '1000.00', reference: uniqueKey('QAT07') }] }).expect(200);

      const lookup = await api('sw.waiter').get(`${SWPOS}/in-house?q=Guest${guestSeq}`).expect(200);
      expect(lookup.body[0]).toMatchObject({ stayId: stay.id, eligible: true });
      // The waiter sees room and name only, never identity documents (AT-14 / FD-02).
      expect(Object.keys(lookup.body[0])).not.toContain('identity');

      const charged = await api('sw.waiter')
        .post(`${SWPOS}/checks/${c.id}/room-charge`, { stayId: stay.id, acknowledgement: { method: 'guest_signature', signedName: 'Pos Guest', signature: 'data:image/png;base64,iVBORw0KGgo=' } })
        .expect(200);
      expect(charged.body).toMatchObject({ status: 'closed', settlement: 'room_charge' });
      expect(charged.body.roomCharge).toMatchObject({ amount: '1670.00', signedName: 'Pos Guest' });
      expect(charged.body.roomCharge.folioChargeIds).toHaveLength(3);

      const folio = (await api('sw.reception').get(`${SW}/folios/${stay.folioId}`).expect(200)).body;
      const posCharges = folio.charges.filter((ch: { posCheckId: string | null }) => ch.posCheckId === c.id);
      expect(posCharges).toHaveLength(3);
      expect(posCharges.reduce((a: number, ch: { amount: string }) => a + Number(ch.amount), 0)).toBeCloseTo(1670, 2);
      expect(Number(folio.balance.balance) - Number(before.balance)).toBeCloseTo(1670, 2);

      // Charged once: a second attempt is refused.
      await api('sw.waiter').post(`${SWPOS}/checks/${c.id}/room-charge`, { stayId: stay.id, acknowledgement: ack }).expect(409);

      // Revenue once: the outlet's sales are the check, settled by M-PESA plus the room charge; no SAP sale for a room-charged check.
      const today = c.businessDate;
      const sales = await api('sw.manager').get(`${SWPOS}/reports/sales?from=${today}&to=${today}&outlet=SW-KITCHEN`).expect(200);
      expect(sales.body.reconciliation.difference).toBe('0.00');
      const owner = await ownerClient();
      try {
        const { rowCount } = await owner.query(`SELECT 1 FROM integration_outbox WHERE external_ref = $1`, [c.number]);
        expect(rowCount).toBe(0);
      } finally {
        await owner.end();
      }
    });

    it('refuses stays with room charges blocked or over their credit limit (BIL-02, AT-02)', async () => {
      const blocked = await checkedInStay({ roomChargeAllowed: false });
      const c = await openCheck('sw.waiter', 'SW-MAINBAR', {}, 'SW');
      await add('sw.waiter', c.id, [{ portionId: (await item('SW-MAINBAR', 'SP-JW-BLACK', 'BTL', 'SW')).portionId, quantity: '1' }], {}, 'SW').expect(200);
      const r1 = await api('sw.waiter').post(`${SWPOS}/checks/${c.id}/room-charge`, { stayId: blocked.id, acknowledgement: ack }).expect(409);
      expect(r1.body.error).toBe('room_charge_blocked');

      const limited = await checkedInStay({ creditLimit: '5000.00' });
      const r2 = await api('sw.waiter').post(`${SWPOS}/checks/${c.id}/room-charge`, { stayId: limited.id, acknowledgement: ack }).expect(409);
      expect(r2.body.error).toBe('credit_limit');
      // A stay that is not at this property is not found (BIL-17).
      await api('sw.waiter').post(`${SWPOS}/checks/${c.id}/room-charge`, { stayId: randomUUID(), acknowledgement: ack }).expect(404);
      await api('sw.waiter').post(`${SWPOS}/checks/${c.id}/void`, { reason: 'Test check', approval: SW_MANAGER }).expect(200);
    });

    it('an open check for the guest blocks checkout (BIL-11)', async () => {
      const stay = await checkedInStay();
      const c = await openCheck('sw.waiter', 'SW-KITCHEN', { serviceType: 'room_service', stayId: stay.id }, 'SW');
      await add('sw.waiter', c.id, [{ portionId: (await item('SW-KITCHEN', 'CF-CHAI', 'STD', 'SW')).portionId, quantity: '1' }], {}, 'SW').expect(200);
      const blocked = await api('sw.reception').post(`${SW}/stays/${stay.id}/check-out`, {}).expect(409);
      expect(blocked.body.error).toBe('open_pos_checks');
      await api('sw.waiter').post(`${SWPOS}/checks/${c.id}/room-charge`, { stayId: stay.id, acknowledgement: ack }).expect(200);
      const due = await api('sw.reception').post(`${SW}/stays/${stay.id}/check-out`, {}).expect(409);
      expect(due.body.error).toBe('balance_not_zero'); // now it is on the bill
    });

    it('a room charge racing checkout lands on the settled bill or is refused (AT-09)', async () => {
      const stay = await checkedInStay();
      const c = await openCheck('sw.waiter', 'SW-MAINBAR', {}, 'SW');
      await add('sw.waiter', c.id, [{ portionId: (await item('SW-MAINBAR', 'BR-TUSKER', 'STD', 'SW')).portionId, quantity: '1' }], {}, 'SW').expect(200);
      const nights = stay.nights.reduce((a, n) => a + Number(n.amount), 0).toFixed(2);
      const [charge, out] = await Promise.all([
        api('sw.waiter').post(`${SWPOS}/checks/${c.id}/room-charge`, { stayId: stay.id, acknowledgement: ack }),
        api('sw.reception').post(`${SW}/stays/${stay.id}/check-out`, { tenders: [{ tender: 'cash', amount: nights }] }),
      ]);
      const folio = (await api('sw.reception').get(`${SW}/folios/${stay.folioId}`).expect(200)).body;
      if (out.status === 200) {
        expect(charge.status).toBe(409);
        expect(folio.balance.balance).toBe('0.00');
        const still = await api('sw.waiter').get(`${SWPOS}/checks/${c.id}`).expect(200);
        expect(still.body.status).toBe('open'); // nothing hidden: the check is still owed
        await api('sw.waiter').post(`${SWPOS}/checks/${c.id}/void`, { reason: 'Test check', approval: SW_MANAGER }).expect(200);
      } else {
        expect(charge.status).toBe(200);
        expect(['balance_not_zero', 'open_pos_checks']).toContain(out.body.error);
        expect(folio.status).toBe('open');
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('house accounts (POS-18)', () => {
    it('staff meals go to a house account with approval and are kept out of revenue', async () => {
      const c = await openCheck('k1.cashier', 'K1-KOFFEE');
      await add('k1.cashier', c.id, [{ portionId: (await item('K1-KOFFEE', 'MN-CURRY')).portionId, quantity: '2', modifierOptionIds: [] }]).expect(200);
      const before = (await api('k1.manager').get(`${POS}/reports/sales?from=${c.businessDate}&to=${c.businessDate}&outlet=K1-KOFFEE`).expect(200)).body;

      const denied = await api('k1.cashier').post(`${POS}/checks/${c.id}/house-account`, { houseAccountCode: 'STAFF-MEALS', reason: 'Night shift meals' }).expect(403);
      expect(denied.body.error).toBe('approval_required');
      const res = await api('k1.cashier').post(`${POS}/checks/${c.id}/house-account`, { houseAccountCode: 'STAFF-MEALS', reason: 'Night shift meals', approval: MANAGER }).expect(200);
      expect(res.body).toMatchObject({ status: 'closed', settlement: 'house_account' });

      const after = (await api('k1.manager').get(`${POS}/reports/sales?from=${c.businessDate}&to=${c.businessDate}&outlet=K1-KOFFEE`).expect(200)).body;
      expect(after.netSales).toBe(before.netSales);
      expect(Number(after.houseAccounts.total) - Number(before.houseAccounts.total)).toBeCloseTo(2500, 2);
      const accounts = await api('k1.manager').get(`${POS}/house-accounts`).expect(200);
      expect(accounts.body.find((a: { code: string }) => a.code === 'STAFF-MEALS').usedThisMonth).not.toBe('0.00');
    });
  });

  // ---------------------------------------------------------------------------
  describe('offline capture (OPS-05)', () => {
    it('keeps device-generated check and line ids; a replay is idempotent and a clash is refused', async () => {
      const id = randomUUID();
      const lineId = randomUUID();
      const key = uniqueKey('offline');
      const body = { id, serviceType: 'counter', deviceId: 'tab-k1-01', clientOpenedAt: new Date(Date.now() - 60_000).toISOString() };
      const first = await api('k1.waiter').post(`${POS}/outlets/K1-COCKTAIL/checks`, body, key).expect(201);
      expect(first.body.id).toBe(id);
      const replay = await api('k1.waiter').post(`${POS}/outlets/K1-COCKTAIL/checks`, body, key).expect(201);
      expect(replay.body.number).toBe(first.body.number);
      const clash = await api('k1.waiter').post(`${POS}/outlets/K1-COCKTAIL/checks`, body).expect(409);
      expect(clash.body.error).toBe('duplicate');

      const added = await add('k1.waiter', id, [{ id: lineId, portionId: (await item('K1-COCKTAIL', 'SD-SODA')).portionId, quantity: '1' }]).expect(200);
      expect(added.body.lines[0].id).toBe(lineId);
      await api('k1.waiter').post(`${POS}/checks/${id}/void`, { reason: 'Test check', approval: MANAGER }).expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('property isolation (AT-18, AT-04)', () => {
    it('staff of one property cannot see or sell at another', async () => {
      const c = await openCheck('k1.waiter', 'K1-COCKTAIL');
      await api('km.waiter').get(`${POS}/checks/${c.id}`).expect(403);
      await api('km.waiter').get('/api/properties/KM/pos/checks/' + c.id).expect(404);
      await api('km.waiter').post('/api/properties/KM/pos/outlets/K1-COCKTAIL/checks', { serviceType: 'counter' }).expect(404);
      await api('k1.waiter').post(`${POS}/checks/${c.id}/void`, { reason: 'Test check', approval: MANAGER }).expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('POS day close and the property business day (Small World)', () => {
    const SW = '/api/properties/SW';

    it('closing the outlet day waits for open checks; the property close waits for outlet days; empty days close themselves', async () => {
      const today = (await api('owner').get(SW).expect(200)).body.currentBusinessDate;
      const c = await openCheck('sw.waiter', 'SW-MAINBAR', {}, 'SW');
      expect(c.businessDate).toBe(today);
      // An outlet day that saw nothing (opened and left empty) closes itself with the property.
      const shop = await api('sw.manager').post(`${SW}/pos/shifts`, { outletCode: 'SW-SHOP', openingFloat: '0.00' }).expect(201);
      await api('sw.manager').post(`${SW}/pos/shifts/${shop.body.id}/close`, { countedAmount: '0.00' }).expect(200);
      await add('sw.waiter', c.id, [{ portionId: (await item('SW-MAINBAR', 'BR-WHITECAP', 'STD', 'SW')).portionId, quantity: '2' }], {}, 'SW').expect(200);

      await api('sw.waiter').post(`${SW}/pos/outlets/SW-MAINBAR/close-day`, { businessDate: today }).expect(403);
      const open = await api('sw.manager').post(`${SW}/pos/outlets/SW-MAINBAR/close-day`, { businessDate: today }).expect(409);
      expect(open.body).toMatchObject({ error: 'open_checks', checks: [c.number] });
      const prop = await api('sw.manager').post(`${SW}/front-desk/close-day`, { businessDate: today }).expect(409);
      expect(prop.body.error).toBe('outlet_days_open');

      await api('sw.waiter').post(`${SW}/pos/checks/${c.id}/payments`, { tenders: [{ tender: 'card', amount: '700.00', reference: uniqueKey('AUTH') }] }, uniqueKey(), ).expect(200);
      const z = await api('sw.manager').post(`${SW}/pos/outlets/SW-MAINBAR/close-day`, { businessDate: today }).expect(200);
      expect(z.body.totals).toMatchObject({ reconciliation: { difference: '0.00' } });
      expect(z.body.totals.settlements.payments).toEqual(expect.arrayContaining([{ tender: 'card', amount: '700.00', count: 1 }]));

      // The shop's day has a closed shift, so a manager closes it too; then the property day closes.
      await api('sw.manager').post(`${SW}/pos/outlets/SW-SHOP/close-day`, { businessDate: today }).expect(200);
      await api('sw.manager').post(`${SW}/pos/outlets/SW-KITCHEN/close-day`, { businessDate: today }).expect(200); // room-charge tests above
      const closed = await api('sw.manager').post(`${SW}/front-desk/close-day`, { businessDate: today }).expect(200);
      expect(closed.body.businessDate).toBe(addDays(today, 1));

      const print = await api('sw.manager').get(`${SW}/pos/days/${z.body.dayId}/print`).expect(200);
      expect(print.text).toContain('Z REPORT');
      expect(print.text).toContain('Card (1)');
      const owner = await ownerClient();
      try {
        await expect(owner.query(`UPDATE pos_outlet_days SET totals = '{}' WHERE id = $1`, [z.body.dayId])).rejects.toThrow(/finalised/);
      } finally {
        await owner.end();
      }

      // The next check opens the next trading day.
      const next = await openCheck('sw.waiter', 'SW-MAINBAR', {}, 'SW');
      expect(next.businessDate).toBe(addDays(today, 1));
      await api('sw.waiter').post(`${SW}/pos/checks/${next.id}/void`, { reason: 'Test check', approval: { username: 'sw.manager', password: process.env.SEED_PASSWORD } }).expect(200);
      const nextDay = await api('sw.manager').post(`${SW}/pos/outlets/SW-MAINBAR/close-day`, { businessDate: addDays(today, 1) }).expect(200);
      expect(nextDay.body.totals.checks).toMatchObject({ closed: 0, void: 1 });
    });
  });
});
