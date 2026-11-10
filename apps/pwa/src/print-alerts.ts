/**
 * Failed-print alerts (INT-04; Kahama meeting item 2.4). A ticket or bill the
 * printer did not print after three tries shows as a red banner on the
 * waiter's outlet screen and on the kitchen/bar station screen until someone
 * reprints it or marks it dealt with. A new alert beeps.
 */
import { api, OfflineError } from './api';
import { esc, showError, toast } from './ui';

export interface PrintAlert {
  id: string;
  kind: 'ticket' | 'bill' | 'receipt' | 'test';
  title: string;
  printer: string;
  error: string | null;
  failedAt: string;
  outlet: string | null;
  replacedById: string | null;
  replacedByStatus: string | null;
  replacedByPrinter: string | null;
}

/** One line a waiter can act on, e.g. "Ticket KM-TKT-12 did not print on Kitchen: Paper out. Printed on Bar instead." */
export function alertText(a: PrintAlert): string {
  let s = `${a.title} did not print on ${a.printer}`;
  if (a.error) s += `: ${a.error.replace(/ Sent to .+ instead\.$/, '')}`;
  if (!/[.!?]$/.test(s)) s += '.';
  if (a.replacedById) {
    const where = a.replacedByPrinter ?? 'the backup printer';
    s += a.replacedByStatus === 'printed' ? ` Printed on ${where} instead.` : a.replacedByStatus === 'failed' ? ` ${where} failed too.` : ` Sending to ${where} instead.`;
  }
  return s;
}

export class PrintAlerts {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Set<string>();
  private readonly el: HTMLElement;

  /** `filter` is outlet=CODE (waiter screen) or station=CODE (kitchen/bar screen). */
  constructor(private readonly property: string, private readonly filter: { outlet?: string; station?: string }) {
    this.el = document.createElement('section');
    this.el.className = 'print-alerts';
    this.el.setAttribute('role', 'alert');
    this.el.hidden = true;
  }

  private get pos() {
    return `/properties/${this.property}/pos`;
  }

  start(): void {
    if (!this.el.isConnected) document.body.appendChild(this.el);
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 15_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.el.remove();
  }

  async refresh(): Promise<void> {
    const qs = this.filter.outlet ? `outlet=${encodeURIComponent(this.filter.outlet)}` : `station=${encodeURIComponent(this.filter.station ?? '')}`;
    let alerts: PrintAlert[];
    try {
      alerts = await api.get<PrintAlert[]>(`${this.pos}/print-alerts?${qs}`);
    } catch (err) {
      if (!(err instanceof OfflineError)) console.warn('print alerts', err);
      return;
    }
    if (alerts.some((a) => !this.seen.has(a.id))) beep();
    alerts.forEach((a) => this.seen.add(a.id));
    this.render(alerts);
  }

  private render(alerts: PrintAlert[]): void {
    this.el.hidden = !alerts.length;
    this.el.innerHTML = alerts
      .map(
        (a) => `<div class="print-alert">
          <p><strong>Not printed.</strong> ${esc(alertText(a))}</p>
          <div>
            <button class="danger" data-retry="${esc(a.id)}">Print again</button>
            <button class="ghost" data-ack="${esc(a.id)}" title="The kitchen or bar has the order another way">Done</button>
          </div>
        </div>`,
      )
      .join('');
    this.el.querySelectorAll<HTMLButtonElement>('[data-retry]').forEach((b) =>
      b.addEventListener('click', () => this.act(b, `print-jobs/${b.dataset.retry}/retry`, 'Sent to the printer again')),
    );
    this.el.querySelectorAll<HTMLButtonElement>('[data-ack]').forEach((b) =>
      b.addEventListener('click', () => this.act(b, `print-jobs/${b.dataset.ack}/acknowledge`, 'Marked as dealt with')),
    );
  }

  private async act(b: HTMLButtonElement, path: string, done: string): Promise<void> {
    b.disabled = true;
    try {
      await api.post(`${this.pos}/${path}`, {});
      toast(done, 'ok');
    } catch (err) {
      showError(err);
    }
    await this.refresh();
  }
}

function beep(): void {
  try {
    const ctx = new AudioContext();
    for (const [at, f] of [[0, 660], [0.25, 440]] as const) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      osc.connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.2);
    }
  } catch {
    /* sound is a nicety */
  }
}
