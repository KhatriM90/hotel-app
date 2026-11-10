/**
 * Shared tablets (Kahama service-team meeting, 9 Nov 2026, item 2.3): staff
 * sign in by tapping their name and entering a PIN, and the tablet signs them
 * out by itself so the next person never works under someone else's account.
 */
import { api, ApiError, type DeviceStaff, OfflineError } from './api';
import { esc, modal, toast } from './ui';

/** Roles that may register a tablet (the server checks pos.device.manage). */
export const canManageDevices = (roles: string[]) => roles.some((r) => ['owner', 'admin', 'area_manager', 'manager'].includes(r));

/**
 * Signs out after `seconds` without a touch. The last 15 seconds show a
 * countdown that any touch cancels. While offline it waits, because nobody
 * could sign in again until the connection returns.
 */
export class IdleGuard {
  private last = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private banner: HTMLElement | null = null;
  private readonly touch = () => {
    this.last = Date.now();
    this.hideBanner();
  };

  constructor(
    private readonly seconds: number,
    private readonly onExpire: () => void,
    private readonly isActive: () => boolean,
  ) {}

  start(): void {
    this.stop();
    this.last = Date.now();
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, this.touch, { capture: true, passive: true });
    this.timer = setInterval(() => this.check(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(ev, this.touch, { capture: true });
    this.hideBanner();
  }

  /** Seconds left before sign-out (for tests and the countdown). */
  remaining(now = Date.now()): number {
    return Math.max(0, Math.ceil(this.seconds - (now - this.last) / 1000));
  }

  private check(): void {
    if (!this.isActive()) {
      this.last = Date.now();
      return;
    }
    // A modal (payment, manager sign-off) counts as activity only through touches.
    const left = this.remaining();
    if (left <= 0) {
      this.stop();
      this.onExpire();
    } else if (left <= 15) {
      this.showBanner(left);
    }
  }

  private showBanner(left: number): void {
    if (!this.banner) {
      this.banner = document.createElement('div');
      this.banner.className = 'idle-banner';
      this.banner.setAttribute('role', 'alert');
      document.body.appendChild(this.banner);
    }
    this.banner.textContent = `Signing out in ${left} s. Touch the screen to stay signed in.`;
  }

  private hideBanner(): void {
    this.banner?.remove();
    this.banner = null;
  }
}

/** Name tiles and a PIN pad. Resolves when someone signed in; `usePassword` switches to the password form. */
export async function showPinLogin(main: HTMLElement, onSignedIn: () => void, usePassword: (msg?: string) => void): Promise<void> {
  let staff: DeviceStaff[];
  try {
    staff = (await api.deviceStaff()).staff;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'device_not_registered') {
      api.device = null;
      return usePassword('This tablet is no longer registered for PIN sign-in. Sign in with your password.');
    }
    if (err instanceof OfflineError) return usePassword('No connection: PIN sign-in needs the server. Try again when the connection returns.');
    throw err;
  }
  const d = api.device!;
  main.innerHTML = `
    <div class="card login wide">
      <h1>Who is using ${esc(d.name)}?</h1>
      <p class="muted">${esc(d.propertyName ?? d.propertyCode)} · tap your name and enter your PIN</p>
      <div class="staff-tiles">${
        staff.length
          ? staff.map((s) => `<button class="staff-tile" data-user="${esc(s.id)}"><strong>${esc(s.displayName)}</strong><span>${esc(s.roles.join(', '))}</span></button>`).join('')
          : '<p class="muted">Nobody has a PIN yet. Sign in with your password, then choose "Set my PIN".</p>'
      }</div>
      <button class="link" data-password>Sign in with username and password</button>
    </div>`;
  main.querySelector('[data-password]')!.addEventListener('click', () => usePassword());
  main.querySelectorAll<HTMLButtonElement>('[data-user]').forEach((b) =>
    b.addEventListener('click', async () => {
      const person = staff.find((s) => s.id === b.dataset.user)!;
      const pin = await pinPad(person.displayName);
      if (!pin) return;
      try {
        await api.pinLogin(person.id, pin);
        onSignedIn();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    }),
  );
}

/** A large on-screen keypad; resolves with the PIN, or null when cancelled. */
function pinPad(name: string): Promise<string | null> {
  let pin = '';
  return modal(
    name,
    `<div class="pin-dots" aria-live="polite"></div>
     <input type="hidden" name="pin">
     <div class="pin-pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']
       .map((k) => `<button type="button" data-k="${k}">${k}</button>`)
       .join('')}</div>`,
    {
      submit: 'Sign in',
      onMount: (f) => {
        const dots = f.querySelector<HTMLElement>('.pin-dots')!;
        const input = f.querySelector<HTMLInputElement>('[name=pin]')!;
        const sync = () => {
          input.value = pin;
          dots.textContent = pin ? '●'.repeat(pin.length) : 'Enter PIN';
        };
        sync();
        f.querySelectorAll<HTMLButtonElement>('[data-k]').forEach((k) =>
          k.addEventListener('click', () => {
            const v = k.dataset.k!;
            if (v === 'C') pin = '';
            else if (v === '⌫') pin = pin.slice(0, -1);
            else if (pin.length < 6) pin += v;
            sync();
          }),
        );
        f.addEventListener('keydown', (e) => {
          if (/^\d$/.test(e.key) && pin.length < 6) pin += e.key;
          else if (e.key === 'Backspace') pin = pin.slice(0, -1);
          else return;
          e.preventDefault();
          sync();
        });
      },
    },
  ).then((res) => (res && /^\d{4,6}$/.test(res.pin) ? res.pin : res ? (toast('A PIN is 4 to 6 digits', 'error'), null) : null));
}

/** The signed-in user sets or changes their own PIN. */
export async function setMyPin(): Promise<void> {
  const res = await modal(
    'Set my PIN',
    `<p class="muted">4 to 6 digits, not all the same and not a run like 1234. Keep it to yourself: everything done under your PIN is recorded as yours.</p>
     <label>Your password<input name="currentPassword" type="password" autocomplete="current-password" required></label>
     <label>New PIN<input name="pin" type="password" inputmode="numeric" pattern="\\d{4,6}" minlength="4" maxlength="6" autocomplete="off" required></label>
     <label>New PIN again<input name="again" type="password" inputmode="numeric" pattern="\\d{4,6}" minlength="4" maxlength="6" autocomplete="off" required></label>`,
    { submit: 'Save PIN' },
  );
  if (!res) return;
  if (res.pin !== res.again) return toast('The two PINs differ', 'error');
  await api.post('/auth/pin', { currentPassword: res.currentPassword, pin: res.pin });
  toast('PIN saved', 'ok');
}

/** A manager registers this tablet for PIN sign-in at a property. */
export async function registerTablet(property: string): Promise<void> {
  const current = api.device;
  const res = await modal(
    current ? `This tablet: ${current.name}` : 'Register this tablet',
    `${current ? `<p>Registered at ${esc(current.propertyCode)}. Registering again replaces it; unregister the old one in the back office.</p>` : ''}
     <p class="muted">Staff then sign in on it with their name and PIN, and it signs them out by itself.</p>
     <label>Tablet name<input name="name" required minlength="2" maxlength="60" placeholder="e.g. Pool bar tablet" value="${esc(current?.name ?? '')}"></label>
     <label>Sign out after no touch for<select name="idle">
       ${[[60, '1 minute'], [120, '2 minutes'], [300, '5 minutes'], [600, '10 minutes'], [1800, '30 minutes']]
         .map(([v, t]) => `<option value="${v}" ${v === (current?.idleSignoutSeconds ?? 120) ? 'selected' : ''}>${t}</option>`)
         .join('')}</select></label>
     <label class="check"><input type="checkbox" name="afterSend" value="1" ${current?.signoutAfterSend ? 'checked' : ''}> Also sign out after every Send and finished payment</label>`,
    { submit: 'Register tablet' },
  );
  if (!res) return;
  const out = await api.post<{ id: string; name: string; token: string; idleSignoutSeconds: number; signoutAfterSend: boolean }>(
    `/properties/${property}/pos/devices`,
    { name: res.name, idleSignoutSeconds: Number(res.idle), signoutAfterSend: res.afterSend === '1' },
  );
  api.device = { id: out.id, name: out.name, token: out.token, propertyCode: property, idleSignoutSeconds: out.idleSignoutSeconds, signoutAfterSend: out.signoutAfterSend };
  toast(`${out.name} is registered. Staff can now sign in with their PIN.`, 'ok');
}
