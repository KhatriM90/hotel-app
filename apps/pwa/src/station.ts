/**
 * Kitchen and bar ticket screen (POS-07; the full kitchen display is POS-14,
 * phase 2). Shows the station's open tickets oldest first, lets the team bump
 * them preparing → ready → done, and prints or reprints tickets (a reprint is
 * numbered and says REPRINT on paper).
 */
import { api, OfflineError } from './api';
import { esc, modal, printHtml, showError, toast } from './ui';

interface Ticket {
  id: string;
  number: string;
  kind: 'order' | 'cancellation';
  status: 'new' | 'preparing' | 'ready' | 'done';
  createdAt: string;
  prints: number;
  content: {
    outlet: { name: string };
    checkNumber: string;
    table: string | null;
    tab: string | null;
    room: string | null;
    server: string;
    covers: number;
    reason: string | null;
    lines: Array<{ quantity: string; name: string; modifiers: string[]; notes: string | null }>;
  };
}

const NEXT: Record<string, { status: string; label: string } | undefined> = {
  new: { status: 'preparing', label: 'Start' },
  preparing: { status: 'ready', label: 'Ready' },
  ready: { status: 'done', label: 'Collected' },
};

export class StationApp {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Set<string>();

  constructor(
    private readonly root: HTMLElement,
    private readonly property: string,
    private readonly station: { code: string; name: string },
    private readonly onExit: () => void,
  ) {}

  private get pos() {
    return `/properties/${this.property}/pos`;
  }

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 10_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    let tickets: Ticket[];
    try {
      tickets = await api.get<Ticket[]>(`${this.pos}/stations/${this.station.code}/tickets`);
    } catch (err) {
      if (!(err instanceof OfflineError)) showError(err);
      return;
    }
    const fresh = tickets.filter((t) => !this.seen.has(t.id));
    if (this.seen.size && fresh.length) beep();
    fresh.forEach((t) => this.seen.add(t.id));
    this.render(tickets);
  }

  private render(tickets: Ticket[]): void {
    const age = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    this.root.innerHTML = `
      <div class="bar">
        <button class="ghost" data-exit>‹ Back</button>
        <h1>${esc(this.station.name)}</h1>
        <span class="muted">${tickets.length} open ticket(s) · refreshes every 10 s</span>
      </div>
      <div class="tickets">
        ${tickets
          .map((t) => {
            const c = t.content;
            const next = t.kind === 'cancellation' ? { status: 'done', label: 'Seen' } : NEXT[t.status];
            const mins = age(t.createdAt);
            return `<article class="ticket ${t.kind} st-${t.status} ${mins >= 20 ? 'late' : ''}">
              <header>
                <strong>${esc(c.table ? `Table ${c.table}` : c.room ? `Room ${c.room}` : c.tab ?? 'Counter')}</strong>
                <span>${mins} min</span>
              </header>
              <p class="muted">${esc(c.outlet.name)} · ${esc(c.server)} · ${esc(t.number)}${t.prints > 1 ? ` · printed ${t.prints}×` : ''}</p>
              ${t.kind === 'cancellation' ? `<p class="cancel">CANCEL${c.reason ? `: ${esc(c.reason)}` : ''}</p>` : ''}
              <ul>${c.lines
                .map((l) => `<li><b>${Number(l.quantity)}×</b> ${esc(l.name)}${l.modifiers.length ? `<small>${l.modifiers.map(esc).join(', ')}</small>` : ''}${l.notes ? `<small class="note">${esc(l.notes)}</small>` : ''}</li>`)
                .join('')}</ul>
              <footer>
                ${next ? `<button class="primary" data-bump="${esc(t.id)}" data-to="${next.status}">${next.label}</button>` : ''}
                <button class="ghost" data-print="${esc(t.id)}">Print</button>
                <button class="ghost" data-reprint="${esc(t.id)}">Reprint</button>
              </footer>
            </article>`;
          })
          .join('') || '<p class="muted center">No open tickets.</p>'}
      </div>`;
    this.root.querySelector('[data-exit]')!.addEventListener('click', () => {
      this.stop();
      this.onExit();
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-bump]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await api.post(`${this.pos}/tickets/${b.dataset.bump}/status`, { status: b.dataset.to });
          await this.refresh();
        } catch (err) {
          showError(err);
        }
      }),
    );
    this.root.querySelectorAll<HTMLButtonElement>('[data-print]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          printHtml(await api.html(`${this.pos}/tickets/${b.dataset.print}/print`));
        } catch (err) {
          showError(err);
        }
      }),
    );
    this.root.querySelectorAll<HTMLButtonElement>('[data-reprint]').forEach((b) =>
      b.addEventListener('click', async () => {
        const res = await modal('Reprint ticket', '<label>Reason<input name="reason" required minlength="3" maxlength="500" placeholder="e.g. printer jam"></label>', { submit: 'Reprint' });
        if (!res) return;
        try {
          await api.post(`${this.pos}/tickets/${b.dataset.reprint}/reprint`, { reason: res.reason });
          printHtml(await api.html(`${this.pos}/tickets/${b.dataset.reprint}/print`));
          toast('Reprinted', 'ok');
        } catch (err) {
          showError(err);
        }
      }),
    );
  }
}

function beep(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch {
    /* sound is a nicety */
  }
}
