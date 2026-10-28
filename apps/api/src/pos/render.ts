import { Money } from '@hotel/shared';
import { esc } from '../frontoffice/render';

/**
 * Printable POS slips (POS-07, POS-10, POS day close). Narrow 80 mm layout so a
 * receipt printer or any browser prints them; the property's name leads and
 * YeaStay is a small footer. eTIMS fiscal data (INT-02) is not yet on the
 * receipt: it says so until the integration exists.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const money = (v: unknown) => (v === null || v === undefined || v === '' ? '' : Money.of(String(v)).format().replace(/^KES /, ''));
const qty = (v: unknown) => String(Number(v));
const label = (s: string) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function slip(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 13px/1.35 ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace; color: #000; margin: 0; background: #fff; }
  .slip { width: 76mm; margin: 12px auto; padding: 4mm; }
  h1 { font-size: 16px; text-align: center; margin: 0 0 2px; }
  h2 { font-size: 14px; text-align: center; margin: 6px 0; letter-spacing: .06em; }
  .c { text-align: center; }
  .big { font-size: 18px; font-weight: 700; }
  .reprint { border: 2px solid #000; text-align: center; font-weight: 700; padding: 2px; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  td.n { text-align: right; white-space: nowrap; padding-left: 6px; }
  .sub { font-size: 11px; padding-left: 12px; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  .strong td { font-weight: 700; }
  .x { text-decoration: line-through; }
  footer { margin-top: 8px; font-size: 10px; text-align: center; }
  .print { position: fixed; top: 8px; right: 8px; }
  @media print { .print { display: none; } .slip { margin: 0; } @page { size: 80mm auto; margin: 0; } }
</style></head>
<body><button class="print" onclick="window.print()">Print</button><div class="slip">
${body}
</div></body></html>`;
}

function header(property: Json, outletName: string): string {
  return `<h1>${esc(property.name)}</h1>
<div class="c">${esc(outletName)}</div>
${property.phone ? `<div class="c">${esc(property.phone)}</div>` : ''}
${property.kraPin ? `<div class="c">KRA PIN ${esc(property.kraPin)}</div>` : ''}`;
}

/** Guest bill before payment, or receipt once closed (POS-10). */
export function renderCheck(check: Json, property: Json): string {
  const closed = check.status === 'closed';
  const title = check.status === 'void' ? 'VOID' : closed ? 'RECEIPT' : 'BILL';
  const live = (check.lines as Json[]).filter((l) => l.status !== 'cancelled' && l.status !== 'wasted');
  const lines = live
    .map((l) => {
      const mods = (l.modifiers ?? []).map((m: Json) => `<div class="sub">+ ${esc(m.name)}</div>`).join('');
      const disc = Number(l.discountAmount) || Number(l.ruleDiscount)
        ? `<div class="sub">${l.isComp ? 'Complimentary' : 'Discount'} −${money(Money.of(String(l.discountAmount)).add(String(l.ruleDiscount)).toString())}</div>`
        : '';
      return `<tr><td>${qty(l.quantity)} × ${esc(l.name)}${mods}${disc}</td><td class="n">${money(l.amount)}</td></tr>`;
    })
    .join('');
  const t = check.totals as Json;
  const taxes = new Map<string, { rate: string; amount: Money }>();
  for (const l of live) {
    for (const x of (l.taxes ?? []) as Json[]) {
      const prev = taxes.get(x.code);
      taxes.set(x.code, { rate: x.ratePercent, amount: (prev?.amount ?? Money.zero()).add(String(x.amount)) });
    }
  }
  const taxRows = [...taxes.entries()]
    .map(([code, v]) => `<tr><td>${esc(code)} ${esc(Number(v.rate))}% incl.</td><td class="n">${money(v.amount.toString())}</td></tr>`)
    .join('');
  const pays = (check.payments as Json[])
    .filter((p) => p.status !== 'failed')
    .map((p) => `<tr><td>${esc(label(p.tender))}${p.reference ? ` ${esc(p.reference)}` : ''}${p.status === 'pending' ? ' (pending)' : ''}</td><td class="n">${money(p.amount)}</td></tr>${
      p.tendered ? `<tr><td class="sub">Tendered ${money(p.tendered)} · Change ${money(p.change)}</td><td></td></tr>` : ''
    }`)
    .join('');
  const room = check.roomCharge
    ? `<tr><td>Charged to room ${esc(check.roomCharge.stayNumber)}</td><td class="n">${money(check.roomCharge.amount)}</td></tr>`
    : '';
  const house = check.houseAccount ? `<tr><td>House account ${esc(check.houseAccount.name)}</td><td class="n">${money(check.houseAccount.amount)}</td></tr>` : '';
  const refunds = (check.refunds as Json[]).map((r) => `<tr><td>Refund ${esc(r.number)} (${esc(label(r.tender))})</td><td class="n">−${money(r.amount)}</td></tr>`).join('');
  const sign = check.roomCharge
    ? `<hr><div>Room ${esc(check.roomNumber ?? '')} · ${esc(check.guestName ?? '')}</div><div>Acknowledged: ${esc(check.roomCharge.signedName)} (${esc(
        label(check.roomCharge.acknowledgementMethod),
      )})</div>`
    : '';
  return slip(
    `${title} ${check.number}`,
    `${header(property, check.outletName)}
<h2>${title}</h2>
<div>Check ${esc(check.number)}${check.tableCode ? ` · Table ${esc(check.tableCode)}` : ''}${check.tabName ? ` · ${esc(check.tabName)}` : ''}</div>
<div>${esc(label(check.serviceType))}${check.roomNumber ? ` · Room ${esc(check.roomNumber)}` : ''} · Covers ${esc(check.covers)}</div>
<div>Server ${esc(check.waiter)} · ${esc(check.businessDate)}</div>
<hr><table>${lines || '<tr><td>No items</td></tr>'}</table><hr>
<table>
<tr class="strong"><td>TOTAL KES</td><td class="n">${money(t.total)}</td></tr>
${taxRows}
${pays}${room}${house}${refunds}
${!closed && check.status === 'open' ? `<tr class="strong"><td>BALANCE DUE</td><td class="n">${money(t.balance)}</td></tr>` : ''}
</table>
${sign}
<hr><div class="c">Prices include VAT and catering levy.</div>
<div class="c">eTIMS fiscal receipt not yet issued (integration pending).</div>
<footer>Thank you · Powered by YeaStay</footer>`,
  );
}

/** Kitchen or bar ticket (POS-07). A second or later print says REPRINT #n. */
export function renderTicket(ticket: Json): string {
  const c = ticket.content as Json;
  const cancel = c.kind === 'cancellation';
  const lines = (c.lines as Json[])
    .map((l) => `<tr><td class="big${cancel ? ' x' : ''}">${qty(l.quantity)} × ${esc(l.name)}</td></tr>${(l.modifiers ?? []).map((m: string) => `<tr><td class="sub">+ ${esc(m)}</td></tr>`).join('')}${
      l.notes ? `<tr><td class="sub">NOTE: ${esc(l.notes)}</td></tr>` : ''
    }`)
    .join('');
  return slip(
    `${ticket.number}`,
    `${ticket.printNo > 1 ? `<div class="reprint">REPRINT #${esc(ticket.printNo)}</div>` : ''}
<h2>${cancel ? '*** CANCEL ***' : esc((c.station?.name ?? label(ticket.route ?? c.route ?? 'Kitchen')).toUpperCase())}</h2>
<div class="big c">${c.table ? `TABLE ${esc(c.table)}` : c.room ? `ROOM ${esc(c.room)}` : esc(c.tab ?? label(c.serviceType))}</div>
<div>${esc(c.outlet?.name)} · ${esc(ticket.number)}</div>
<div>Check ${esc(c.checkNumber)} · ${esc(c.server)} · Covers ${esc(c.covers)}</div>
<div>${esc(c.time)}</div>
${cancel && c.reason ? `<div>Reason: ${esc(c.reason)}</div>` : ''}
<hr><table>${lines}</table><hr>
<footer>Powered by YeaStay</footer>`,
  );
}

/** Z report: the frozen totals of a closed outlet day, or running totals of an open one (X). */
export function renderDayReport(day: Json, property: Json): string {
  const t = (day.totals ?? {}) as Json;
  const closed = day.status === 'closed';
  if (t.empty) {
    return slip(`Z ${day.outletCode} ${day.businessDate}`, `${header(property, day.outletName)}<h2>Z REPORT</h2><div>${esc(day.businessDate)}</div><hr><div class="c">No trading</div>`);
  }
  const rows = (xs: Json[] | undefined, name: (x: Json) => string, amount = 'amount') =>
    (xs ?? []).map((x) => `<tr><td>${esc(name(x))}</td><td class="n">${money(x[amount])}</td></tr>`).join('');
  return slip(
    `${closed ? 'Z' : 'X'} ${day.outletCode} ${day.businessDate}`,
    `${header(property, day.outletName)}
<h2>${closed ? 'Z REPORT' : 'X REPORT (DAY OPEN)'}</h2>
<div>Trading day ${esc(day.businessDate)}</div>
<div>Opened ${esc(day.openedAt)}</div>
${closed ? `<div>Closed ${esc(day.closedAt)} by ${esc(day.closedBy)}</div>` : ''}
<hr><table>
<tr><td>Checks closed</td><td class="n">${esc(t.checks?.closed)}</td></tr>
<tr><td>Checks voided</td><td class="n">${esc(t.checks?.void)}</td></tr>
<tr><td>Covers</td><td class="n">${esc(t.checks?.covers)}</td></tr>
</table><hr><table>
<tr><td>Gross sales</td><td class="n">${money(t.grossSales)}</td></tr>
<tr><td>Happy hour / rules</td><td class="n">−${money(t.ruleDiscounts)}</td></tr>
<tr><td>Discounts</td><td class="n">−${money(t.discounts)}</td></tr>
<tr><td>Complimentary</td><td class="n">−${money(t.comps)}</td></tr>
<tr class="strong"><td>NET SALES (incl. tax)</td><td class="n">${money(t.netSales)}</td></tr>
<tr><td>Net of tax</td><td class="n">${money(t.netExTax)}</td></tr>
${rows(t.taxes, (x) => `${x.taxCode} ${Number(x.ratePercent)}%`, 'taxAmount')}
</table><hr><div>SETTLEMENTS</div><table>
${rows(t.settlements?.payments, (x) => `${label(x.tender)} (${x.count})`)}
<tr><td>Room charges (${esc(t.settlements?.roomCharges?.count)})</td><td class="n">${money(t.settlements?.roomCharges?.amount)}</td></tr>
<tr class="strong"><td>Total settled</td><td class="n">${money(t.settlements?.total)}</td></tr>
<tr><td>Difference</td><td class="n">${money(t.reconciliation?.difference)}</td></tr>
</table><hr><table>
<tr><td>Refunds</td><td class="n">−${money(t.refunds?.total)}</td></tr>
<tr><td>House accounts (not revenue)</td><td class="n">${money(t.houseAccounts?.total)}</td></tr>
${rows(t.houseAccounts?.accounts, (x) => `  ${x.name}`)}
<tr><td>Cancelled lines (${esc(t.corrections?.cancelled?.lines)})</td><td class="n">${money(t.corrections?.cancelled?.listValue)}</td></tr>
<tr><td>Waste lines (${esc(t.corrections?.wasted?.lines)})</td><td class="n">${money(t.corrections?.wasted?.listValue)}</td></tr>
</table><hr><div>BY CATEGORY</div><table>${rows(t.byCategory, (x) => `${x.name} × ${Number(x.quantity)}`)}</table>
<hr><div>BY SERVER</div><table>${rows(t.byWaiter, (x) => `${x.waiter} (${x.checks})`)}</table>
<footer>Powered by YeaStay</footer>`,
  );
}
