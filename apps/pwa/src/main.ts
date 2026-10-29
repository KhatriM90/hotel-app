import { api, ApiError, OfflineError } from './api';
import { label, probe, type ConnectionState } from './connection';
import { StationApp } from './station';
import { esc, showError } from './ui';
import { WaiterApp } from './waiter';
import './style.css';

const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="top"><img src="/pwa/brand/yeastay-logo-white.svg" alt="YeaStay" /><span class="spacer"></span><span id="who"></span><span class="clock" id="clock"></span></header>
  <div class="status checking" role="status" aria-live="polite" id="status"></div>
  <main id="main"></main>`;
const main = document.getElementById('main')!;
const who = document.getElementById('who')!;
const clock = document.getElementById('clock')!;
function tick() {
  const now = new Date();
  clock.innerHTML = `${now.toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short' })}<b>${now.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}</b>`;
}
tick();
setInterval(tick, 20_000);

// ---------------------------------------------------------------------------
// Connection (OPS-04): what the device shows is what the server answered.
// ---------------------------------------------------------------------------
const statusEl = document.getElementById('status')!;
let waiter: WaiterApp | null = null;
let station: StationApp | null = null;
function renderStatus(state: ConnectionState) {
  statusEl.className = `status ${state}`;
  statusEl.textContent = state === 'offline' && waiter ? 'Offline: orders are saved on this tablet and sent later. Payments and room charges wait.' : label(state);
  if (state !== 'checking') waiter?.setOnline(state === 'online');
}
async function refreshStatus() {
  renderStatus(await probe());
}
renderStatus('checking');
void refreshStatus();
setInterval(refreshStatus, 15_000);
window.addEventListener('online', refreshStatus);
window.addEventListener('offline', () => renderStatus('offline'));

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
const MODE_KEY = 'yeastay.pwa.mode';
const roles = () => api.session?.user.roles ?? [];
const canSell = () => roles().some((r) => ['owner', 'area_manager', 'manager', 'cashier', 'waiter', 'bartender'].includes(r));
const canStation = () => roles().some((r) => ['owner', 'area_manager', 'manager', 'kitchen', 'bartender'].includes(r));
// Front desk, reservations, POS reports and SAP postings live in the back office at the site root, not in this tablet app.
const canBackOffice = () => roles().some((r) => !['waiter', 'bartender', 'kitchen'].includes(r));
const canHousekeeping = () => roles().some((r) => ['owner', 'admin', 'manager', 'receptionist', 'housekeeper'].includes(r));

function renderWho() {
  const s = api.session;
  who.innerHTML = s ? `${esc(s.user.displayName)}${s.propertyCode ? ` · ${esc(s.propertyCode)}` : ''} <button class="link light" id="logout">Sign out</button>` : '';
  document.getElementById('logout')?.addEventListener('click', () => {
    station?.stop();
    waiter = null;
    station = null;
    api.logout();
    void route();
  });
}

function showLogin(error = '') {
  main.innerHTML = `
    <form class="card login" id="login">
      <h1>Sign in</h1>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <label>Username<input name="username" autocomplete="username" autocapitalize="off" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="primary big" type="submit">Sign in</button>
    </form>`;
  document.getElementById('login')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    try {
      await api.login(String(f.get('username')), String(f.get('password')));
      await route();
    } catch (err) {
      showLogin(err instanceof ApiError && err.status === 401 ? 'Wrong username or password' : err instanceof Error ? err.message : String(err));
    }
  });
}

async function chooseProperty(): Promise<string | null> {
  const s = api.session!;
  if (s.propertyCode) return s.propertyCode;
  const props = await api.get<Array<{ code: string; name: string }>>('/properties');
  if (props.length === 1) {
    api.session = { ...s, propertyCode: props[0].code };
    return props[0].code;
  }
  main.innerHTML = `<h1>Which property?</h1><div class="modes">${props
    .map((p) => `<button class="mode" data-p="${esc(p.code)}"><strong>${esc(p.name)}</strong><span>${esc(p.code)}</span></button>`)
    .join('')}</div>`;
  main.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) =>
    b.addEventListener('click', () => {
      api.session = { ...api.session!, propertyCode: b.dataset.p };
      void route();
    }),
  );
  return null;
}

function chooseMode(property: string) {
  const modes = [
    canSell() ? '<button class="mode" data-mode="waiter"><strong>Waiter / bar POS</strong><span>Tables, tabs, orders, bills and payments</span></button>' : '',
    canStation() ? '<button class="mode" data-mode="station"><strong>Kitchen / bar tickets</strong><span>Orders to prepare, bump when ready</span></button>' : '',
    canHousekeeping() ? '<button class="mode soon" data-mode="housekeeping"><strong>Housekeeping</strong><span>Not built yet (HK-01 to HK-04)</span></button>' : '',
    canBackOffice() ? '<a class="mode" href="/"><strong>Back office ›</strong><span>Front desk, reservations, rooms, POS day close and sales, SAP postings</span></a>' : '',
  ];
  main.innerHTML = `<h1>Choose a mode</h1><div class="modes">${modes.join('')}</div>`;
  main.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.mode === 'housekeeping') return housekeepingSoon(property);
      localStorage.setItem(MODE_KEY, b.dataset.mode!);
      void (b.dataset.mode === 'waiter' ? chooseOutlet(property) : chooseStation(property)).catch(showError);
    }),
  );
}

function housekeepingSoon(property: string) {
  main.innerHTML = `<div class="bar"><button class="ghost" data-back>‹ Modes</button><h1>Housekeeping</h1></div>
    <div class="card notice"><p><strong>Not built yet.</strong> The room board and cleaning tasks for housekeeping phones come with HK-01 to HK-04.</p>
    <p>Until then, room status is shown in the back office under Front desk and Rooms.</p></div>`;
  main.querySelector('[data-back]')!.addEventListener('click', () => chooseMode(property));
}

async function chooseOutlet(property: string) {
  const last = localStorage.getItem(`yeastay.pwa.outlet.${property}`);
  type PosOutlet = { code: string; name: string; type: string; dayDate: string | null; openChecks: number; closeDue: boolean };
  let outlets: PosOutlet[];
  try {
    outlets = await api.get<PosOutlet[]>(`/properties/${property}/pos/outlets`);
  } catch (err) {
    // Offline: go straight back to the outlet this tablet last used, with its saved menu (OPS-05).
    if (!(err instanceof OfflineError) || !last) throw err;
    return startWaiter(property, last);
  }
  main.innerHTML = `<div class="bar"><button class="ghost" data-back>‹ Modes</button><h1>Which outlet?</h1></div>
    <div class="modes">${outlets
      .map(
        (o) => `<button class="mode ${o.code === last ? 'last' : ''}" data-o="${esc(o.code)}"><strong>${esc(o.name)}</strong>
          <span>${esc(o.type)}${o.openChecks ? ` · ${o.openChecks} open check(s)` : ''}${o.closeDue ? ' · day close due' : ''}</span></button>`,
      )
      .join('')}</div>`;
  main.querySelector('[data-back]')!.addEventListener('click', () => chooseMode(property));
  main.querySelectorAll<HTMLButtonElement>('[data-o]').forEach((b) =>
    b.addEventListener('click', () => {
      localStorage.setItem(`yeastay.pwa.outlet.${property}`, b.dataset.o!);
      void startWaiter(property, b.dataset.o!);
    }),
  );
}

async function startWaiter(property: string, outletCode: string) {
  waiter = new WaiterApp(main, property, outletCode, () => {
    waiter = null;
    void chooseOutlet(property).catch(showError);
  });
  await waiter.start().catch(showError);
}

async function chooseStation(property: string) {
  const stations = await api.get<Array<{ code: string; name: string; kind: string; isActive: boolean }>>(`/properties/${property}/pos/stations`);
  main.innerHTML = `<div class="bar"><button class="ghost" data-back>‹ Modes</button><h1>Which station?</h1></div>
    <div class="modes">${stations
      .filter((s) => s.isActive)
      .map((s) => `<button class="mode" data-s="${esc(s.code)}" data-n="${esc(s.name)}"><strong>${esc(s.name)}</strong><span>${esc(s.kind)}</span></button>`)
      .join('')}</div>`;
  main.querySelector('[data-back]')!.addEventListener('click', () => chooseMode(property));
  main.querySelectorAll<HTMLButtonElement>('[data-s]').forEach((b) =>
    b.addEventListener('click', async () => {
      station = new StationApp(main, property, { code: b.dataset.s!, name: b.dataset.n! }, () => {
        station = null;
        void chooseStation(property);
      });
      await station.start().catch(showError);
    }),
  );
}

async function route() {
  renderWho();
  if (!api.session) return showLogin();
  try {
    const property = await chooseProperty();
    renderWho();
    if (!property) return;
    const mode = localStorage.getItem(MODE_KEY);
    if (mode === 'waiter' && canSell()) await chooseOutlet(property);
    else chooseMode(property);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showLogin('Your session ended; sign in again');
    showError(err);
  }
}

void route();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/pwa/sw.js', { scope: '/pwa/' }));
}
