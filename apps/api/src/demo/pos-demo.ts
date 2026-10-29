import { UserApi } from './api-client';
import { amount, cardRef, cents, DemoContext, done, mpesaRef, PropertyCode, scenario } from './context';
import { DEMO_NOTE } from './demo-data';
import { HotelForPos } from './hotel-demo';

/**
 * Point-of-sale demo for one property, on today's trading day: open tables at
 * each stage (basket, at the kitchen or bar, ready), paid bills with single,
 * split and evenly split tenders, split and merged bills, discounts, a wasted
 * line, charges to rooms, a house account, cash shifts and one outlet whose
 * day is closed with a Z report.
 */

interface MenuRow {
  priceId: string;
  portionId: string;
  code: string;
  portionCode: string;
  price: string;
  isAlcohol: boolean;
}
interface Menu {
  items: MenuRow[];
  modifierGroups: Array<{ code: string; options: Array<{ id: string; code: string }> }>;
  tables: Array<{ id: string; code: string }>;
  liquorAllowedNow: boolean;
}
interface Check {
  id: string;
  number: string;
  businessDate: string;
  status: string;
  totals: { total: string; balance?: string; paid?: string };
  lines: Array<{ id: string; name: string; status: string; route: string }>;
  payments?: Array<{ id: string; tender: string; amount: string }>;
}
interface Ticket {
  id: string;
  kind: string;
  status: string;
  content: { checkNumber: string };
}

/** One line to add: item code, portion code (default STD), quantity and optional modifiers or a note. */
type Order = [code: string, quantity: number, opts?: { portion?: string; mods?: Array<[group: string, option: string]>; notes?: string }];

class Outlet {
  private menu?: Menu;
  readonly path: string;

  constructor(
    private readonly ctx: DemoContext,
    readonly code: string,
  ) {
    this.path = `${ctx.base}/pos`;
  }

  async load(user: UserApi): Promise<Menu> {
    this.menu ??= await user.get<Menu>(`${this.path}/outlets/${this.code}/menu`);
    return this.menu;
  }

  async table(user: UserApi, code: string): Promise<string> {
    const t = (await this.load(user)).tables.find((x) => x.code === code);
    if (!t) throw new Error(`${this.code} has no table ${code}`);
    return t.id;
  }

  async open(user: UserApi, body: Record<string, unknown> = {}): Promise<Check> {
    return user.post<Check>(`${this.path}/outlets/${this.code}/checks`, { serviceType: 'counter', notes: DEMO_NOTE, ...body });
  }

  async openTable(user: UserApi, table: string, covers: number): Promise<Check> {
    return this.open(user, { serviceType: 'table', tableId: await this.table(user, table), covers });
  }

  /**
   * Adds lines as the tablet does. Outside licensed hours (POS-17) alcohol
   * needs a manager's override with a reason; the demo records one so it can
   * run at any time of day, and the override shows in the check history.
   */
  async add(user: UserApi, check: Check, orders: Order[], manager: string): Promise<Check> {
    const menu = await this.load(user);
    let alcohol = false;
    const lines = orders.map(([code, quantity, opts]) => {
      const row = menu.items.find((i) => i.code === code && i.portionCode === (opts?.portion ?? 'STD'));
      if (!row) throw new Error(`${code}/${opts?.portion ?? 'STD'} is not on the ${this.code} menu`);
      alcohol ||= row.isAlcohol;
      const modifierOptionIds = (opts?.mods ?? []).map(([group, option]) => {
        const id = menu.modifierGroups.find((g) => g.code === group)?.options.find((o) => o.code === option)?.id;
        if (!id) throw new Error(`modifier ${group}/${option} not offered for ${code}`);
        return id;
      });
      return { portionId: row.portionId, quantity: String(quantity), modifierOptionIds, notes: opts?.notes };
    });
    const override = alcohol && !menu.liquorAllowedNow ? { liquorOverrideReason: 'Demo data loaded outside licensed hours', approval: this.ctx.api.approval(manager) } : {};
    return user.post<Check>(`${this.path}/checks/${check.id}/lines`, { lines, acknowledgeWarnings: true, ...override });
  }

  send(user: UserApi, check: Check) {
    return user.post<Check & { tickets: Array<{ id: string; station: string }> }>(`${this.path}/checks/${check.id}/send`);
  }

  pay(user: UserApi, check: Check, tenders: Array<Record<string, unknown>>) {
    return user.post<Check & { change?: string }>(`${this.path}/checks/${check.id}/payments`, { tenders });
  }
}

const mpesa = (amt: string) => ({ tender: 'mpesa', amount: amt, reference: mpesaRef() });
const card = (amt: string) => ({ tender: 'card', amount: amt, reference: cardRef() });

/** Moves a kitchen or bar ticket on, as the cook or bartender taps Start and Ready. */
async function bump(ctx: DemoContext, user: UserApi, station: string, checkNumber: string, statuses: Array<'preparing' | 'ready'>) {
  const tickets = await user.get<Ticket[]>(`${ctx.base}/pos/stations/${station}/tickets`);
  const t = tickets.find((x) => x.content.checkNumber === checkNumber && x.kind === 'order');
  if (!t) throw new Error(`no ${station} ticket for ${checkNumber}`);
  for (const status of statuses) await user.post(`${ctx.base}/pos/tickets/${t.id}/status`, { status });
}

interface PosPlan {
  waiter: string;
  manager: string;
  kitchen: string;
  bartender: string;
  cashier: string;
  bar: string;
  barStation: string;
  restaurant: string;
  /** Outlet that is traded and then closed with a Z report. */
  zOutlet: string;
  zOrder: Order[];
}

const PLANS: Record<PropertyCode, PosPlan> = {
  K1: {
    waiter: 'k1.waiter', manager: 'k1.manager', kitchen: 'k1.kitchen', bartender: 'k1.bartender', cashier: 'k1.cashier',
    bar: 'K1-COCKTAIL', barStation: 'COCKTAIL', restaurant: 'K1-KOFFEE',
    zOutlet: 'K1-SHOP', zOrder: [['SH-TOOTHKIT', 1], ['SH-WATER', 2]],
  },
  SW: {
    waiter: 'sw.waiter', manager: 'sw.manager', kitchen: 'sw.manager', bartender: 'sw.manager', cashier: 'sw.waiter',
    bar: 'SW-MAINBAR', barStation: 'MAINBAR', restaurant: 'SW-KITCHEN',
    zOutlet: 'SW-SWIM', zOrder: [['LS-SWIM', 2, { portion: 'ADULT' }], ['LS-SWIM', 3, { portion: 'CHILD' }], ['SD-SODA', 5]],
  },
  KM: {
    waiter: 'km.waiter', manager: 'km.manager', kitchen: 'km.manager', bartender: 'km.manager', cashier: 'km.waiter',
    bar: 'KM-COCKTAIL', barStation: 'COCKTAIL', restaurant: 'KM-PITCHER',
    zOutlet: 'KM-POOL', zOrder: [['LS-SWIM', 4, { portion: 'ADULT' }], ['SD-JUICE', 4]],
  },
};

export async function posDemo(ctx: DemoContext, hotel: HotelForPos): Promise<void> {
  const plan = PLANS[ctx.code];
  const waiter = await ctx.api.as(plan.waiter);
  const manager = await ctx.api.as(plan.manager);
  const kitchen = await ctx.api.as(plan.kitchen);
  const bartender = await ctx.api.as(plan.bartender);
  const cashier = await ctx.api.as(plan.cashier);
  const approval = ctx.api.approval(plan.manager);
  const bar = new Outlet(ctx, plan.bar);
  const rest = new Outlet(ctx, plan.restaurant);
  const POS = `${ctx.base}/pos`;
  const M = plan.manager;
  const full = ctx.code === 'K1';

  // --- Open tables ---------------------------------------------------------
  await scenario(ctx, 'Open table: drinks at the bar, food being prepared', async () => {
    const c = await bar.openTable(waiter, 'T1', 4);
    await bar.add(waiter, c, [
      ['BR-TUSKER', 2],
      ['SP-JW-BLACK', 1, { portion: 'DBL', mods: [['MIXER', 'TONIC']] }],
      ['GR-GOAT', 1, { portion: 'HALFKG', mods: [['SIDE', 'UGALI']], notes: 'no salt' }],
    ], M);
    await bar.send(waiter, c);
    await bump(ctx, kitchen, 'KITCHEN', c.number, ['preparing']);
    await bump(ctx, bartender, plan.barStation, c.number, ['preparing']);
    return `${plan.bar} T1, check ${c.number}`;
  });

  await scenario(ctx, 'Open table: food ready to collect', async () => {
    const c = await rest.openTable(waiter, 'T2', 2);
    await rest.add(waiter, c, [['MN-CURRY', 1, { mods: [['SIDE', 'RICE']] }], ['MN-TILAPIA', 1, { mods: [['SIDE', 'UGALI']] }], ['SD-JUICE', 2]], M);
    await rest.send(waiter, c);
    await bump(ctx, kitchen, 'KITCHEN', c.number, ['preparing', 'ready']);
    return `${plan.restaurant} T2, check ${c.number}`;
  });

  if (full) {
    await scenario(ctx, 'Open table: order in the basket, not sent yet', async () => {
      const c = await rest.openTable(waiter, 'T3', 2);
      await rest.add(waiter, c, [['CF-AMERICANO', 2], ['BF-OMELETTE', 1]], M);
      return `${plan.restaurant} T3, check ${c.number}`;
    });
  }

  if (full) {
    await scenario(ctx, 'Open bar tab: drinks served, still running', async () => {
      const c = await bar.open(waiter, { tabName: 'Kiprop party' });
      await bar.add(waiter, c, [['BR-TUSKER', 4], ['BR-GUINNESS', 2], ['ST-WINGS', 1, { portion: 'FULL' }]], M);
      await bar.send(waiter, c);
      await bump(ctx, bartender, plan.barStation, c.number, ['preparing', 'ready']);
      await waiter.post(`${POS}/checks/${c.id}/serve`, {});
      return `${plan.bar} tab "Kiprop party", check ${c.number}`;
    });
  }

  // --- Paid bills ----------------------------------------------------------
  await scenario(ctx, 'Paid bill: M-PESA and card on one check', async () => {
    const c = await bar.openTable(waiter, 'T4', 2);
    const added = await bar.add(waiter, c, [['CK-DAWA', 2], ['ST-SAMOSA', 1]], M);
    await bar.send(waiter, c);
    const total = cents(added.totals.total);
    const m = Math.round(total / 2 / 100) * 100;
    await bar.pay(waiter, c, [mpesa(amount(m)), card(amount(total - m))]);
    return `check ${c.number}, ${added.totals.total} = ${amount(m)} M-PESA + ${amount(total - m)} card`;
  });

  if (full) {
    await scenario(ctx, 'Split bill: one beer moved to its own check, both paid', async () => {
      const c = await bar.openTable(waiter, 'T5', 3);
      const added = await bar.add(waiter, c, [['BR-GUINNESS', 3], ['ST-CHIPS', 1]], M);
      await bar.send(waiter, c);
      const guinness = added.lines.find((l) => l.name.startsWith('Guinness'))!;
      const split = await waiter.post<{ from: Check; to: Check }>(`${POS}/checks/${c.id}/split`, { parts: [{ lineId: guinness.id, quantity: '1' }] });
      await bar.pay(waiter, split.from, [card(split.from.totals.total)]);
      await bar.pay(waiter, split.to, [mpesa(split.to.totals.total)]);
      return `check ${split.from.number} (${split.from.totals.total}) and ${split.to.number} (${split.to.totals.total})`;
    });

    await scenario(ctx, 'Merged bills: two tables joined and paid together', async () => {
      const a = await bar.openTable(waiter, 'T6', 2);
      await bar.add(waiter, a, [['BR-WHITECAP', 2]], M);
      const b = await bar.openTable(waiter, 'T7', 2);
      await bar.add(waiter, b, [['BR-CIDER', 2], ['ST-WINGS', 1, { portion: 'FULL' }]], M);
      const merged = await waiter.post<Check>(`${POS}/checks/${a.id}/merge`, { fromCheckIds: [b.id] });
      await bar.pay(waiter, merged, [card(merged.totals.total)]);
      return `check ${b.number} merged into ${a.number}, ${merged.totals.total} paid by card`;
    });

    await scenario(ctx, 'Split evenly: three guests pay a third each', async () => {
      const c = await bar.openTable(waiter, 'T8', 3);
      const added = await bar.add(waiter, c, [['BR-TUSKER', 3], ['ST-SAMOSA', 2], ['SD-WATER', 3]], M);
      const total = cents(added.totals.total);
      const share = Math.floor(total / 3);
      await bar.pay(waiter, c, [mpesa(amount(share))]);
      await bar.pay(waiter, c, [card(amount(share))]);
      await bar.pay(waiter, c, [mpesa(amount(total - 2 * share))]);
      return `check ${c.number}, ${added.totals.total} in three payments`;
    });

    await scenario(ctx, 'Discount approved by the manager', async () => {
      const c = await rest.openTable(waiter, 'T4', 2);
      await rest.add(waiter, c, [['MN-CURRY', 2, { mods: [['SIDE', 'CHIPS']] }], ['CF-LATTE', 2]], M);
      const d = await waiter.post<Check>(`${POS}/checks/${c.id}/discount`, { percent: '10', reason: 'Regular guest', approval });
      await rest.pay(waiter, d, [mpesa(d.totals.total)]);
      return `check ${c.number}, 10% off, paid ${d.totals.total}`;
    });

    await scenario(ctx, 'Item cancelled after the kitchen started it (wasted)', async () => {
      const c = await rest.openTable(waiter, 'T5', 1);
      await rest.add(waiter, c, [['MN-BURGER', 1, { mods: [['DONENESS', 'MEDIUM']] }], ['SD-SODA', 1]], M);
      await rest.send(waiter, c);
      await bump(ctx, kitchen, 'KITCHEN', c.number, ['preparing']);
      const view = await waiter.get<Check>(`${POS}/checks/${c.id}`);
      const burger = view.lines.find((l) => l.name.startsWith('Klub beef burger'))!;
      const after = await waiter.post<Check>(`${POS}/checks/${c.id}/cancel-lines`, { lineIds: [burger.id], reason: 'Guest had to leave', approval });
      await rest.pay(waiter, after, [card(after.totals.total)]);
      return `check ${c.number}: burger wasted, soda paid ${after.totals.total}`;
    });

    await scenario(ctx, 'Check voided by the manager', async () => {
      const c = await bar.open(waiter, { tabName: 'Wanjala' });
      await bar.add(waiter, c, [['SD-SODA', 1]], M);
      await waiter.post(`${POS}/checks/${c.id}/void`, { reason: 'Opened on the wrong outlet', approval });
      return `check ${c.number}`;
    });

    await scenario(ctx, 'House account: staff meals (manager approved)', async () => {
      const c = await rest.open(waiter);
      await rest.add(waiter, c, [['MN-CURRY', 3, { mods: [['SIDE', 'UGALI']] }], ['CF-CHAI', 3]], M);
      await waiter.post(`${POS}/checks/${c.id}/house-account`, { houseAccountCode: 'STAFF-MEALS', reason: 'Night shift meals', approval });
      return `check ${c.number}, not counted as revenue`;
    });
  }

  // --- Charge to room ------------------------------------------------------
  if (hotel.inHouse) {
    const g = hotel.inHouse;
    await scenario(ctx, 'Part paid by M-PESA, the rest charged to the room', async () => {
      const c = await rest.openTable(waiter, 'T6', 2);
      const added = await rest.add(waiter, c, [['MN-CURRY', 1, { mods: [['SIDE', 'RICE']] }], ['MN-BURGER', 1, { mods: [['DONENESS', 'MEDIUM']] }], ['CF-LATTE', 1]], M);
      await rest.send(waiter, c);
      await rest.pay(waiter, c, [mpesa('1000.00')]);
      const charged = await waiter.post<Check & { roomCharge: { amount: string } }>(`${POS}/checks/${c.id}/room-charge`, {
        stayId: g.id, acknowledgement: { method: 'staff_verified', signedName: g.name },
      });
      return `check ${c.number}: ${added.totals.total} = 1,000.00 M-PESA + ${charged.roomCharge.amount} to room ${g.room} (${g.name})`;
    });
  }
  const roomGuest = hotel.walkIn ?? (ctx.code === 'SW' ? hotel.inHouse : undefined);
  if (roomGuest) {
    await scenario(ctx, ctx.code === 'SW' ? 'Spa treatment charged to the room' : 'Bar tab charged to the room', async () => {
      const spa = ctx.code === 'SW';
      const outlet = spa ? new Outlet(ctx, 'SW-MASSAGE') : bar;
      const c = await outlet.open(waiter);
      await outlet.add(waiter, c, spa ? [['SPA-MASSAGE', 1]] : [['SP-TANQUERAY', 2, { portion: 'TOT', mods: [['MIXER', 'TONIC']] }], ['ST-CHIPS', 1]], M);
      const charged = await waiter.post<Check & { roomCharge: { amount: string } }>(`${POS}/checks/${c.id}/room-charge`, {
        stayId: roomGuest.id, acknowledgement: { method: 'guest_signature', signedName: roomGuest.name, signature: SIGNATURE },
      });
      return `check ${c.number}: ${charged.roomCharge.amount} to room ${roomGuest.room} (${roomGuest.name}), signed`;
    });
  }

  // --- Cash shifts ---------------------------------------------------------
  if (full) {
    await scenario(ctx, 'Cash shift closed 200 short, reviewed by the manager', async () => {
      const shift = await cashier.post<{ id: string; number: string }>(`${POS}/shifts`, { outletCode: plan.bar, openingFloat: '5000.00' });
      const c = await bar.open(cashier);
      await bar.add(cashier, c, [['BR-TUSKER', 2], ['SD-SODA', 2]], M); // 700 + 300
      const paid = await bar.pay(cashier, c, [{ tender: 'cash', amount: '1000.00', tendered: '2000.00' }]);
      const cash = paid.payments!.find((p) => p.tender === 'cash')!;
      await cashier.post(`${POS}/checks/${c.id}/refunds`, { paymentId: cash.id, amount: '350.00', reason: 'Wrong drink served', approval });
      await cashier.post(`${POS}/shifts/current/movements`, { kind: 'paid_out', amount: '300.00', reason: 'Ice from the market', approval });
      // Expected in the drawer: 5,000 float + 1,000 cash − 350 refund − 300 paid out = 5,350. The cashier counts 5,150.
      const closed = await cashier.post<{ expectedAmount: string; variance: string }>(`${POS}/shifts/${shift.id}/close`, { countedAmount: '5150.00' });
      await manager.post(`${POS}/shifts/${shift.id}/review`, { note: 'Short 200: cashier to explain at handover' });
      return `shift ${shift.number}: expected ${closed.expectedAmount}, variance ${closed.variance}; check ${c.number} with a 350.00 refund`;
    });
  }

  await scenario(ctx, full ? 'Cash shift still open' : 'Cash shift open with a cash sale', async () => {
    const user = full ? waiter : cashier;
    // One open shift per person per property: a re-run keeps selling on the shift left open last time.
    const current = await user.get<{ id: string; number: string; outletCode: string } | ''>(`${POS}/shifts/current`);
    const outletCode = current ? current.outletCode : full ? 'K1-COWGIRL' : plan.bar;
    const shift = current || (await user.post<{ id: string; number: string }>(`${POS}/shifts`, { outletCode, openingFloat: '3000.00' }));
    const outlet = new Outlet(ctx, outletCode);
    const c = await outlet.open(user);
    const added = await outlet.add(user, c, [['BR-CIDER', 2], ['SD-SODA', 1]], M);
    const total = cents(added.totals.total);
    const tendered = Math.ceil(total / 50000) * 50000;
    await outlet.pay(user, c, [{ tender: 'cash', amount: added.totals.total, tendered: amount(tendered) }]);
    return `shift ${shift.number} at ${outletCode} (${plan.waiter}), check ${c.number} paid cash`;
  });

  // --- Closed trading day ----------------------------------------------------
  await scenario(ctx, 'Outlet day closed with a Z report', async () => {
    const status = (await manager.get<Array<{ code: string; lastClosed: string | null }>>(`${POS}/outlets`)).find((o) => o.code === plan.zOutlet);
    if (status?.lastClosed && status.lastClosed >= ctx.today) return `${plan.zOutlet} already closed for ${status.lastClosed}`;
    const outlet = new Outlet(ctx, plan.zOutlet);
    const c = await outlet.open(waiter);
    const added = await outlet.add(waiter, c, plan.zOrder, M);
    await outlet.pay(waiter, c, [ctx.code === 'K1' ? card(added.totals.total) : mpesa(added.totals.total)]);
    const z = await manager.post<{ dayId: string }>(`${POS}/outlets/${plan.zOutlet}/close-day`, { businessDate: c.businessDate });
    return done(`${plan.zOutlet} closed for ${c.businessDate}; it trades again after the property closes its day`, z.dayId);
  });
}

/** A tiny signature image, as the tablet's signature pad would send. */
const SIGNATURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
