/**
 * Waiter and bar POS for tablets (POS-01 … POS-13, POS-17, POS-18, OPS-05).
 * Tables and tabs, the outlet menu with portions and modifiers, a basket that
 * is sent to the kitchen and bar, bills, payments, charge to room with the
 * guest's signature, and the cashier shift. Orders can be taken offline; they
 * are queued with device ids and sent when the connection returns. Payments
 * and room charges always need the server's answer.
 */
import { api, ApiError, newKey, OfflineError } from './api';
import { OfflineQueue } from './queue';
import { addMoney, confirmBox, esc, kes, modal, printHtml, showError, toast, withSignOff } from './ui';

interface MenuRow {
  priceId: string;
  itemId: string;
  code: string;
  name: string;
  categoryCode: string;
  isAlcohol: boolean;
  portionId: string;
  portionCode: string;
  portionName: string;
  price: string;
  isAvailable: boolean;
  isFavourite: boolean;
  stockRemaining: string | null;
  modifierGroups: string[];
}
interface ModifierGroup {
  code: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: Array<{ id: string; code: string; name: string; priceDelta: string }>;
}
interface Menu {
  outlet: { code: string; name: string; serviceTypes: string[]; cutoff: string };
  localTime: string;
  liquorAllowedNow: boolean;
  categories: Array<{ code: string; name: string }>;
  items: MenuRow[];
  modifierGroups: ModifierGroup[];
  tables: Array<{ id: string; code: string; area: string; seats: number }>;
}
interface CheckSummary {
  id: string;
  number: string;
  serviceType: string;
  tableCode: string | null;
  tabName: string | null;
  waiter: string;
  roomNumber: string | null;
  total: string;
  balance: string;
  unsentLines: number;
  readyLines: number;
  offline?: boolean;
}
interface Line {
  id: string;
  name: string;
  quantity: string;
  amount: string;
  status: string;
  modifiers: Array<{ name: string }>;
  notes: string | null;
  discountPercent?: string;
  isComp?: boolean;
  queued?: boolean;
}
interface Check {
  id: string;
  number: string;
  status: string;
  serviceType: string;
  tableId: string | null;
  tableCode: string | null;
  tabName: string | null;
  covers: number;
  waiter: string;
  stayId: string | null;
  roomNumber: string | null;
  guestName: string | null;
  businessDate: string;
  totals: { total: string; paid: string; pending: string; roomCharged: string; balance: string };
  lines: Line[];
  payments: Array<{ id: string; tender: string; amount: string; status: string; reference: string | null }>;
  offline?: boolean;
}
interface BasketLine {
  id: string;
  row: MenuRow;
  quantity: number;
  modifierOptionIds: string[];
  modifierNames: string[];
  modifierDelta: string;
  notes: string;
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Not sent', sent: 'Sent', preparing: 'Preparing', ready: 'Ready', served: 'Served', cancelled: 'Cancelled', wasted: 'Waste',
};
const LOCAL_CHECKS = 'yeastay.pwa.localChecks';

export class WaiterApp {
  private menu: Menu | null = null;
  private checks: CheckSummary[] = [];
  private check: Check | null = null;
  private basket: BasketLine[] = [];
  private category = 'FAV';
  private search = '';
  private selected = new Set<string>();
  private readonly queue = new OfflineQueue();
  private online = true;

  constructor(
    private readonly root: HTMLElement,
    private readonly property: string,
    private readonly outletCode: string,
    private readonly onExit: () => void,
  ) {}

  private get pos() {
    return `/properties/${this.property}/pos`;
  }

  setOnline(online: boolean): void {
    const was = this.online;
    this.online = online;
    if (online && !was) void this.flush();
    if (this.check) this.renderCheck();
  }

  async start(): Promise<void> {
    await this.loadMenu();
    await this.flush();
    await this.showFloor();
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  private menuKey() {
    return `yeastay.pwa.menu.${this.property}.${this.outletCode}`;
  }

  private async loadMenu(): Promise<void> {
    try {
      this.menu = await api.get<Menu>(`${this.pos}/outlets/${this.outletCode}/menu`);
      localStorage.setItem(this.menuKey(), JSON.stringify(this.menu));
    } catch (err) {
      const cached = localStorage.getItem(this.menuKey());
      if (err instanceof OfflineError && cached) {
        this.menu = JSON.parse(cached) as Menu;
        toast('Offline: using the menu saved on this device', 'info');
      } else throw err;
    }
  }

  private localChecks(): Record<string, Check> {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_CHECKS) ?? '{}') as Record<string, Check>;
    } catch {
      return {};
    }
  }

  private saveLocal(check: Check | null, id?: string): void {
    const all = this.localChecks();
    if (check) all[check.id] = check;
    else if (id) delete all[id];
    localStorage.setItem(LOCAL_CHECKS, JSON.stringify(all));
  }

  async flush(): Promise<void> {
    if (!this.queue.list().length) return;
    const res = await this.queue.flush((a) =>
      api.request('POST', a.path, a.body, a.key).catch((err) => {
        // Already sent by another device or a held order: nothing left to do.
        if (err instanceof ApiError && err.code === 'nothing_to_send') return null;
        throw err;
      }),
    );
    if (res.sent) toast(`${res.sent} offline action(s) sent`, 'ok');
    if (res.failed) toast(`${res.failed} offline action(s) were refused; open the check to see why`, 'error');
    for (const id of Object.keys(this.localChecks())) {
      if (!this.queue.pendingFor(id).length) this.saveLocal(null, id);
    }
  }

  // ---------------------------------------------------------------------------
  // Floor: tables, tabs and counter sales (POS-04, POS-05)
  // ---------------------------------------------------------------------------
  async showFloor(view: 'tables' | 'orders' = 'tables'): Promise<void> {
    this.check = null;
    this.basket = [];
    this.search = '';
    try {
      this.checks = await api.get<CheckSummary[]>(`${this.pos}/outlets/${this.outletCode}/checks`);
    } catch (err) {
      if (!(err instanceof OfflineError)) showError(err);
    }
    const local = Object.values(this.localChecks())
      .filter((c) => !this.checks.some((s) => s.id === c.id))
      .map((c) => ({ ...c, total: c.totals.total, balance: c.totals.balance, unsentLines: 0, readyLines: 0, offline: true }) as CheckSummary);
    const all = [...this.checks, ...local];
    const m = this.menu!;
    const byTable = new Map<string, CheckSummary[]>();
    for (const c of all) if (c.tableCode) byTable.set(c.tableCode, [...(byTable.get(c.tableCode) ?? []), c]);
    const others = all.filter((c) => !c.tableCode);
    const pending = this.queue.list();
    const label = (c: CheckSummary) => (c.tableCode ? `Table ${c.tableCode}` : c.tabName ?? (c.roomNumber ? `Room ${c.roomNumber}` : c.serviceType.replace('_', ' ')));
    const card = (c: CheckSummary) => `<li><button class="check-card ${c.readyLines ? 'ready' : ''}" data-open="${esc(c.id)}">
        <strong>${esc(label(c))}</strong><em>KSh ${kes(c.balance)}</em>
        <span>${esc(c.number)} · ${esc(c.waiter)}${c.offline ? ' · not sent yet' : ''}${c.unsentLines ? ` · ${c.unsentLines} not sent` : ''}${c.readyLines ? ` · <b>${c.readyLines} ready</b>` : ''}</span>
      </button></li>`;

    this.screen(
      view === 'tables' ? 'tables' : 'orders',
      `<div class="screen-head">
        <div><h1>${esc(m.outlet.name)}</h1>
          <p class="sub">Trading day starts ${esc(m.outlet.cutoff)}${m.liquorAllowedNow ? '' : ' · <strong class="warn">No alcohol sales now</strong>'}</p></div>
        <span class="spacer"></span>
        <button class="ghost" data-act="refresh">↻ Refresh</button>
      </div>
      ${pending.length ? `<div class="banner">${pending.length} action(s) waiting to be sent${pending.some((p) => p.error) ? ' · some were refused' : ''}</div>` : ''}
      <div class="new-checks">
        ${m.outlet.serviceTypes.includes('counter') ? '<button class="tile-btn t-go" data-new="counter">＋ Counter sale</button>' : ''}
        ${m.outlet.serviceTypes.includes('table') ? '<button class="tile-btn t-tab" data-new="tab">＋ Bar tab</button>' : ''}
        ${m.outlet.serviceTypes.includes('takeaway') ? '<button class="tile-btn t-take" data-new="takeaway">＋ Takeaway</button>' : ''}
        ${m.outlet.serviceTypes.includes('room_service') ? '<button class="tile-btn t-room" data-new="room_service">＋ Room service</button>' : ''}
      </div>
      ${view === 'tables'
        ? `<h2>Tables</h2>
          <div class="tables">
            ${m.tables
              .map((t) => {
                const open = byTable.get(t.code) ?? [];
                return `<button class="table ${open.length ? 'busy' : ''} ${open.some((c) => c.readyLines) ? 'ready' : ''}" data-table="${esc(t.id)}" data-code="${esc(t.code)}">
                  <strong>${esc(t.code)}</strong>
                  <span>${open.length ? open.map((c) => `KSh ${kes(c.balance)}${c.offline ? ' ⏳' : ''}`).join('<br>') : `${t.seats} seats · free`}</span>
                  ${open.some((c) => c.readyLines) ? '<i>Ready</i>' : ''}
                </button>`;
              })
              .join('') || '<p class="muted">No tables at this outlet.</p>'}
          </div>
          <h2>Tabs, counter and room service</h2>
          <ul class="check-list">${others.map(card).join('') || '<li class="muted">No open tabs.</li>'}</ul>`
        : `<h2>Open orders (${all.length})</h2>
          <ul class="check-list">${all.map(card).join('') || '<li class="muted">No open orders.</li>'}</ul>`}`,
    );

    this.root.querySelector('[data-act=refresh]')!.addEventListener('click', () => void this.flush().then(() => this.loadMenu()).then(() => this.showFloor(view)).catch(showError));
    this.root.querySelectorAll<HTMLButtonElement>('[data-table]').forEach((b) =>
      b.addEventListener('click', () => {
        const open = byTable.get(b.dataset.code!) ?? [];
        if (open.length === 1) void this.openExisting(open[0].id);
        else if (open.length > 1) void this.pickCheck(open);
        else void this.newCheck('table', b.dataset.table!);
      }),
    );
    this.root.querySelectorAll<HTMLButtonElement>('[data-new]').forEach((b) => b.addEventListener('click', () => void this.newCheck(b.dataset.new!)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => b.addEventListener('click', () => void this.openExisting(b.dataset.open!)));
  }

  /** Lays out a screen with the bottom navigation (tables, orders, menu, shift, outlets). */
  private screen(active: 'tables' | 'orders' | 'menu', body: string): void {
    const tab = (key: string, icon: string, text: string, disabled = false) =>
      `<button data-nav="${key}" class="${active === key ? 'on' : ''}" ${disabled ? 'disabled' : ''}><span aria-hidden="true">${icon}</span>${text}</button>`;
    this.root.innerHTML = `<div class="screen">${body}</div>
      <nav class="bottom-nav" aria-label="POS">
        ${tab('tables', '▦', 'Tables')}
        ${tab('orders', '☰', 'Orders')}
        ${tab('menu', '◫', 'Menu', !this.check)}
        ${tab('shift', '¤', 'Cash shift')}
        <span class="spacer"></span>
        ${tab('exit', '⇄', 'Outlets')}
      </nav>`;
    this.root.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((b) =>
      b.addEventListener('click', () => {
        const key = b.dataset.nav!;
        if (key === active) return;
        if (key === 'shift') return void this.shiftDialog().catch(showError);
        if (key === 'exit') return void this.leave(() => this.onExit());
        if (key === 'tables' || key === 'orders') return void this.leave(() => this.showFloor(key));
      }),
    );
  }

  /** Leaving a check with unsent items asks first. */
  private async leave(go: () => unknown): Promise<void> {
    if (this.check && this.basket.length && !(await confirmBox('Leave without sending?', 'The new items have not been sent and will be lost.', 'Leave', true))) return;
    await go();
  }

  private async pickCheck(list: CheckSummary[]) {
    const res = await modal(
      'Which check?',
      list.map((c, i) => `<label class="radio"><input type="radio" name="id" value="${esc(c.id)}" ${i ? '' : 'checked'}> ${esc(c.number)} · ${esc(c.waiter)} · ${kes(c.balance)}</label>`).join('') +
        '<label class="radio"><input type="radio" name="id" value="new"> New check at this table</label>',
      { submit: 'Open' },
    );
    if (!res) return;
    if (res.id === 'new') {
      const table = this.menu!.tables.find((t) => t.code === list[0].tableCode);
      await this.newCheck('table', table?.id);
    } else await this.openExisting(res.id);
  }

  private async newCheck(serviceType: string, tableId?: string) {
    let body: Record<string, unknown> = { serviceType, tableId: tableId ?? null };
    if (serviceType === 'tab' || serviceType === 'takeaway') {
      const res = await modal('Name the tab', '<label>Name<input name="tabName" required maxlength="60" placeholder="e.g. Brian, red shirt"></label>', { submit: 'Open tab' });
      if (!res) return;
      body = { serviceType: serviceType === 'tab' ? 'counter' : 'takeaway', tabName: res.tabName };
    } else if (serviceType === 'room_service') {
      const stay = await this.findStay('Room service for which guest?');
      if (!stay) return;
      body = { serviceType, stayId: stay.stayId, tabName: `Room ${stay.roomNumber}` };
    } else if (serviceType === 'table') {
      const res = await modal('Guests at the table', '<label>Covers<input name="covers" type="number" min="1" max="40" value="2" required></label>', { submit: 'Open table' });
      if (!res) return;
      body.covers = Number(res.covers);
    }
    const id = crypto.randomUUID();
    const payload: Record<string, unknown> = { ...body, id, deviceId: deviceId(), clientOpenedAt: new Date().toISOString() };
    const key = newKey('open');
    try {
      this.check = await api.post<Check>(`${this.pos}/outlets/${this.outletCode}/checks`, payload, key);
    } catch (err) {
      if (!(err instanceof OfflineError)) return showError(err);
      // Offline: keep the check on the device and send it later (OPS-05).
      this.queue.add({ method: 'POST', path: `${this.pos}/outlets/${this.outletCode}/checks`, body: payload, key, label: 'Open check', checkId: id });
      const table = this.menu!.tables.find((t) => t.id === tableId);
      this.check = {
        id, number: 'Offline', status: 'open', serviceType: String(payload.serviceType), tableId: tableId ?? null, tableCode: table?.code ?? null,
        tabName: (payload.tabName as string) ?? null, covers: Number(payload.covers ?? 1), waiter: api.session?.user.displayName ?? '', stayId: null,
        roomNumber: null, guestName: null, businessDate: '', totals: { total: '0.00', paid: '0.00', pending: '0.00', roomCharged: '0.00', balance: '0.00' },
        lines: [], payments: [], offline: true,
      };
      this.saveLocal(this.check);
      toast('Offline: the check is saved on this tablet and will be sent when the connection returns', 'info');
    }
    this.category = 'FAV';
    this.selected.clear();
    this.renderCheck();
  }

  private async openExisting(id: string) {
    const local = this.localChecks()[id];
    try {
      if (local && this.queue.pendingFor(id).length) throw new OfflineError('pending');
      this.check = await api.get<Check>(`${this.pos}/checks/${id}`);
    } catch (err) {
      if (!(err instanceof OfflineError) || !local) return showError(err);
      this.check = local;
    }
    this.basket = [];
    this.selected.clear();
    this.category = 'FAV';
    this.renderCheck();
  }

  private async reload() {
    if (!this.check) return;
    if (this.check.offline) return this.renderCheck();
    this.check = await api.get<Check>(`${this.pos}/checks/${this.check.id}`);
    this.renderCheck();
  }

  // ---------------------------------------------------------------------------
  // Check screen: menu, basket and actions (POS-01 … POS-03, POS-06 … POS-11)
  // ---------------------------------------------------------------------------
  private renderCheck(): void {
    const c = this.check!;
    const m = this.menu!;
    const queued = this.queue.pendingFor(c.id);
    const basketTotal = addMoney(...this.basket.map((b) => (Number(addMoney(b.row.price, b.modifierDelta)) * b.quantity).toFixed(2)), '0');
    const live = c.lines.filter((l) => l.status !== 'cancelled' && l.status !== 'wasted');
    const offline = !this.online || c.offline;
    const open = c.status === 'open';
    const where = c.tableCode ? `Table ${c.tableCode}` : c.tabName ?? c.serviceType.replace('_', ' ');
    const kind = { table: 'Dine-in', counter: 'Counter', takeaway: 'Takeaway', room_service: 'Room service' }[c.serviceType] ?? c.serviceType;
    const due = addMoney(c.totals.balance, basketTotal);
    const noPay = offline || this.basket.length > 0 || !Number(c.totals.balance);
    const cats = [{ code: 'ALL', name: 'All' }, { code: 'FAV', name: '★ Favourites' }, ...m.categories];

    this.screen(
      'menu',
      `<div class="pos">
        <section class="menu">
          <div class="screen-head">
            <div><h1>${esc(where)} <small>${esc(kind)}</small></h1>
              <p class="sub">${esc(m.outlet.name)} · ${esc(c.waiter)}${c.covers > 1 ? ` · ${c.covers} guests` : ''}${c.roomNumber ? ` · Room ${esc(c.roomNumber)} ${esc(c.guestName ?? '')}` : ''}</p></div>
            ${open ? '' : `<span class="chip">${esc(c.status)}</span>`}
          </div>
          <label class="search"><span aria-hidden="true">⌕</span><input type="search" data-search placeholder="Search item or code…" value="${esc(this.search)}" ${open ? '' : 'disabled'}></label>
          <nav class="cats">
            ${cats.map((k) => `<button class="${this.category === k.code ? 'on' : ''} ${tileClass(k.code)}" data-cat="${esc(k.code)}">${esc(k.name)}</button>`).join('')}
          </nav>
          <div class="items" data-items>${this.itemsHtml()}</div>
        </section>
        <section class="order">
          <header><h2>Current order</h2><span>${esc(where)} / ${esc(c.number)}</span></header>
          ${queued.length ? `<div class="banner">${queued.map((q) => `${esc(q.label)}${q.error ? `: <strong>refused: ${esc(q.error)}</strong> <button class="link" data-dismiss="${esc(q.id)}">dismiss</button>` : ' (waiting)'}`).join(' · ')}</div>` : ''}
          <ul class="lines">
            ${live
              .map(
                (l) => `<li class="sent ${this.selected.has(l.id) ? 'sel' : ''}" data-line="${esc(l.id)}">
                  <span class="qty">${Number(l.quantity)}</span>
                  <span class="n"><b>${esc(l.name)}</b>${l.modifiers?.length ? `<small>${l.modifiers.map((x) => esc(x.name)).join(', ')}</small>` : ''}${l.notes ? `<small>“${esc(l.notes)}”</small>` : ''}
                    ${Number(l.discountPercent ?? 0) ? `<small>${l.isComp ? 'Complimentary' : `${Number(l.discountPercent)}% off`}</small>` : ''}
                    <span class="s s-${esc(l.status)}">${l.queued ? 'Queued' : STATUS_LABEL[l.status] ?? esc(l.status)}</span></span>
                  <span class="a">KSh ${kes(l.amount)}</span>
                </li>`,
              )
              .join('')}
            ${this.basket
              .map((b) => {
                const unit = addMoney(b.row.price, b.modifierDelta);
                return `<li class="basket">
                  <span class="stepper"><button data-dec="${b.id}" aria-label="One less">−</button><output>${b.quantity}</output><button data-inc="${b.id}" aria-label="One more">+</button></span>
                  <span class="n"><b>${esc(b.row.portionName ? `${b.row.name} (${b.row.portionName})` : b.row.name)}</b><small>KSh ${kes(unit)} each</small>${b.modifierNames.length ? `<small>${b.modifierNames.map(esc).join(', ')}</small>` : ''}${b.notes ? `<small>“${esc(b.notes)}”</small>` : ''}</span>
                  <span class="a">KSh ${kes((Number(unit) * b.quantity).toFixed(2))}</span>
                </li>`;
              })
              .join('')}
            ${!live.length && !this.basket.length ? '<li class="empty">Tap items on the left to start the order.</li>' : ''}
          </ul>
          <div class="totals">
            ${this.basket.length ? `<div><span>Not sent yet</span><span>KSh ${kes(basketTotal)}</span></div>` : ''}
            ${Number(c.totals.paid) || Number(c.totals.roomCharged) ? `<div><span>Paid / charged</span><span>KSh ${kes(addMoney(c.totals.paid, c.totals.roomCharged))}</span></div>` : ''}
            ${Number(c.totals.pending) ? `<div><span>Pending payment</span><span>KSh ${kes(c.totals.pending)}</span></div>` : ''}
            <div class="due"><span>${Number(c.totals.paid) || Number(c.totals.roomCharged) ? 'Balance' : 'Total'}</span><strong>KSh ${kes(due)}</strong></div>
          </div>
          ${open
            ? `<div class="actions">
              <button class="a-hold" data-act="hold" ${!this.basket.length ? 'disabled' : ''}>❚❚ Hold</button>
              <button class="a-send" data-act="send" ${!this.basket.length && !live.some((l) => l.status === 'draft') ? 'disabled' : ''}>➤ Send order${this.basket.length ? ` (${this.basket.reduce((a, b) => a + b.quantity, 0)})` : ''}</button>
              <button class="a-bill" data-act="bill" ${offline ? 'disabled' : ''}>⎙ Print bill</button>
              <button class="a-plain" data-act="serve" ${offline ? 'disabled' : ''}>✓ Served</button>
              <button class="a-pay" data-act="pay" ${noPay ? 'disabled' : ''} title="${this.basket.length ? 'Send the new items first' : ''}">PAY KSh ${kes(due)}</button>
              <div class="tenders">
                <button data-tender="cash" ${noPay ? 'disabled' : ''}>Cash</button>
                <button data-tender="mpesa" ${noPay ? 'disabled' : ''}>M-Pesa</button>
                <button data-tender="card" ${noPay ? 'disabled' : ''}>Card</button>
                <button data-act="room" ${noPay ? 'disabled' : ''}>Room</button>
              </div>
              <details class="more">
                <summary>Split, merge and more</summary>
                <div class="more-grid">
                  <button data-act="split" ${offline ? 'disabled' : ''}>Split bill</button>
                  <button data-act="evenly" ${noPay ? 'disabled' : ''}>Split evenly</button>
                  <button data-act="merge" ${offline ? 'disabled' : ''}>Merge bills</button>
                  <button data-act="move" ${offline ? 'disabled' : ''}>Move table</button>
                  <button data-act="discount" ${offline ? 'disabled' : ''}>Discount</button>
                  <button data-act="cancel" ${offline ? 'disabled' : ''}>Cancel items</button>
                  <button data-act="house" ${noPay ? 'disabled' : ''}>House account</button>
                  <button class="danger" data-act="void" ${offline ? 'disabled' : ''}>Void bill</button>
                </div>
              </details>
              ${offline ? '<p class="note">Offline: keep taking orders. Payments and room charges wait for the connection.</p>' : '<p class="note">Tap sent items to pick them for split, discount or cancel.</p>'}
            </div>`
            : `<div class="actions"><button class="a-bill" data-act="bill">⎙ Print receipt</button><button class="a-pay" data-act="back">Done</button></div>`}
        </section>
      </div>`,
    );

    const on = (sel: string, fn: (el: HTMLElement) => void) => this.root.querySelectorAll<HTMLElement>(sel).forEach((el) => el.addEventListener('click', () => fn(el)));
    on('[data-act=back]', () => void this.showFloor());
    on('[data-cat]', (el) => {
      this.category = el.dataset.cat!;
      this.search = '';
      this.renderCheck();
    });
    const search = this.root.querySelector<HTMLInputElement>('[data-search]')!;
    search.addEventListener('input', () => {
      this.search = search.value;
      this.root.querySelector('[data-items]')!.innerHTML = this.itemsHtml();
    });
    // Delegated, so tiles redrawn by the search keep working.
    this.root.querySelector('[data-items]')!.addEventListener('click', (e) => {
      const tile = (e.target as HTMLElement).closest<HTMLElement>('[data-item]');
      if (tile && !tile.hasAttribute('disabled')) void this.pickItem(tile.dataset.item!);
    });
    on('[data-line]', (el) => {
      const id = el.dataset.line!;
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      el.classList.toggle('sel');
    });
    on('[data-inc]', (el) => this.bump(el.dataset.inc!, 1));
    on('[data-dec]', (el) => this.bump(el.dataset.dec!, -1));
    on('[data-dismiss]', (el) => {
      this.queue.dismiss(el.dataset.dismiss!);
      this.renderCheck();
    });
    on('[data-tender]', (el) => void this.pay(el.dataset.tender).catch(showError));
    const act = (name: string, fn: () => Promise<unknown>) => on(`[data-act=${name}]`, () => void fn().catch(showError));
    act('send', () => this.submitBasket(true));
    act('hold', () => this.submitBasket(false));
    act('serve', () => this.serve());
    act('bill', async () => printHtml(await api.html(`${this.pos}/checks/${c.id}/print`)));
    act('pay', () => this.pay());
    act('evenly', () => this.splitEvenly());
    act('room', () => this.roomCharge());
    act('discount', () => this.discount());
    act('cancel', () => this.cancelLines());
    act('split', () => this.split());
    act('move', () => this.move());
    act('merge', () => this.merge());
    act('house', () => this.houseAccount());
    act('void', () => this.voidCheck());
  }

  /** Menu tiles for the chosen category, or every item matching the search. */
  private itemsHtml(): string {
    const m = this.menu!;
    const c = this.check!;
    const term = this.search.trim().toLowerCase();
    const visible = groupItems(m.items).filter((g) =>
      term
        ? g.rows.some((r) => r.name.toLowerCase().includes(term) || r.code.toLowerCase().includes(term))
        : this.category === 'ALL' || (this.category === 'FAV' ? g.rows.some((r) => r.isFavourite) : g.rows[0].categoryCode === this.category),
    );
    return (
      visible
        .map((g) => {
          const r = g.rows[0];
          const off = g.rows.every((x) => !x.isAvailable);
          const blockedAlcohol = r.isAlcohol && !m.liquorAllowedNow;
          const left = g.rows.find((x) => x.stockRemaining !== null)?.stockRemaining;
          return `<button class="tile ${tileClass(r.categoryCode)} ${off ? 'off' : ''}" data-item="${esc(r.itemId)}" ${c.status !== 'open' ? 'disabled' : ''}>
            <strong>${esc(r.name)}</strong>
            <span>${g.rows.length > 1 ? 'from ' : ''}KSh ${kes(minPrice(g.rows)).replace(/\.00$/, '')}</span>
            ${off ? '<em>Not available</em>' : blockedAlcohol ? '<em>Outside licence hours</em>' : left != null ? `<em>${Number(left)} left</em>` : ''}
          </button>`;
        })
        .join('') || `<p class="muted">${term ? 'No item matches that search.' : 'Nothing here.'}</p>`
    );
  }

  private bump(id: string, by: number) {
    const b = this.basket.find((x) => x.id === id);
    if (!b) return;
    b.quantity += by;
    if (b.quantity <= 0) this.basket = this.basket.filter((x) => x.id !== id);
    this.renderCheck();
  }

  /** Item tapped: choose size and modifiers when it has them, otherwise add one. */
  private async pickItem(itemId: string) {
    const rows = this.menu!.items.filter((r) => r.itemId === itemId);
    const groups = this.menu!.modifierGroups.filter((g) => rows[0].modifierGroups.includes(g.code));
    const canAvail = (api.session?.user.roles ?? []).some((r) => ['owner', 'area_manager', 'manager', 'cashier', 'waiter', 'bartender', 'kitchen'].includes(r));
    if (rows.length === 1 && !groups.length && rows[0].isAvailable) {
      this.addToBasket(rows[0], [], '');
      return;
    }
    const res = await modal(
      rows[0].name,
      `${rows.length > 1
        ? `<fieldset><legend>Size</legend>${rows.map((r, i) => `<label class="radio ${r.isAvailable ? '' : 'off'}"><input type="radio" name="portion" value="${esc(r.portionId)}" ${i === rows.findIndex((x) => x.isAvailable) ? 'checked' : ''} ${r.isAvailable ? '' : 'disabled'}> ${esc(r.portionName)} · ${kes(r.price)}${r.isAvailable ? '' : ' (not available)'}</label>`).join('')}</fieldset>`
        : `<input type="hidden" name="portion" value="${esc(rows[0].portionId)}">`}
       ${groups
         .map(
           (g) => `<fieldset><legend>${esc(g.name)} <small>${g.minSelect ? `choose ${g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect}–${g.maxSelect}`}` : `optional, up to ${g.maxSelect}`}</small></legend>
             ${g.options.map((o) => `<label class="radio"><input type="${g.maxSelect === 1 ? 'radio' : 'checkbox'}" name="mod_${esc(g.code)}" value="${esc(o.id)}"> ${esc(o.name)}${Number(o.priceDelta) ? ` +${kes(o.priceDelta)}` : ''}</label>`).join('')}
           </fieldset>`,
         )
         .join('')}
       <label>Note for the kitchen/bar<input name="notes" maxlength="200" placeholder="e.g. no onions"></label>
       ${canAvail && this.online ? `<p><button type="button" class="link" data-avail>${rows.every((r) => !r.isAvailable) ? 'Mark available again' : 'Mark as not available (86)'}</button></p>` : ''}`,
      {
        submit: 'Add',
        onMount: (form) =>
          form.querySelector('[data-avail]')?.addEventListener('click', async () => {
            const makeAvailable = rows.every((r) => !r.isAvailable);
            try {
              for (const r of rows) await api.post(`${this.pos}/outlets/${this.outletCode}/prices/${r.priceId}/availability`, { isAvailable: makeAvailable });
              for (const r of rows) r.isAvailable = makeAvailable;
              toast(makeAvailable ? 'Back on the menu' : 'Marked not available', 'ok');
              (form.querySelector('[data-cancel]') as HTMLButtonElement).click();
              this.renderCheck();
            } catch (err) {
              showError(err);
            }
          }),
      },
    );
    if (!res || !res.portion) return;
    const row = rows.find((r) => r.portionId === res.portion)!;
    const ids: string[] = [];
    const names: string[] = [];
    let delta = '0.00';
    for (const g of groups) {
      const chosen = (res[`mod_${g.code}`] ?? '').split(',').filter(Boolean);
      if (chosen.length < g.minSelect || chosen.length > g.maxSelect) {
        toast(`${g.name}: choose ${g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect} to ${g.maxSelect}`}`, 'error');
        return;
      }
      for (const id of chosen) {
        const o = g.options.find((x) => x.id === id)!;
        ids.push(id);
        names.push(o.name);
        delta = addMoney(delta, o.priceDelta);
      }
    }
    this.addToBasket(row, ids, res.notes ?? '', names, delta);
  }

  private addToBasket(row: MenuRow, modifierOptionIds: string[], notes: string, modifierNames: string[] = [], modifierDelta = '0.00') {
    const same = this.basket.find((b) => b.row.portionId === row.portionId && b.notes === notes && b.modifierOptionIds.join() === modifierOptionIds.join());
    if (same) same.quantity++;
    else this.basket.push({ id: crypto.randomUUID(), row, quantity: 1, modifierOptionIds, modifierNames, modifierDelta, notes });
    this.renderCheck();
  }

  /** Posts the basket as lines (device ids), then sends them unless held. Works offline through the queue. */
  private async submitBasket(send: boolean) {
    const c = this.check!;
    const lines = this.basket.map((b) => ({ id: b.id, portionId: b.row.portionId, quantity: String(b.quantity), modifierOptionIds: b.modifierOptionIds, notes: b.notes || null }));
    const offline = c.offline || !this.online || this.queue.pendingFor(c.id).length > 0;
    if (lines.length && !offline) {
      const res = await withSignOff((extra) => api.post<Check>(`${this.pos}/checks/${c.id}/lines`, { lines, ...extra }));
      if (!res) return;
      this.check = res;
      this.basket = [];
    } else if (lines.length) {
      this.queueLines(lines);
    }
    if (send) {
      if (offline) {
        this.queue.add({ method: 'POST', path: `${this.pos}/checks/${c.id}/send`, body: {}, key: newKey('send'), label: 'Send to kitchen/bar', checkId: c.id });
        for (const l of this.check!.lines) if (l.status === 'draft') l.status = 'sent';
        this.saveLocal(this.check!);
        toast('Offline: order saved; it goes to the kitchen and bar when the connection returns', 'info');
      } else {
        try {
          const res = await api.post<Check & { tickets: Array<{ number: string; station: string | null }> }>(`${this.pos}/checks/${c.id}/send`);
          this.check = res;
          toast(res.tickets.length ? `Sent: ${res.tickets.map((t) => t.station ?? 'no printer').join(', ')}` : 'Sent', 'ok');
        } catch (err) {
          if (err instanceof ApiError && err.code === 'nothing_to_send') toast('Nothing new to send', 'info');
          else throw err;
        }
      }
    }
    this.renderCheck();
  }

  private queueLines(lines: Array<{ id: string; portionId: string; quantity: string; modifierOptionIds: string[]; notes: string | null }>) {
    const c = this.check!;
    // Liquor hours and stock are checked by the server when the queue is sent; a refusal shows on the check.
    this.queue.add({ method: 'POST', path: `${this.pos}/checks/${c.id}/lines`, body: { lines, acknowledgeWarnings: true }, key: newKey('lines'), label: `${lines.length} item(s)`, checkId: c.id });
    for (const b of this.basket) {
      c.lines.push({
        id: b.id, name: b.row.portionName ? `${b.row.name} (${b.row.portionName})` : b.row.name, quantity: String(b.quantity),
        amount: (Number(addMoney(b.row.price, b.modifierDelta)) * b.quantity).toFixed(2), status: 'draft', modifiers: b.modifierNames.map((name) => ({ name })),
        notes: b.notes || null, queued: true,
      });
    }
    const total = addMoney(...c.lines.map((l) => l.amount), '0');
    c.totals = { ...c.totals, total, balance: total };
    c.offline = true;
    this.saveLocal(c);
    this.basket = [];
  }

  private selectedOrAll(statusFilter?: (l: Line) => boolean): string[] {
    const live = this.check!.lines.filter((l) => l.status !== 'cancelled' && l.status !== 'wasted' && (!statusFilter || statusFilter(l)));
    const sel = live.filter((l) => this.selected.has(l.id));
    return (sel.length ? sel : live).map((l) => l.id);
  }

  private async serve() {
    const ids = this.selectedOrAll((l) => ['sent', 'preparing', 'ready'].includes(l.status));
    this.check = await api.post<Check>(`${this.pos}/checks/${this.check!.id}/serve`, { lineIds: ids });
    this.selected.clear();
    this.renderCheck();
  }

  // ---------------------------------------------------------------------------
  // Settlement (POS-08 … POS-10, POS-18)
  // ---------------------------------------------------------------------------
  private async pay(preset?: string, amount?: string) {
    await this.flushDrafts();
    const c = this.check!;
    const due = c.totals.balance;
    const res = await modal(
      `Pay ${c.number}`,
      `<p class="big-number">KSh ${kes(due)} due</p>
       <label>Tender<select name="tender">
         ${[['cash', 'Cash'], ['mpesa', 'M-PESA'], ['card', 'Card'], ['bank_transfer', 'Bank transfer'], ['other', 'Other']]
           .map(([v, t]) => `<option value="${v}" ${v === (preset ?? 'cash') ? 'selected' : ''}>${t}</option>`)
           .join('')}</select></label>
       <label>Amount<input name="amount" inputmode="decimal" required value="${esc(amount ?? due)}" pattern="\\d+(\\.\\d{1,2})?"></label>
       <label data-for="cash">Cash received<input name="tendered" inputmode="decimal" pattern="\\d+(\\.\\d{1,2})?" placeholder="for change"></label>
       <label data-for="ref">Reference (M-PESA code, card approval)<input name="reference" maxlength="60" autocomplete="off"></label>
       <p class="muted">Pay part now and the rest with another tender to split by amount.</p>`,
      {
        submit: 'Take payment',
        onMount: (f) => {
          const sel = f.querySelector<HTMLSelectElement>('[name=tender]')!;
          const sync = () => {
            f.querySelector<HTMLElement>('[data-for=cash]')!.hidden = sel.value !== 'cash';
            f.querySelector<HTMLElement>('[data-for=ref]')!.hidden = sel.value === 'cash';
          };
          sel.addEventListener('change', sync);
          sync();
        },
      },
    );
    if (!res) return;
    const tender = { tender: res.tender, amount: res.amount, tendered: res.tender === 'cash' && res.tendered ? res.tendered : null, reference: res.tender === 'cash' ? null : res.reference || null };
    try {
      const out = await api.post<Check & { change: string }>(`${this.pos}/checks/${c.id}/payments`, { tenders: [tender] });
      this.check = out;
      toast(Number(out.change) ? `Paid. Change: KES ${kes(out.change)}` : out.status === 'closed' ? 'Paid and closed' : `Paid. ${kes(out.totals.balance)} still due`, 'ok');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'no_open_shift') {
        toast('Open your cash shift before taking cash', 'error');
        return this.shiftDialog();
      }
      throw err;
    }
    this.renderCheck();
  }

  /**
   * Split evenly (POS-08): works out one person's share and takes it with the
   * chosen tender; the next person pays the next share from what is left.
   */
  private async splitEvenly() {
    await this.flushDrafts();
    const due = this.check!.totals.balance;
    const res = await modal(
      'Split evenly',
      `<p class="big-number">KSh ${kes(due)} due</p>
       <label>How many people still have to pay?<input name="people" type="number" min="2" max="40" value="2" required></label>
       <label>This person pays by<select name="tender"><option value="cash">Cash</option><option value="mpesa">M-PESA</option><option value="card">Card</option></select></label>
       <p class="muted">Each share is rounded down to the cent. The last person pays whatever is left with the PAY button.</p>`,
      { submit: 'Next' },
    );
    if (!res) return;
    await this.pay(res.tender, evenShare(due, Number(res.people)));
  }

  /** Lines held on the server as drafts go out before settling (the server also does this). */
  private async flushDrafts() {
    if (this.basket.length) throw new Error('Send or remove the new items first');
  }

  private async findStay(title: string): Promise<{ stayId: string; roomNumber: string; guestName: string; available: string | null } | null> {
    type Stay = { stayId: string; roomNumber: string; guestName: string; departureDate: string; eligible: boolean; reason: string | null; available: string | null };
    let stays: Stay[] = await api.get<Stay[]>(`${this.pos}/in-house`);
    const render = (list: Stay[]) =>
      list
        .map(
          (s) => `<label class="radio ${s.eligible ? '' : 'off'}"><input type="radio" name="stay" value="${esc(s.stayId)}" ${s.eligible ? '' : 'disabled'}>
            <strong>Room ${esc(s.roomNumber)}</strong> ${esc(s.guestName)} <small>to ${esc(s.departureDate)}${s.available !== null ? ` · ${kes(s.available)} credit left` : ''}${s.reason ? ` · ${esc(s.reason)}` : ''}</small></label>`,
        )
        .join('') || '<p class="muted">No in-house guests match.</p>';
    const res = await modal(title, `<label>Room or surname<input name="q" data-q autocomplete="off"></label><div data-stays>${render(stays)}</div>`, {
      submit: 'Choose',
      onMount: (f) => {
        let t: ReturnType<typeof setTimeout>;
        f.querySelector<HTMLInputElement>('[data-q]')!.addEventListener('input', (e) => {
          clearTimeout(t);
          t = setTimeout(async () => {
            stays = await api.get<Stay[]>(`${this.pos}/in-house?q=${encodeURIComponent((e.target as HTMLInputElement).value)}`).catch(() => stays);
            f.querySelector('[data-stays]')!.innerHTML = render(stays);
          }, 250);
        });
      },
    });
    const stay = stays.find((s) => s.stayId === res?.stay);
    return stay ?? null;
  }

  /** POS-09: the unpaid remainder goes to the guest's folio, with their signature or staff verification. */
  private async roomCharge() {
    const c = this.check!;
    const stay = c.stayId ? { stayId: c.stayId, roomNumber: c.roomNumber ?? '', guestName: c.guestName ?? '', available: null } : await this.findStay('Charge to which room?');
    if (!stay) return;
    let signature: string | null = null;
    const res = await modal(
      `Charge ${kes(c.totals.balance)} to room ${stay.roomNumber}`,
      `<p>${esc(stay.guestName)}</p>
       <label class="radio"><input type="radio" name="method" value="guest_signature" checked> Guest signs</label>
       <label class="radio"><input type="radio" name="method" value="staff_verified"> Verified by staff (guest not present to sign)</label>
       <label>Name of the person signing<input name="signedName" required minlength="2" maxlength="120" value="${esc(stay.guestName)}"></label>
       <div data-sig><p class="muted">Signature</p><canvas class="sig" width="480" height="160"></canvas><button type="button" class="link" data-clear>Clear</button></div>`,
      {
        submit: 'Charge to room',
        onMount: (f) => {
          const canvas = f.querySelector<HTMLCanvasElement>('canvas')!;
          const pad = signaturePad(canvas, (data) => (signature = data));
          f.querySelector('[data-clear]')!.addEventListener('click', () => {
            pad.clear();
            signature = null;
          });
          f.querySelectorAll<HTMLInputElement>('[name=method]').forEach((r) =>
            r.addEventListener('change', () => (f.querySelector<HTMLElement>('[data-sig]')!.hidden = r.value !== 'guest_signature' || !r.checked)),
          );
        },
      },
    );
    if (!res) return;
    if (res.method === 'guest_signature' && !signature) {
      toast('Ask the guest to sign, or choose “Verified by staff”', 'error');
      return;
    }
    this.check = await api.post<Check>(`${this.pos}/checks/${c.id}/room-charge`, {
      stayId: stay.stayId,
      acknowledgement: { method: res.method, signedName: res.signedName, signature: res.method === 'guest_signature' ? signature : null },
    });
    toast(`Charged to room ${stay.roomNumber}`, 'ok');
    this.renderCheck();
  }

  private async houseAccount() {
    const accounts = await api.get<Array<{ code: string; name: string; isActive: boolean; monthlyLimit: string | null; usedThisMonth: string }>>(`${this.pos}/house-accounts`);
    const res = await modal(
      'House account (not a sale)',
      `<label>Account<select name="code">${accounts.filter((a) => a.isActive).map((a) => `<option value="${esc(a.code)}">${esc(a.name)}${a.monthlyLimit ? ` · ${kes(a.usedThisMonth)} of ${kes(a.monthlyLimit)} used` : ''}</option>`).join('')}</select></label>
       <label>Reason<input name="reason" required minlength="3" maxlength="500"></label>`,
      { submit: 'Charge to account' },
    );
    if (!res) return;
    const out = await withSignOff((extra) => api.post<Check>(`${this.pos}/checks/${this.check!.id}/house-account`, { houseAccountCode: res.code, reason: res.reason, ...extra }));
    if (out) {
      this.check = out;
      this.renderCheck();
    }
  }

  // ---------------------------------------------------------------------------
  // Corrections and bill operations (POS-03, POS-05, POS-08, POS-11)
  // ---------------------------------------------------------------------------
  private async discount() {
    const ids = this.selectedOrAll();
    const res = await modal(
      ids.length === this.check!.lines.length ? 'Discount the whole bill' : `Discount ${ids.length} item(s)`,
      `<label>Percent<input name="percent" type="number" min="0" max="100" step="0.01" required value="10"></label>
       <p class="muted">100% makes the items complimentary. Above the property's limit a manager signs off.</p>
       <label>Reason<input name="reason" required minlength="3" maxlength="500"></label>`,
      { submit: 'Apply' },
    );
    if (!res) return;
    const out = await withSignOff((extra) => api.post<Check>(`${this.pos}/checks/${this.check!.id}/discount`, { lineIds: ids, percent: res.percent, reason: res.reason, ...extra }));
    if (out) {
      this.check = out;
      this.selected.clear();
      this.renderCheck();
    }
  }

  private async cancelLines() {
    if (!this.selected.size) return toast('Tap the items to cancel first', 'info');
    const lines = this.check!.lines.filter((l) => this.selected.has(l.id));
    const prepared = lines.some((l) => ['preparing', 'ready', 'served'].includes(l.status));
    const res = await modal(
      prepared ? 'Record as waste' : 'Cancel items',
      `<p>${lines.map((l) => `${Number(l.quantity)} × ${esc(l.name)}`).join('<br>')}</p>
       ${prepared ? '<p class="warn">Some of these were already prepared: they are recorded as waste and need a manager.</p>' : ''}
       <label>Reason<input name="reason" required minlength="3" maxlength="500"></label>`,
      { submit: prepared ? 'Record waste' : 'Cancel items', danger: true },
    );
    if (!res) return;
    const out = await withSignOff((extra) => api.post<Check>(`${this.pos}/checks/${this.check!.id}/cancel-lines`, { lineIds: [...this.selected], reason: res.reason, ...extra }));
    if (out) {
      this.check = out;
      this.selected.clear();
      this.renderCheck();
    }
  }

  private async split() {
    if (!this.selected.size) return toast('Tap the items that move to the new check', 'info');
    const lines = this.check!.lines.filter((l) => this.selected.has(l.id));
    const res = await modal(
      'Split to a new check',
      lines.map((l) => `<label>${esc(l.name)} (of ${Number(l.quantity)})<input name="q_${esc(l.id)}" type="number" min="0.0001" max="${esc(l.quantity)}" step="any" value="${Number(l.quantity)}"></label>`).join(''),
      { submit: 'Split' },
    );
    if (!res) return;
    const parts = lines.map((l) => ({ lineId: l.id, quantity: String(res[`q_${l.id}`]) }));
    const out = await api.post<{ from: Check; to: Check }>(`${this.pos}/checks/${this.check!.id}/split`, { parts });
    toast(`New check ${out.to.number}`, 'ok');
    this.check = out.to;
    this.selected.clear();
    this.renderCheck();
  }

  private async move() {
    const m = this.menu!;
    const res = await modal(
      'Move table or rename tab',
      `${m.tables.length ? `<label>Table<select name="tableId"><option value="">(keep)</option>${m.tables.map((t) => `<option value="${esc(t.id)}">${esc(t.code)} · ${esc(t.area)}</option>`).join('')}</select></label>` : ''}
       <label>Tab name<input name="tabName" maxlength="60" value="${esc(this.check!.tabName ?? '')}"></label>
       <label>Covers<input name="covers" type="number" min="0" max="200" value="${this.check!.covers}"></label>`,
      { submit: 'Save' },
    );
    if (!res) return;
    const body: Record<string, unknown> = { covers: Number(res.covers) };
    if (res.tableId) body.tableId = res.tableId;
    if (res.tabName !== (this.check!.tabName ?? '')) body.tabName = res.tabName || null;
    this.check = await api.post<Check>(`${this.pos}/checks/${this.check!.id}/transfer`, body);
    this.renderCheck();
  }

  private async merge() {
    const others = (await api.get<CheckSummary[]>(`${this.pos}/outlets/${this.outletCode}/checks`)).filter((c) => c.id !== this.check!.id);
    if (!others.length) return toast('No other open checks here', 'info');
    const res = await modal(
      `Merge into ${this.check!.number}`,
      others.map((c) => `<label class="radio"><input type="checkbox" name="from" value="${esc(c.id)}"> ${esc(c.number)} · ${esc(c.tableCode ? `Table ${c.tableCode}` : c.tabName ?? '')} · ${kes(c.balance)}</label>`).join(''),
      { submit: 'Merge' },
    );
    if (!res?.from) return;
    this.check = await api.post<Check>(`${this.pos}/checks/${this.check!.id}/merge`, { fromCheckIds: res.from.split(',') });
    this.renderCheck();
  }

  private async voidCheck() {
    const res = await modal('Void the whole check', '<p>Every item is cancelled (or recorded as waste if prepared). A manager signs off.</p><label>Reason<input name="reason" required minlength="3" maxlength="500"></label>', {
      submit: 'Void check',
      danger: true,
    });
    if (!res) return;
    const out = await withSignOff((extra) => api.post<Check>(`${this.pos}/checks/${this.check!.id}/void`, { reason: res.reason, ...extra }));
    if (out) {
      toast(`${out.number} voided`, 'ok');
      await this.showFloor();
    }
  }

  // ---------------------------------------------------------------------------
  // Cash shift (POS-13)
  // ---------------------------------------------------------------------------
  private async shiftDialog(): Promise<void> {
    type Shift = { id: string; number: string; outletName: string; openingFloat: string; openedAt: string; movements: Array<{ kind: string; amount: string; reason: string }> };
    const current = await api.get<Shift | ''>(`${this.pos}/shifts/current`);
    if (!current) {
      const res = await modal('Open cash shift', `<p>Count the float in the drawer at ${esc(this.menu!.outlet.name)}.</p><label>Opening float (KES)<input name="float" inputmode="decimal" required pattern="\\d+(\\.\\d{1,2})?"></label>`, {
        submit: 'Open shift',
      });
      if (!res) return;
      const s = await api.post<Shift>(`${this.pos}/shifts`, { outletCode: this.outletCode, openingFloat: res.float });
      toast(`Shift ${s.number} open`, 'ok');
      return;
    }
    const res = await modal(
      `Shift ${current.number}`,
      `<p>${esc(current.outletName)} · float ${kes(current.openingFloat)} · opened ${esc(new Date(current.openedAt).toLocaleTimeString())}</p>
       ${current.movements.length ? `<ul>${current.movements.map((m) => `<li>${esc(m.kind.replace('_', ' '))} ${kes(m.amount)}: ${esc(m.reason)}</li>`).join('')}</ul>` : ''}
       <label>Action<select name="action">
         <option value="drop">Cash drop to safe</option><option value="paid_in">Paid in</option><option value="paid_out">Paid out (manager)</option>
         <option value="close">Count and close shift</option></select></label>
       <label>Amount (KES)<input name="amount" inputmode="decimal" required pattern="\\d+(\\.\\d{1,2})?"></label>
       <label>Reason / note<input name="reason" maxlength="500"></label>
       <p class="muted">Closing is a blind count: enter the cash you counted. The expected amount is shown to the manager afterwards.</p>`,
      { submit: 'Save' },
    );
    if (!res) return;
    if (res.action === 'close') {
      const out = await api.post<{ number: string; variance: string }>(`${this.pos}/shifts/${current.id}/close`, { countedAmount: res.amount, note: res.reason || null });
      toast(`Shift ${out.number} closed${out.variance && Number(out.variance) ? ': a manager will review the count' : ''}`, 'ok');
      return;
    }
    if (res.reason.trim().length < 3) return toast('Give a reason', 'error');
    await withSignOff((extra) => api.post(`${this.pos}/shifts/current/movements`, { kind: res.action, amount: res.amount, reason: res.reason, ...extra }));
    toast('Recorded', 'ok');
  }
}

function groupItems(rows: MenuRow[]): Array<{ itemId: string; rows: MenuRow[] }> {
  const map = new Map<string, MenuRow[]>();
  for (const r of rows) map.set(r.itemId, [...(map.get(r.itemId) ?? []), r]);
  return [...map.entries()].map(([itemId, rs]) => ({ itemId, rows: rs }));
}

/** One person's share of an amount split n ways, rounded down to the cent. */
export function evenShare(amount: string, people: number): string {
  const [whole, frac = ''] = amount.split('.');
  const cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  const share = people > 1 ? cents / BigInt(people) : cents;
  return `${share / 100n}.${String(share % 100n).padStart(2, '0')}`;
}

/** Tile colour by category, so a waiter finds food, beer, spirits and soft drinks at a glance. */
export function tileClass(category: string): string {
  const known: Record<string, string> = {
    ALL: 't-all', FAV: 't-fav', BREAKFAST: 't-food', STARTERS: 't-food', MAINS: 't-food', GRILL: 't-grill', DESSERTS: 't-sweet',
    COFFEE: 't-coffee', SOFT: 't-soft', BEER: 't-beer', SPIRITS: 't-spirit', WINE: 't-wine', COCKTAILS: 't-cocktail',
    SHOP: 't-other', LEISURE: 't-other', SPA: 't-other',
  };
  if (known[category]) return known[category];
  const spare = ['t-food', 't-soft', 't-beer', 't-spirit', 't-wine', 't-other'];
  return spare[[...category].reduce((a, ch) => a + ch.charCodeAt(0), 0) % spare.length];
}

function minPrice(rows: MenuRow[]): string {
  return rows.map((r) => r.price).sort((a, b) => Number(a) - Number(b))[0];
}

export function deviceId(): string {
  let id = localStorage.getItem('yeastay.pwa.device');
  if (!id) {
    id = `tab-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem('yeastay.pwa.device', id);
  }
  return id;
}

/** A finger/pen signature pad; reports a PNG data URL after each stroke. */
function signaturePad(canvas: HTMLCanvasElement, onChange: (data: string) => void) {
  const ctx = canvas.getContext('2d')!;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#0b2e31';
  let drawing = false;
  const pos = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height] as const;
  };
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const [x, y] = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  });
  const end = () => {
    if (!drawing) return;
    drawing = false;
    onChange(canvas.toDataURL('image/png'));
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointerleave', end);
  return { clear: () => ctx.clearRect(0, 0, canvas.width, canvas.height) };
}
