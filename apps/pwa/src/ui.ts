/** Small DOM helpers for the device app: escaping, money, modals, toasts and the manager sign-off flow. */
import { ApiError } from './api';

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const fmt = new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function kes(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  return fmt.format(Number(v));
}

/** Adds two decimal strings exactly (cents), for display only; the server prices every line. */
export function addMoney(...values: Array<string | number>): string {
  const cents = values.reduce<number>((a, v) => a + Math.round(Number(v) * 100), 0);
  return (cents / 100).toFixed(2);
}

export function toast(message: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

/**
 * Opens a modal with the given inner HTML. Resolves with the submitted form's
 * values, or null when cancelled. `onMount` can wire extra behaviour.
 */
export function modal(title: string, body: string, opts: { submit?: string; danger?: boolean; onMount?: (root: HTMLElement) => void } = {}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<form class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h2>${esc(title)}</h2>
      <div class="modal-body">${body}</div>
      <div class="modal-actions">
        <button type="button" class="ghost" data-cancel>Cancel</button>
        ${opts.submit === '' ? '' : `<button type="submit" class="${opts.danger ? 'danger' : 'primary'}">${esc(opts.submit ?? 'OK')}</button>`}
      </div>
    </form>`;
    const form = wrap.querySelector('form')!;
    const close = (value: Record<string, string> | null) => {
      wrap.remove();
      resolve(value);
    };
    wrap.querySelector('[data-cancel]')!.addEventListener('click', () => close(null));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data: Record<string, string> = {};
      new FormData(form).forEach((v, k) => {
        data[k] = data[k] ? `${data[k]},${String(v)}` : String(v);
      });
      close(data);
    });
    document.body.appendChild(wrap);
    opts.onMount?.(form);
    (form.querySelector('input, select, textarea, button[type=submit]') as HTMLElement | null)?.focus();
  });
}

export async function confirmBox(title: string, message: string, submit = 'Confirm', danger = false): Promise<boolean> {
  return (await modal(title, `<p>${esc(message)}</p>`, { submit, danger })) !== null;
}

export interface Approval {
  username: string;
  password: string;
}

async function askManager(message: string, withReason = false): Promise<{ approval: Approval; reason?: string } | null> {
  const res = await modal(
    'Manager sign-off',
    `<p>${esc(message)}</p>
     ${withReason ? '<label>Reason<input name="reason" required minlength="3" maxlength="500"></label>' : ''}
     <label>Manager username<input name="username" autocomplete="off" required></label>
     <label>Password<input name="password" type="password" autocomplete="off" required></label>`,
    { submit: 'Approve' },
  );
  if (!res) return null;
  return { approval: { username: res.username, password: res.password }, reason: res.reason };
}

/**
 * Runs an action and handles the server's questions: a manager sign-off
 * (approval_required), a warning to confirm (warning), or a liquor-hours
 * override with a reason (liquor_hours). Each retry is a new request.
 * Returns null if the user gave up.
 */
export async function withSignOff<T>(run: (extra: Record<string, unknown>) => Promise<T>): Promise<T | null> {
  let extra: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await run(extra);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === 'approval_required' || err.code === 'approval_rejected') {
        const m = await askManager(err.code === 'approval_rejected' ? `${err.message}. Try again.` : err.message);
        if (!m) return null;
        extra = { ...extra, approval: m.approval };
      } else if (err.code === 'warning') {
        if (!(await confirmBox('Please confirm', err.message, 'Continue'))) return null;
        extra = { ...extra, acknowledgeWarnings: true };
      } else if (err.code === 'liquor_hours') {
        const m = await askManager(err.message, true);
        if (!m) return null;
        extra = { ...extra, liquorOverrideReason: m.reason, approval: m.approval };
      } else {
        throw err;
      }
    }
  }
  return null;
}

/** Shows an error from any action as a toast; returns true if it was handled. */
export function showError(err: unknown): void {
  toast(err instanceof Error ? err.message : String(err), 'error');
}

/** Opens printable HTML (receipt, ticket) in a new window and prints it. */
export function printHtml(html: string): void {
  const w = window.open('', '_blank');
  if (!w) {
    toast('Allow pop-ups to print', 'error');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}
