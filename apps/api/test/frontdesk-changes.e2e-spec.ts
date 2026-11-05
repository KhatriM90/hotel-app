import { INestApplication } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import request from 'supertest';
import { addDays, Money } from '@hotel/shared';
import { EmailService } from '../src/frontoffice/email.service';
import { login, ownerClient, startApp, uniqueKey } from './helpers';

/**
 * Front desk changes requested after the 5 Nov 2026 client demo: mandatory
 * guest fields with KRA PIN, travel agents, choosing a room number at booking,
 * the room status dashboard, prepaid credit warnings, the manager-only
 * auto-posting switch and the booking confirmation email.
 */
describe('Front desk changes (5 Nov 2026 demo)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const tokens: Record<string, string> = {};
  const USERS = ['owner', 'sw.manager', 'sw.reception', 'sw.waiter', 'km.reception'];
  const SW = '/api/properties/SW';
  // A business date far from the other suites' bookings, so rooms are free.
  const DAY = '2031-03-03';

  const api = (user: string) => ({
    get: (path: string) => request(http).get(path).set('Authorization', `Bearer ${tokens[user]}`),
    post: (path: string, body: object = {}, key = uniqueKey()) =>
      request(http).post(path).set('Authorization', `Bearer ${tokens[user]}`).set('Idempotency-Key', key).send(body),
    put: (path: string, body: object) => request(http).put(path).set('Authorization', `Bearer ${tokens[user]}`).send(body),
    patch: (path: string, body: object) => request(http).patch(path).set('Authorization', `Bearer ${tokens[user]}`).send(body),
  });

  let seq = 0;
  const kenyan = (extra: object = {}) => ({
    firstName: 'Change', lastName: `Guest${++seq}`, phone: `+2547300${String(10000 + seq)}`, nationality: 'KE',
    kraPin: `A${String(300000000 + seq)}B`, ...extra,
  });
  const book = (body: Record<string, unknown>, user = 'sw.reception') =>
    api(user).post(`${SW}/reservations`, { source: 'phone', guest: kenyan(), arrival: DAY, departure: addDays(DAY, 3), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1 }], ...body });

  beforeAll(async () => {
    app = await startApp();
    http = app.getHttpServer();
    for (const u of USERS) tokens[u] = await login(app, u);
    const owner = await ownerClient();
    try {
      await owner.query(`UPDATE properties SET current_business_date = $1 WHERE code = 'SW'`, [DAY]);
    } finally {
      await owner.end();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('mandatory guest fields and KRA PIN', () => {
    it('needs a KRA PIN from a Kenyan guest but not from a foreign one', async () => {
      const res = await api('sw.reception').post('/api/guests', { firstName: 'No', lastName: 'Pin', phone: '+254730099001', nationality: 'KE' }).expect(400);
      expect(res.body).toMatchObject({ error: 'missing_guest_fields', fields: ['kraPin'] });
      expect(res.body.message).toMatch(/KRA PIN/);
      await api('sw.reception').post('/api/guests', { firstName: 'Visiting', lastName: 'Guest', phone: '+447700900123', nationality: 'GB' }).expect(201);
      const ok = await api('sw.reception').post('/api/guests', kenyan({ kraPin: 'a123456789z' })).expect(201);
      expect(ok.body.kraPin).toBe('A123456789Z');
    });

    it('refuses a malformed KRA PIN and an unknown country', async () => {
      await api('sw.reception').post('/api/guests', kenyan({ kraPin: '12345' })).expect(400);
      await api('sw.reception').post('/api/guests', kenyan({ nationality: 'XX' })).expect(400);
    });

    it('applies the rules when a booking creates the guest', async () => {
      const res = await book({ guest: { firstName: 'Walk', lastName: 'In', phone: '+254730099002', nationality: 'KE' } }).expect(400);
      expect(res.body.fields).toEqual(['kraPin']);
    });

    it('lets a manager change which fields are mandatory, not a receptionist', async () => {
      await api('sw.reception').put('/api/guest-field-rules', { email: 'required' }).expect(403);
      const rules = await api('sw.manager').put('/api/guest-field-rules', { email: 'required', kraPin: 'optional' }).expect(200);
      expect(rules.body).toMatchObject({ email: 'required', kraPin: 'optional', phone: 'required' });
      try {
        const res = await api('sw.reception').post('/api/guests', { firstName: 'No', lastName: 'Email', phone: '+254730099003', nationality: 'KE' }).expect(400);
        expect(res.body.fields).toEqual(['email']);
      } finally {
        await api('sw.manager').put('/api/guest-field-rules', { email: 'optional', kraPin: 'required_kenyan' }).expect(200);
      }
      const now = await api('sw.reception').get('/api/guest-field-rules').expect(200);
      expect(now.body.kraPin).toBe('required_kenyan');
    });
  });

  describe('travel agents and companies', () => {
    it('lets reception add an agent, refuses a duplicate name, and books through it', async () => {
      const name = `Rift Valley Safaris ${uniqueKey()}`;
      const agent = await api('sw.reception').post('/api/companies', { kind: 'agent', name, contactEmail: 'res@riftvalley.example', creditDays: 30 }).expect(201);
      expect(agent.body).toMatchObject({ kind: 'agent', name, creditDays: 30, isActive: true });
      await api('sw.reception').post('/api/companies', { kind: 'agent', name: name.toUpperCase() }).expect(409);
      await api('sw.waiter').post('/api/companies', { kind: 'agent', name: `${name} 2` }).expect(403);

      const edited = await api('sw.reception').patch(`/api/companies/${agent.body.id}`, { contactPhone: '+254711222333', kraPin: 'p051234567q' }).expect(200);
      expect(edited.body).toMatchObject({ contactPhone: '+254711222333', kraPin: 'P051234567Q' });

      const agents = await api('sw.reception').get('/api/companies?kind=agent').expect(200);
      expect(agents.body.some((a: { id: string }) => a.id === agent.body.id)).toBe(true);
      const booked = await book({ source: 'agent', agentId: agent.body.id, agentReference: 'RV-1', arrival: addDays(DAY, 40), departure: addDays(DAY, 41) }).expect(201);
      expect(booked.body.agent.name).toBe(name);

      await api('sw.reception').patch(`/api/companies/${agent.body.id}`, { isActive: false }).expect(200);
      const active = await api('sw.reception').get('/api/companies?kind=agent').expect(200);
      expect(active.body.some((a: { id: string }) => a.id === agent.body.id)).toBe(false);
    });
  });

  describe('choosing the room number at booking', () => {
    it('books the room asked for and refuses it to an overlapping booking', async () => {
      const arrival = addDays(DAY, 50);
      const free = await api('sw.reception').get(`${SW}/availability/rooms?roomTypeCode=STD&arrival=${arrival}&departure=${addDays(arrival, 2)}`).expect(200);
      const room = free.body[free.body.length - 1];
      const res = await book({ arrival, departure: addDays(arrival, 2), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1, roomId: room.id }] }).expect(201);
      expect(res.body.stays[0].roomNumber).toBe(room.number);
      const clash = await book({ arrival: addDays(arrival, 1), departure: addDays(arrival, 3), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 1, roomId: room.id }] }).expect(409);
      expect(clash.body.error).toBe('room_unavailable');
    });
  });

  describe('room dashboard, prepaid credit and auto-posting', () => {
    let stay: { id: string; folioId: string; roomId: string; roomNumber: string; nights: Array<{ amount: string }> };
    let reservationId: string;

    beforeAll(async () => {
      const res = await book({ arrival: DAY, departure: addDays(DAY, 3), rooms: [{ roomTypeCode: 'STD', ratePlanCode: 'RACK', adults: 2 }] }).expect(201);
      reservationId = res.body.id;
      stay = res.body.stays[0];
      // A second occupant needs only a name: the mandatory fields apply to the booker.
      await api('sw.reception')
        .post(`${SW}/stays/${stay.id}/check-in`, {
          identity: { documentType: 'national_id', documentNumber: `4${String(1000000 + seq)}`, issuingCountry: 'KE' },
          occupants: [{ firstName: 'Second', lastName: 'Occupant' }],
          roomChargeAllowed: true,
        })
        .expect(200);
    });

    it('shows rooms, the in-house stay and blocks for an inclusive range', async () => {
      const res = await api('sw.reception').get(`${SW}/room-dashboard?from=${DAY}&to=${addDays(DAY, 6)}`).expect(200);
      expect(res.body).toMatchObject({ from: DAY, to: addDays(DAY, 6), days: 7, businessDate: DAY });
      expect(res.body.rooms.length).toBe(42);
      const seg = res.body.segments.find((s: { stayId: string }) => s.stayId === stay.id);
      expect(seg).toMatchObject({ kind: 'stay', status: 'checked_in', from: DAY, to: addDays(DAY, 3), roomId: stay.roomId, reservationId });
      expect(res.body.rooms.find((r: { id: string }) => r.id === stay.roomId)).toHaveProperty('hkStatus');
    });

    it('rejects a reversed range and one longer than 366 days', async () => {
      await api('sw.reception').get(`${SW}/room-dashboard?from=${DAY}&to=${addDays(DAY, -1)}`).expect(400);
      await api('sw.reception').get(`${SW}/room-dashboard?from=${DAY}&to=${addDays(DAY, 366)}`).expect(400);
      await api('sw.reception').get(`${SW}/room-dashboard?from=${DAY}&to=${addDays(DAY, 365)}`).expect(200);
      await api('km.reception').get(`${SW}/room-dashboard?from=${DAY}&to=${DAY}`).expect(403);
    });

    it('warns the day before prepaid credit runs out', async () => {
      const credit = async () =>
        (await api('sw.reception').get(`${SW}/front-desk/credit`).expect(200)).body.find((c: { stayId: string }) => c.stayId === stay.id);
      expect((await credit()).status).toBe('no_prepayment');

      // Pays for the first night only: covered tonight, runs out tomorrow.
      await api('sw.reception').post(`${SW}/folios/${stay.folioId}/payments`, { tenders: [{ tender: 'cash', amount: stay.nights[0].amount }] }).expect(201);
      let c = await credit();
      expect(c).toMatchObject({ status: 'runs_out_tomorrow', nightsUnposted: 3, nightsCovered: 1, paidThrough: addDays(DAY, 1), autoPostRoomCharges: true });

      // Pays the rest: every remaining night is covered.
      const rest = Money.of(stay.nights[1].amount).add(stay.nights[2].amount).toString();
      await api('sw.reception').post(`${SW}/folios/${stay.folioId}/payments`, { tenders: [{ tender: 'cash', amount: rest }] }).expect(201);
      c = await credit();
      expect(c).toMatchObject({ status: 'covered', nightsCovered: 3, paidThrough: addDays(DAY, 3) });

      const dash = await api('sw.reception').get(`${SW}/room-dashboard?from=${DAY}&to=${DAY}`).expect(200);
      expect(dash.body.credit.find((x: { stayId: string }) => x.stayId === stay.id).status).toBe('covered');
    });

    it('lets only a manager switch nightly posting off; the day close then skips the stay', async () => {
      await api('sw.reception').post(`${SW}/stays/${stay.id}/auto-posting`, { enabled: false, reason: 'Company pays at checkout' }).expect(403);
      await api('sw.manager').post(`${SW}/stays/${stay.id}/auto-posting`, { enabled: false }).expect(400);
      const off = await api('sw.manager').post(`${SW}/stays/${stay.id}/auto-posting`, { enabled: false, reason: 'Company pays at checkout' }).expect(200);
      expect(off.body.autoPostRoomCharges).toBe(false);

      const closed = await api('sw.manager').post(`${SW}/front-desk/close-day`, { businessDate: DAY }).expect(200);
      expect(closed.body.closedDate).toBe(DAY);
      let folio = await api('sw.reception').get(`${SW}/folios/${stay.folioId}`).expect(200);
      expect(folio.body.charges.filter((x: { chargeCode: string }) => x.chargeCode === 'ROOM')).toHaveLength(0);

      await api('sw.manager').post(`${SW}/stays/${stay.id}/auto-posting`, { enabled: true, reason: 'Back to nightly posting' }).expect(200);
      await api('sw.manager').post(`${SW}/front-desk/close-day`, { businessDate: addDays(DAY, 1) }).expect(200);
      folio = await api('sw.reception').get(`${SW}/folios/${stay.folioId}`).expect(200);
      // Both nights so far are posted once the switch is back on.
      expect(folio.body.charges.filter((x: { chargeCode: string }) => x.chargeCode === 'ROOM')).toHaveLength(2);

      const owner = await ownerClient();
      try {
        const { rows } = await owner.query(`SELECT reason FROM audit_events WHERE action = 'stay.auto_posting' AND entity_id = $1 ORDER BY id`, [stay.id]);
        expect(rows.map((r) => r.reason)).toEqual(['Company pays at checkout', 'Back to nightly posting']);
      } finally {
        await owner.end();
      }
    });
  });

  describe('booking confirmation email', () => {
    it('queues one confirmation with the pro forma when a booking is confirmed, and sends it with PDFs', async () => {
      const policy = await api('sw.manager').put(`${SW}/policy`, { hotelPolicies: 'No smoking in rooms.\nQuiet hours 22:00 to 07:00.' }).expect(200);
      expect(policy.body.hotelPolicies).toContain('No smoking');
      const res = await book({ guest: kenyan({ email: 'guest.confirm@example.com' }), arrival: addDays(DAY, 60), departure: addDays(DAY, 62) }).expect(201);
      const id = res.body.id;
      const list = await api('sw.reception').get(`${SW}/reservations/${id}/emails`).expect(200);
      expect(list.body.configured).toBe(false);
      expect(list.body.messages).toHaveLength(1);
      expect(list.body.messages[0]).toMatchObject({ to: 'guest.confirm@example.com', status: 'pending', kind: 'booking_confirmation' });
      expect(list.body.messages[0].attachments).toHaveLength(1);
      expect(list.body.messages[0].attachments[0]).toMatch(/^SW-/);

      const sent: Array<{ to: string; subject: string; attachments: string[]; html: string }> = [];
      const emails = app.get(EmailService);
      const transport = createTransport({ streamTransport: true, buffer: true });
      const original = transport.sendMail.bind(transport);
      transport.sendMail = (async (m: { to: string; subject: string; html: string; attachments: Array<{ filename: string; content: Buffer }> }) => {
        expect(m.attachments.every((a) => a.content.subarray(0, 4).toString() === '%PDF')).toBe(true);
        sent.push({ to: m.to, subject: m.subject, html: m.html, attachments: m.attachments.map((a) => a.filename) });
        return original(m as never);
      }) as never;
      emails.useTransport(transport);
      try {
        await emails.sendDue(50);
      } finally {
        emails.useTransport(null);
      }
      const mine = sent.find((m) => m.to === 'guest.confirm@example.com')!;
      expect(mine.subject).toContain(res.body.number);
      expect(mine.attachments[0]).toMatch(/\.pdf$/);
      expect(mine.html).toContain('Hotel policies');
      expect(mine.html).toContain('Quiet hours 22:00 to 07:00.');
      const after = await api('sw.reception').get(`${SW}/reservations/${id}/emails`).expect(200);
      expect(after.body.messages[0].status).toBe('sent');

      // A resend with the same idempotency key does not queue a second message.
      const key = uniqueKey('resend');
      await api('sw.reception').post(`${SW}/reservations/${id}/emails/confirmation`, {}, key).expect(201);
      await api('sw.reception').post(`${SW}/reservations/${id}/emails/confirmation`, {}, key).expect(201);
      const twice = await api('sw.reception').get(`${SW}/reservations/${id}/emails`).expect(200);
      expect(twice.body.messages).toHaveLength(2);
    });

    it('sends nothing automatically without an address, and sends to an address given at the desk', async () => {
      const res = await book({ arrival: addDays(DAY, 70), departure: addDays(DAY, 71) }).expect(201);
      const none = await api('sw.reception').get(`${SW}/reservations/${res.body.id}/emails`).expect(200);
      expect(none.body.messages).toHaveLength(0);
      await api('sw.reception').post(`${SW}/reservations/${res.body.id}/emails/confirmation`, {}).expect(400);
      const msg = await api('sw.reception').post(`${SW}/reservations/${res.body.id}/emails/confirmation`, { to: 'booker@example.org' }).expect(201);
      expect(msg.body).toMatchObject({ to: 'booker@example.org', status: 'pending' });
      await api('sw.waiter').post(`${SW}/reservations/${res.body.id}/emails/confirmation`, { to: 'x@example.org' }).expect(403);
    });

    it('never lets an outbox message be edited or deleted', async () => {
      const owner = await ownerClient();
      try {
        const { rows } = await owner.query(`SELECT id FROM email_outbox LIMIT 1`);
        await expect(owner.query(`UPDATE email_outbox SET to_address = 'evil@example.com' WHERE id = $1`, [rows[0].id])).rejects.toThrow();
        await expect(owner.query(`DELETE FROM email_outbox WHERE id = $1`, [rows[0].id])).rejects.toThrow();
      } finally {
        await owner.end();
      }
    });
  });
});
