import { Money } from '@hotel/shared';

/**
 * ESC/POS for Epson receipt and kitchen printers (INT-04). YeaStay renders
 * every slip to bytes here, so the POS bridge at the property only passes
 * them to the printer and needs no knowledge of layouts.
 *
 * Text is plain ASCII: Epson's default code page differs between models, so
 * accented letters are simplified and anything else becomes "?".
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ESC = 0x1b;
const GS = 0x1d;

export class EscPos {
  private readonly bytes: number[] = [ESC, 0x40]; // initialise
  constructor(readonly columns: number) {}

  /** Characters per line at the current size. */
  private width = 1;

  text(s: string): this {
    for (const ch of ascii(s)) this.bytes.push(ch.charCodeAt(0));
    return this;
  }

  line(s = ''): this {
    return this.text(s).raw(0x0a);
  }

  raw(...b: number[]): this {
    this.bytes.push(...b);
    return this;
  }

  align(a: 'left' | 'center' | 'right'): this {
    return this.raw(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  /** Double width and height (kitchen tickets read at arm's length). */
  big(on: boolean): this {
    this.width = on ? 2 : 1;
    return this.raw(GS, 0x21, on ? 0x11 : 0x00);
  }

  /** White on black, for REPRINT and CANCEL banners. */
  inverse(on: boolean): this {
    return this.raw(GS, 0x42, on ? 1 : 0);
  }

  rule(ch = '-'): this {
    return this.line(ch.repeat(this.cols()));
  }

  /** Left text and right-aligned amount on one line; the left side wraps when too long. */
  pair(left: string, right: string): this {
    const cols = this.cols();
    const r = ascii(right);
    const room = Math.max(1, cols - r.length - 1);
    const parts = wrap(ascii(left), room);
    parts.slice(0, -1).forEach((p) => this.line(p));
    const last = parts[parts.length - 1] ?? '';
    return this.line(last + ' '.repeat(Math.max(1, cols - last.length - r.length)) + r);
  }

  /** Wrapped paragraph at the current size. */
  para(s: string, indent = ''): this {
    for (const p of wrap(ascii(s), this.cols() - indent.length)) this.line(indent + p);
    return this;
  }

  /** Feed and partial cut. */
  cut(): this {
    return this.raw(ESC, 0x64, 4, GS, 0x56, 0x42, 0x00);
  }

  cols(): number {
    return Math.floor(this.columns / this.width);
  }

  toBase64(): string {
    return Buffer.from(this.bytes).toString('base64');
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}

export function columnsFor(paperMm: number): number {
  return paperMm === 58 ? 32 : 48;
}

const ACCENTS: Record<string, string> = { '×': 'x', '·': '-', '−': '-', '–': '-', '—': '-', '’': "'", '‘': "'", '“': '"', '”': '"', '…': '...', '•': '*' };

export function ascii(s: unknown): string {
  return String(s ?? '')
    .replace(/[×·−–—’‘“”…•]/g, (c) => ACCENTS[c])
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?');
}

export function wrap(s: string, width: number): string[] {
  if (width < 1) return [s];
  const out: string[] = [];
  let cur = '';
  for (const word of s.split(' ')) {
    let w = word;
    while (w.length > width) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

const money = (v: unknown) => (v === null || v === undefined || v === '' ? '' : Money.of(String(v)).format().replace(/^KES /, ''));
const qty = (v: unknown) => String(Number(v));
const label = (s: string) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Kitchen or bar ticket (POS-07): large items, table first, REPRINT and CANCEL banners. */
export function escposTicket(ticket: Json, paperMm: number): EscPos {
  const c = ticket.content as Json;
  const cancel = c.kind === 'cancellation';
  const p = new EscPos(columnsFor(paperMm));
  if (ticket.printNo > 1) p.align('center').inverse(true).bold(true).line(` REPRINT #${ticket.printNo} `).inverse(false).bold(false);
  p.align('center').bold(true).big(true);
  if (cancel) p.inverse(true).line(' CANCEL ').inverse(false);
  else p.line((c.station?.name ?? label(ticket.route ?? c.route ?? 'Kitchen')).toUpperCase());
  p.line(c.table ? `TABLE ${c.table}` : c.room ? `ROOM ${c.room}` : String(c.tab ?? label(c.serviceType)));
  p.big(false).bold(false).align('left');
  p.line(`${c.outlet?.name ?? ''} - ${ticket.number}`);
  p.line(`Check ${c.checkNumber} - ${c.server} - Covers ${c.covers}`);
  p.line(String(c.time ?? ''));
  if (cancel && c.reason) p.para(`Reason: ${c.reason}`);
  p.rule();
  p.big(true).bold(true);
  for (const l of (c.lines ?? []) as Json[]) {
    p.para(`${qty(l.quantity)} x ${l.name}`);
    p.big(false);
    for (const m of (l.modifiers ?? []) as string[]) p.para(`+ ${m}`, '   ');
    if (l.notes) p.para(`NOTE: ${l.notes}`, '   ');
    p.big(true);
  }
  p.big(false).bold(false).rule();
  return p.cut();
}

/** Guest bill or receipt (POS-10), the same content as the browser slip. */
export function escposCheck(check: Json, property: Json, paperMm: number, print?: { printNo: number; changed: boolean }): EscPos {
  const closed = check.status === 'closed';
  const title = check.status === 'void' ? 'VOID' : closed ? 'RECEIPT' : 'BILL';
  const p = new EscPos(columnsFor(paperMm));
  p.align('center').bold(true).big(true).line(String(property.name ?? '')).big(false).bold(false);
  p.line(String(check.outletName ?? ''));
  if (property.phone) p.line(String(property.phone));
  if (property.kraPin) p.line(`KRA PIN ${property.kraPin}`);
  p.bold(true).line(title).bold(false);
  if (print && print.printNo > 1) {
    p.inverse(true).bold(true).line(print.changed ? ` UPDATED ${title} - PRINT ${print.printNo} ` : ` REPRINT #${print.printNo - 1} - COPY `).inverse(false).bold(false);
  }
  p.align('left');
  p.line(`Check ${check.number}${check.tableCode ? ` - Table ${check.tableCode}` : ''}${check.tabName ? ` - ${check.tabName}` : ''}`);
  p.line(`${label(check.serviceType)}${check.roomNumber ? ` - Room ${check.roomNumber}` : ''} - Covers ${check.covers}`);
  p.line(`Server ${check.waiter} - ${check.businessDate}`);
  p.rule();
  const live = ((check.lines ?? []) as Json[]).filter((l) => l.status !== 'cancelled' && l.status !== 'wasted');
  if (!live.length) p.line('No items');
  const taxes = new Map<string, { rate: string; amount: Money }>();
  for (const l of live) {
    p.pair(`${qty(l.quantity)} x ${l.name}`, money(l.amount));
    for (const m of (l.modifiers ?? []) as Json[]) p.para(`+ ${m.name}`, '  ');
    const disc = Money.of(String(l.discountAmount ?? '0')).add(String(l.ruleDiscount ?? '0'));
    if (!disc.isZero()) p.pair(`  ${l.isComp ? 'Complimentary' : 'Discount'}`, `-${money(disc.toString())}`);
    for (const x of (l.taxes ?? []) as Json[]) {
      const prev = taxes.get(x.code);
      taxes.set(x.code, { rate: x.ratePercent, amount: (prev?.amount ?? Money.zero()).add(String(x.amount)) });
    }
  }
  p.rule();
  const t = check.totals as Json;
  p.bold(true).pair('TOTAL KES', money(t.total)).bold(false);
  for (const [code, v] of taxes) p.pair(`${code} ${Number(v.rate)}% incl.`, money(v.amount.toString()));
  for (const pay of ((check.payments ?? []) as Json[]).filter((x) => x.status !== 'failed')) {
    p.pair(`${label(pay.tender)}${pay.reference ? ` ${pay.reference}` : ''}${pay.status === 'pending' ? ' (pending)' : ''}`, money(pay.amount));
    if (pay.tendered) p.line(`  Tendered ${money(pay.tendered)} - Change ${money(pay.change)}`);
  }
  if (check.roomCharge) p.pair(`Charged to room ${check.roomCharge.stayNumber}`, money(check.roomCharge.amount));
  if (check.houseAccount) p.pair(`House account ${check.houseAccount.name}`, money(check.houseAccount.amount));
  for (const r of (check.refunds ?? []) as Json[]) p.pair(`Refund ${r.number} (${label(r.tender)})`, `-${money(r.amount)}`);
  if (check.status === 'open') p.bold(true).pair('BALANCE DUE', money(t.balance)).bold(false);
  if (check.roomCharge) {
    p.rule();
    p.line(`Room ${check.roomNumber ?? ''} - ${check.guestName ?? ''}`);
    p.line(`Acknowledged: ${check.roomCharge.signedName} (${label(check.roomCharge.acknowledgementMethod)})`);
  }
  p.rule().align('center');
  p.line('Prices include VAT and catering levy.');
  p.line('Fiscal receipt: TIMS integration pending.');
  p.line('Thank you - Powered by YeaStay');
  return p.cut();
}

/** A test page for setting up a printer. */
export function escposTest(printer: { name: string; code: string; paperMm: number }, propertyName: string, at: string): EscPos {
  const p = new EscPos(columnsFor(printer.paperMm));
  p.align('center').bold(true).big(true).line('TEST PRINT').big(false).bold(false);
  p.line(propertyName).line(`${printer.name} (${printer.code})`).line(at);
  p.align('left').rule();
  p.line('If you can read this, YeaStay can print here.');
  p.line('1234567890'.repeat(Math.ceil(p.cols() / 10)).slice(0, p.cols()));
  p.rule();
  return p.cut();
}
