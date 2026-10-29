import { addDays } from '@hotel/shared';
import { ApiError, UserApi } from './api-client';
import {
  amount,
  book,
  cardRef,
  cents,
  charge,
  checkIn,
  DemoContext,
  done,
  folio,
  mpesaRef,
  pay,
  PropertyCode,
  Reservation,
  scenario,
  Stay,
} from './context';
import { demoGuest, DemoGuest } from './demo-data';

/**
 * Reservations and front-desk demo for one property. Runs in two parts:
 *
 *  - `arrivePast` books and checks in the guests who should look as if they
 *    arrived before today. It runs on the property's business date before the
 *    demo closes that day (so the night audit posts their room nights).
 *  - `present` does everything that happens "today": departures, check-outs,
 *    room moves, new arrivals, future bookings, cancellations and requests.
 *
 * When no earlier business date is available the "past" guests arrive today
 * instead, and the scenarios that need an earlier arrival say so.
 */

interface PropertyPlan {
  code: PropertyCode;
  reception: string;
  manager: string;
  /** Room types: standard, upgrade, top. */
  std: string;
  dlx: string;
  top: string;
  /** Room type for the family stay (two adults and two children). */
  family: string;
  food: string;
  bar: string;
  laundry?: string;
  /** Guest keys by role (see demo-data.ts). */
  g: Partial<Record<GuestRole, string>>;
}

type GuestRole =
  | 'inHouse' | 'dueOut' | 'checkedOut' | 'lateOut' | 'cityLedger' | 'noShow'
  | 'arrivalDeposit' | 'arrivalDirty' | 'walkIn' | 'override' | 'lateCancel'
  | 'future' | 'enquiry' | 'hold' | 'cancelled' | 'groupLead' | 'group2' | 'festive';

export const PLANS: Record<PropertyCode, PropertyPlan> = {
  K1: {
    code: 'K1', reception: 'k1.reception', manager: 'k1.manager',
    std: 'STD', dlx: 'DLX', top: 'STE', family: 'DLX',
    food: 'K1-KOFFEE', bar: 'K1-COCKTAIL', laundry: 'K1-LAUNDRY',
    g: {
      inHouse: 'k1-corporate', dueOut: 'k1-due-out', checkedOut: 'k1-checked-out', lateOut: 'k1-late-out',
      cityLedger: 'k1-city-ledger', noShow: 'k1-no-show', arrivalDeposit: 'k1-arrival-deposit', arrivalDirty: 'k1-arrival-dirty',
      walkIn: 'k1-walk-in', override: 'k1-override', lateCancel: 'k1-late-cancel', future: 'k1-future', enquiry: 'k1-enquiry',
      hold: 'k1-hold', cancelled: 'k1-cancelled', groupLead: 'k1-group-lead', group2: 'k1-group-2',
    },
  },
  SW: {
    code: 'SW', reception: 'sw.reception', manager: 'sw.manager',
    std: 'STD', dlx: 'TWN', top: 'EXE', family: 'FAM',
    food: 'SW-KITCHEN', bar: 'SW-MAINBAR',
    g: {
      inHouse: 'sw-family', dueOut: 'sw-due-out', checkedOut: 'sw-checked-out', arrivalDeposit: 'sw-arrival',
      arrivalDirty: 'sw-walk-in', groupLead: 'sw-group-lead', group2: 'sw-family-2', festive: 'sw-festive', cancelled: 'sw-cancelled',
    },
  },
  KM: {
    code: 'KM', reception: 'km.reception', manager: 'km.manager',
    std: 'STD', dlx: 'DLX', top: 'JST', family: 'DLX',
    food: 'KM-PITCHER', bar: 'KM-COCKTAIL', laundry: 'KM-LAUNDRY',
    g: {
      inHouse: 'km-agent', dueOut: 'km-due-out', checkedOut: 'km-checked-out', noShow: 'km-no-show', arrivalDeposit: 'km-arrival',
      walkIn: 'km-walk-in', future: 'km-future', enquiry: 'km-enquiry',
    },
  },
};

/** Stays created before the day close, picked up again "today". */
export interface PastStays {
  inHouse?: Stay & { reservationId: string };
  dueOut?: Stay;
  checkedOut?: Stay;
  lateOut?: Stay;
  cityLedger?: Stay;
  noShow?: { reservationId: string; number: string };
}

/** In-house stays the POS demo can charge to (BIL-02). */
export interface HotelForPos {
  inHouse?: { id: string; name: string; room: string | null };
  walkIn?: { id: string; name: string; room: string | null };
}

/**
 * A free, ready room for a stay starting today. Rooms whose guest is due out
 * today but has not checked out yet look free from tonight, so they are left
 * out: nobody is moved or checked in on top of a guest still in the room.
 */
async function readyRoom(ctx: DemoContext, user: UserApi, type: string, departure: string, past: PastStays, exclude: Array<string | null> = []) {
  const stillIn = [past.inHouse, past.dueOut, past.lateOut, past.checkedOut, past.cityLedger].map((s) => s?.roomId);
  const free = await user.get<Array<{ id: string; number: string; hkStatus: string }>>(
    `${ctx.base}/availability/rooms?roomTypeCode=${type}&arrival=${ctx.today}&departure=${departure}`,
  );
  const room = free.find((r) => ['clean', 'inspected'].includes(r.hkStatus) && ![...stillIn, ...exclude].includes(r.id));
  if (!room) throw new Error(`no ready ${type} room free from ${ctx.today} to ${departure}`);
  return room;
}

const guestOf = (plan: PropertyPlan, role: GuestRole): DemoGuest | null => (plan.g[role] ? demoGuest(plan.g[role]!) : null);

async function companies(user: UserApi) {
  const list = await user.get<Array<{ id: string; name: string; kind: string }>>('/companies');
  return {
    acme: list.find((c) => c.name === 'Acme Logistics Ltd')?.id,
    savannah: list.find((c) => c.name === 'Savannah Tours & Travel')?.id,
  };
}

/** Guests who arrived before today (or today, when there is no earlier business date). */
export async function arrivePast(ctx: DemoContext): Promise<PastStays> {
  const plan = PLANS[ctx.code];
  const rec = await ctx.api.as(plan.reception);
  const arrival = ctx.startDate;
  const since = ctx.history ? `arrived ${arrival}` : 'arrived today (no earlier business date available)';
  const dueDate = ctx.history ? ctx.today : addDays(ctx.today, 1);
  const { acme, savannah } = await companies(rec);
  const out: PastStays = {};

  const stayIn = async (role: GuestRole, b: Omit<Parameters<typeof book>[2], 'guest' | 'arrival'>, charges: Array<Parameters<typeof charge>[3]>) => {
    const g = guestOf(plan, role)!;
    const res = await book(ctx, rec, { guest: g, arrival, ...b });
    const stay = res.stays[0];
    if (res.deposit.required !== '0.00') {
      await pay(ctx, rec, stay.folioId, [{ tender: 'mpesa', amount: res.deposit.required, reference: mpesaRef() }]);
    }
    const after = await checkIn(ctx, rec, stay, g, { registration: { method: 'paper_signature', signedName: `${g.firstName} ${g.lastName}` } });
    for (const c of charges) await charge(ctx, rec, stay.folioId, c);
    const s = after.stays[0];
    return { ...s, reservationId: res.id };
  };

  const food = (description: string, unitPrice: string, quantity = '1') => ({ chargeCode: 'FOOD', description, unitPrice, quantity, outletCode: plan.food });
  const drinks = (description: string, unitPrice: string, quantity = '1') => ({ chargeCode: 'BEVERAGE', description, unitPrice, quantity, outletCode: plan.bar });
  const laundry = (description: string, unitPrice: string) =>
    plan.laundry ? { chargeCode: 'LAUNDRY', description, unitPrice, outletCode: plan.laundry } : { chargeCode: 'MINIBAR', description: 'Minibar: water and juice', unitPrice: '450.00' };

  if (plan.g.inHouse) {
    out.inHouse = await scenario(ctx, 'In-house guest with deposit and folio charges', async () => {
      const g = guestOf(plan, 'inHouse')!;
      const corporate = ctx.code === 'K1' && acme;
      const agent = ctx.code === 'KM' && savannah;
      const s = await stayIn(
        'inHouse',
        {
          departure: addDays(ctx.today, 2),
          roomTypeCode: ctx.code === 'SW' ? plan.family : plan.std,
          ratePlanCode: corporate ? 'CORPACME' : agent ? 'AGENTSAV' : 'RACK',
          adults: 2,
          children: ctx.code === 'SW' ? 2 : 0,
          source: agent ? 'agent' : corporate ? 'email' : 'phone',
          companyId: corporate ? acme : undefined,
          agentId: agent ? savannah : undefined,
          agentReference: agent ? 'SAV-24817' : undefined,
          note: `in-house guest, ${since}`,
        },
        [food('Dinner for two', '1250.00', '2'), drinks('Drinks at the bar', '700.00', '2'), laundry('Laundry: 3 shirts', '900.00')],
      );
      return done(`${g.firstName} ${g.lastName}, stay ${s.number}, room ${s.roomNumber}, folio ${s.folioNumber}`, s);
    });
  }

  if (plan.g.dueOut) {
    out.dueOut = await scenario(ctx, ctx.history ? 'Departure today, balance still due' : 'In-house guest due out tomorrow', async () => {
      const s = await stayIn('dueOut', { departure: dueDate, roomTypeCode: plan.dlx, adults: 1, note: `due out ${dueDate}, ${since}` }, [
        food('Breakfast', '1200.00'),
        drinks('Room service drinks', '350.00', '3'),
      ]);
      return done(`stay ${s.number}, room ${s.roomNumber}, due out ${dueDate}`, s);
    });
  }

  if (plan.g.checkedOut) {
    out.checkedOut = await scenario(ctx, 'Guest who will check out today (set up)', async () => {
      const s = await stayIn('checkedOut', { departure: dueDate, roomTypeCode: plan.std, adults: 1, note: `checked out today, ${since}` }, [
        food('Lunch', '1500.00'),
        drinks('Bar tab', '350.00', '4'),
      ]);
      return done(`stay ${s.number}, room ${s.roomNumber}`, s);
    });
  }

  if (plan.g.lateOut) {
    out.lateOut = await scenario(ctx, 'Guest who will get a late check-out (set up)', async () => {
      const s = await stayIn('lateOut', { departure: dueDate, roomTypeCode: plan.std, adults: 1, note: `late check-out, ${since}` }, [food('Dinner', '1250.00')]);
      return done(`stay ${s.number}, room ${s.roomNumber}`, s);
    });
  }

  if (plan.g.cityLedger && acme) {
    out.cityLedger = await scenario(ctx, 'Company-billed guest (set up)', async () => {
      const s = await stayIn(
        'cityLedger',
        { departure: dueDate, roomTypeCode: plan.std, ratePlanCode: 'CORPACME', companyId: acme, source: 'email', adults: 1, note: `bill to Acme Logistics, ${since}` },
        [food('Working lunch', '1500.00')],
      );
      return done(`stay ${s.number}, room ${s.roomNumber}`, s);
    });
  }

  if (plan.g.noShow) {
    out.noShow = await scenario(ctx, 'Booking that will be a no-show (set up)', async () => {
      const g = guestOf(plan, 'noShow')!;
      const res = await book(ctx, rec, { guest: g, arrival, departure: addDays(arrival, 2), roomTypeCode: plan.std, adults: 1, note: 'guest did not arrive' });
      return done(`booking ${res.number}`, { reservationId: res.id, number: res.number });
    });
  }
  return out;
}

/** Everything that happens on the demo's "today". */
export async function present(ctx: DemoContext, past: PastStays): Promise<HotelForPos> {
  const plan = PLANS[ctx.code];
  const rec = await ctx.api.as(plan.reception);
  const approval = ctx.api.approval(plan.manager);
  const T = ctx.today;
  const base = ctx.base;
  const { acme, savannah } = await companies(rec);
  const staff = await rec.get<Array<{ id: string; displayName: string }>>(`${base}/staff`);
  const managerId = staff.find((u) => u.displayName.toLowerCase().includes('manager'))?.id;
  const forPos: HotelForPos = {};
  const name = (g: DemoGuest) => `${g.firstName} ${g.lastName}`;

  // --- Departures --------------------------------------------------------
  if (past.checkedOut) {
    const s = past.checkedOut;
    await scenario(ctx, 'Checked out today, settled with two tenders', async () => {
      // Checkout posts any room night the day close has not, so the amount to settle comes from the
      // checkout itself: without tenders it is refused with the balance due, and nothing is saved.
      let due = cents((await folio(ctx, rec, s.folioId)).balance.balance);
      try {
        await rec.post(`${base}/stays/${s.id}/check-out`, {});
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'balance_not_zero') throw err;
        due = cents(String(err.body.balance));
      }
      const card = Math.floor(due / 2 / 100) * 100;
      const out = await rec.post<{ invoice: { number: string } }>(`${base}/stays/${s.id}/check-out`, {
        tenders: [
          { tender: ctx.code === 'SW' ? 'mpesa' : 'cash', amount: amount(due - card), reference: ctx.code === 'SW' ? mpesaRef() : undefined },
          { tender: 'card', amount: amount(card), reference: cardRef() },
        ],
      });
      return `stay ${s.number}, invoice ${out.invoice.number}, room ${s.roomNumber} now dirty`;
    });
  }

  if (past.cityLedger && acme) {
    const s = past.cityLedger;
    await scenario(ctx, 'Checked out to the company account (manager approved)', async () => {
      const out = await rec.post<{ invoice: { number: string } }>(`${base}/stays/${s.id}/check-out`, {
        creditTransfer: { companyId: acme, reason: 'Acme Logistics pays on monthly invoice' },
        approval,
      });
      return `stay ${s.number}, invoice ${out.invoice.number}, billed to Acme Logistics Ltd`;
    });
  }

  if (past.lateOut) {
    const s = past.lateOut;
    await scenario(ctx, 'Late check-out at 15:00 with the policy fee', async () => {
      await rec.post(`${base}/stays/${s.id}/late-checkout`, { departureTime: '15:00' });
      return `stay ${s.number}, room ${s.roomNumber}, leaves 15:00`;
    });
    await scenario(ctx, 'Guest request in progress (maintenance)', async () => {
      const r = await rec.post<{ id: string }>(`${base}/guest-requests`, {
        stayId: s.id, category: 'maintenance', priority: 'high', description: 'Air conditioning is noisy', ownerUserId: managerId,
      });
      await rec.patch(`${base}/guest-requests/${r.id}`, { status: 'in_progress', note: 'Technician called, arriving 11:00' });
      return `room ${s.roomNumber}, in progress`;
    });
  }

  if (past.dueOut) {
    const s = past.dueOut;
    if (ctx.code === 'K1') {
      await scenario(ctx, 'M-PESA payment awaiting confirmation', async () => {
        await pay(ctx, rec, s.folioId, [{ tender: 'mpesa', amount: '2000.00', reference: mpesaRef(), status: 'pending' }]);
        return `stay ${s.number}, 2,000.00 pending (blocks checkout until confirmed)`;
      });
    }
  }

  if (past.noShow) {
    const n = past.noShow;
    await scenario(ctx, 'No-show with the first night charged', async () => {
      await rec.post(`${base}/reservations/${n.reservationId}/no-show`, { reason: 'Guest did not arrive and did not call' });
      return `booking ${n.number}`;
    });
  }

  // --- In-house ----------------------------------------------------------
  if (past.inHouse) {
    const s = past.inHouse;
    const g = guestOf(plan, 'inHouse')!;
    forPos.inHouse = { id: s.id, name: name(g), room: s.roomNumber };
    if (ctx.code !== 'SW') {
      await scenario(ctx, 'Room move (same stay, same folio)', async () => {
        const to = await readyRoom(ctx, rec, plan.std, s.departureDate, past);
        await rec.post(`${base}/stays/${s.id}/move`, { toRoomId: to.id, reason: `Guest asked for a quieter room than ${s.roomNumber}` });
        forPos.inHouse!.room = to.number;
        return `stay ${s.number} moved ${s.roomNumber} → ${to.number}`;
      });
    }
    await scenario(ctx, 'Charge reversed with a manager’s approval', async () => {
      const c = await charge(ctx, rec, s.folioId, { chargeCode: 'MINIBAR', description: 'Minibar: 2 sodas (wrong room)', unitPrice: '150.00', quantity: '2' });
      await rec.post(`${base}/folios/${s.folioId}/charges/${c.id}/reverse`, { reason: 'Posted to the wrong room', approval });
      return `folio ${s.folioNumber}: minibar charge and its reversal both kept`;
    });
    await scenario(ctx, 'Guest request open (linen)', async () => {
      await rec.post(`${base}/guest-requests`, {
        stayId: s.id, category: ctx.code === 'SW' ? 'housekeeping' : 'linen',
        description: ctx.code === 'SW' ? 'Baby cot and two extra blankets for the cottage' : 'Two extra towels and a pillow',
      });
      return `stay ${s.number}`;
    });
  }

  // --- Arrivals today ----------------------------------------------------
  if (plan.g.arrivalDeposit) {
    await scenario(ctx, 'Arrival today, deposit paid, not checked in yet', async () => {
      const g = guestOf(plan, 'arrivalDeposit')!;
      const room = await readyRoom(ctx, rec, plan.top, addDays(T, 3), past);
      const res = await book(ctx, rec, {
        guest: g, arrival: T, departure: addDays(T, 3), roomTypeCode: plan.top, adults: 2, source: 'website', roomId: room.id, note: 'arriving today',
      });
      const s = res.stays[0];
      await pay(ctx, rec, s.folioId, [{ tender: 'card', amount: res.deposit.required === '0.00' ? '5000.00' : res.deposit.required, reference: cardRef() }]);
      return `${name(g)}, booking ${res.number}, room ${s.roomNumber}`;
    });
  }

  if (plan.g.arrivalDirty) {
    await scenario(ctx, 'Arrival today whose room is not ready', async () => {
      const g = guestOf(plan, 'arrivalDirty')!;
      // The room the guest who checked out this morning left. After a same-day checkout that room is still
      // booked for tonight (one night is charged), so then another room is used and housekeeping marks it dirty.
      let res: Reservation | undefined;
      const left = ctx.history ? past.checkedOut?.roomId : undefined;
      if (left) {
        res = await book(ctx, rec, {
          guest: g, arrival: T, departure: addDays(T, 1), roomTypeCode: plan.std, adults: 1, source: 'walk_in', roomId: left, note: 'arriving today, room being cleaned',
        }).catch(() => undefined);
      }
      if (!res) {
        const room = await readyRoom(ctx, rec, plan.std, addDays(T, 1), past);
        res = await book(ctx, rec, {
          guest: g, arrival: T, departure: addDays(T, 1), roomTypeCode: plan.std, adults: 1, source: 'phone', roomId: room.id, note: 'arriving today, room being cleaned',
        });
        await rec.patch(`${base}/rooms/${room.id}/hk-status`, { hkStatus: 'dirty' });
      }
      const s = res.stays[0];
      return `${name(g)}, booking ${res.number}, room ${s.roomNumber} dirty`;
    });
  }

  if (plan.g.walkIn) {
    const walk = await scenario(ctx, 'Walk-in checked in today (early check-in fee, signed card, credit limit)', async () => {
      const g = guestOf(plan, 'walkIn')!;
      const room = await readyRoom(ctx, rec, plan.dlx, addDays(T, 2), past);
      const res = await book(ctx, rec, {
        guest: g, arrival: T, departure: addDays(T, 2), roomTypeCode: plan.dlx, adults: 1, source: 'walk_in', roomId: room.id, note: 'walk-in',
      });
      const after = await checkIn(ctx, rec, res.stays[0], g, {
        earlyCheckIn: true,
        creditLimit: '30000.00',
        registration: { method: 'staff_verified', signedName: name(g) },
      });
      const s = after.stays[0];
      return done(`${name(g)}, stay ${s.number}, room ${s.roomNumber}`, { id: s.id, name: name(g), room: s.roomNumber });
    });
    if (walk) {
      forPos.walkIn = walk;
      await scenario(ctx, 'Guest request done (transport)', async () => {
        const r = await rec.post<{ id: string }>(`${base}/guest-requests`, { stayId: walk.id, category: 'transport', description: 'Taxi to JKIA tomorrow at 05:30' });
        await rec.patch(`${base}/guest-requests/${r.id}`, { status: 'done', note: 'Booked with Jim Cab, driver Kioko' });
        return `${walk.name}, room ${walk.room}`;
      });
    }
  }

  if (plan.g.lateCancel) {
    await scenario(ctx, 'Late cancellation (inside the free window, fee charged)', async () => {
      const g = guestOf(plan, 'lateCancel')!;
      const res = await book(ctx, rec, { guest: g, arrival: T, departure: addDays(T, 1), roomTypeCode: plan.std, adults: 1, note: 'cancelled on the day' });
      const after = await rec.post<Reservation>(`${base}/reservations/${res.id}/cancel`, { reason: 'Flight cancelled' });
      return `booking ${res.number}, fee ${after.stays[0].balance.chargesTotal}`;
    });
  }

  // --- Future bookings ---------------------------------------------------
  if (plan.g.future) {
    await scenario(ctx, 'Future booking with deposit and pro forma', async () => {
      const g = guestOf(plan, 'future')!;
      const res = await book(ctx, rec, {
        guest: g, arrival: addDays(T, 5), departure: addDays(T, 8), roomTypeCode: plan.dlx, adults: 2, source: 'email', note: 'future booking',
      });
      const deposit = res.deposit.required === '0.00' ? '5000.00' : res.deposit.required;
      await pay(ctx, rec, res.stays[0].folioId, [{ tender: 'mpesa', amount: deposit, reference: mpesaRef() }]);
      const pf = await rec.post<{ number: string }>(`${base}/reservations/${res.id}/proforma`);
      return `${name(g)}, booking ${res.number}, deposit ${deposit}, pro forma ${pf.number}`;
    });
  }

  if (ctx.code === 'KM' && savannah) {
    await scenario(ctx, 'Future agent booking (Savannah Tours net rate)', async () => {
      const g = demoGuest('km-future');
      const res = await book(ctx, rec, {
        guest: { ...g, key: 'km-future-agent' }, arrival: addDays(T, 10), departure: addDays(T, 14), roomTypeCode: plan.std, ratePlanCode: 'AGENTSAV',
        adults: 2, source: 'agent', agentId: savannah, agentReference: 'SAV-25003', note: 'agent booking',
      });
      return `booking ${res.number}, agent ref SAV-25003`;
    });
  }

  if (plan.g.enquiry) {
    await scenario(ctx, 'Enquiry (no room held)', async () => {
      const g = guestOf(plan, 'enquiry')!;
      const res = await book(ctx, rec, { guest: g, arrival: addDays(T, 21), departure: addDays(T, 23), roomTypeCode: plan.top, adults: 2, status: 'enquiry', note: 'price enquiry' });
      return `booking ${res.number}`;
    });
  }

  if (plan.g.hold) {
    await scenario(ctx, 'Provisional hold (expires in 2 days)', async () => {
      const g = guestOf(plan, 'hold')!;
      const res = await book(ctx, rec, {
        guest: g, arrival: addDays(T, 10), departure: addDays(T, 12), roomTypeCode: plan.std, adults: 2, status: 'hold', holdMinutes: 2 * 24 * 60, note: 'held for the guest',
      });
      return `booking ${res.number}, room ${res.stays[0].roomNumber}`;
    });
  }

  if (plan.g.override) {
    await scenario(ctx, 'Rate override approved by the manager', async () => {
      const g = guestOf(plan, 'override')!;
      const res = await book(ctx, rec, {
        guest: g, arrival: addDays(T, 9), departure: addDays(T, 11), roomTypeCode: plan.std, adults: 1,
        rateOverride: { amountPerNight: '5000.00', reason: 'Returning guest, loyalty rate' }, approval, note: 'manager-approved rate',
      });
      return `booking ${res.number}, 5,000.00 per night`;
    });
  }

  if (plan.g.groupLead && plan.g.group2) {
    await scenario(ctx, 'Group booking: two rooms on one reference', async () => {
      const lead = guestOf(plan, 'groupLead')!;
      const res = await book(ctx, rec, {
        guest: lead, arrival: addDays(T, 15), departure: addDays(T, 18), roomTypeCode: plan.std, adults: 2, source: 'email', note: 'group booking',
        extraRooms: [{ roomTypeCode: ctx.code === 'SW' ? plan.family : plan.dlx, adults: 2, children: ctx.code === 'SW' ? 1 : 0, guest: guestOf(plan, 'group2')! }],
      });
      return `booking ${res.number}, stays ${res.stays.map((s) => s.number).join(' and ')}`;
    });
  }

  if (plan.g.festive) {
    await scenario(ctx, 'Festive-season booking (seasonal price, 50% deposit)', async () => {
      const g = guestOf(plan, 'festive')!;
      const year = Number(T.slice(0, 4)) + (T.slice(5) > '12-22' ? 1 : 0);
      const res = await book(ctx, rec, {
        guest: g, arrival: `${year}-12-23`, departure: `${year}-12-26`, roomTypeCode: plan.family, adults: 2, children: 2, source: 'phone', note: 'Christmas stay',
      });
      await pay(ctx, rec, res.stays[0].folioId, [{ tender: 'bank_transfer', amount: res.deposit.required, reference: `EFT${Date.now().toString().slice(-7)}` }]);
      return `booking ${res.number}, total ${res.stays[0].total}, deposit ${res.deposit.required}`;
    });
  }

  if (plan.g.cancelled) {
    await scenario(ctx, 'Cancelled in good time (no fee)', async () => {
      const g = guestOf(plan, 'cancelled')!;
      const res = await book(ctx, rec, { guest: g, arrival: addDays(T, 30), departure: addDays(T, 32), roomTypeCode: plan.std, adults: 2, note: 'cancelled early' });
      await rec.post(`${base}/reservations/${res.id}/cancel`, { reason: 'Change of travel plans' });
      return `booking ${res.number}`;
    });
  }

  // --- Rooms ---------------------------------------------------------------
  await scenario(ctx, 'Room blocked for maintenance', async () => {
    const from = addDays(T, 3);
    const to = addDays(T, 5);
    const free = await rec.get<Array<{ id: string; number: string }>>(`${base}/availability/rooms?roomTypeCode=${plan.std}&arrival=${from}&departure=${to}`);
    const room = free[free.length - 1];
    if (!room) throw new Error('no free room to block');
    await rec.post(`${base}/rooms/${room.id}/blocks`, { from, to, reason: 'Bathroom retiling' });
    return `room ${room.number}, ${from} to ${to}`;
  });

  return forPos;
}
