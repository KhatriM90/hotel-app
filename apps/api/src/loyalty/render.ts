import { Money } from '@hotel/shared';
import QRCode from 'qrcode';
import { esc } from '../frontoffice/render';

/**
 * Member card and the member's own page (LOY23). The card carries a QR code
 * the POS scans to identify and verify the member; the page shows balances,
 * expiring points, wallet credit and the statement without signing in.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const money = (v: unknown) => (v === null || v === undefined || v === '' ? '' : Money.of(String(v)).format().replace(/^KES /, ''));
const label = (s: string) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const day = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' }) : '');

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 15px/1.45 Outfit, system-ui, -apple-system, 'Segoe UI', sans-serif; color: #0B2E31; margin: 0; background: #F3F7F7; }
  main { max-width: 440px; margin: 0 auto; padding: 16px; }
  .card { background: linear-gradient(135deg, #0E4D52, #0B2E31); color: #fff; border-radius: 16px; padding: 20px; box-shadow: 0 8px 24px rgba(11,46,49,.25); }
  .card .brand { font-weight: 700; letter-spacing: .04em; }
  .card .brand b { color: #E8A33D; }
  .card .num { font: 600 20px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing: .08em; margin: 18px 0 4px; }
  .card .tier { display: inline-block; background: #E8A33D; color: #0B2E31; border-radius: 99px; padding: 2px 10px; font-size: 12px; font-weight: 700; }
  .qr { background: #fff; border-radius: 12px; padding: 12px; margin: 16px auto 0; width: 220px; }
  .qr svg { display: block; width: 100%; height: auto; }
  .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 16px 0; }
  .tile { background: #fff; border-radius: 12px; padding: 12px; }
  .tile small { display: block; color: #4A6668; }
  .tile b { font-size: 22px; }
  h2 { font-size: 16px; margin: 20px 0 8px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; }
  td { padding: 8px 10px; border-bottom: 1px solid #E3ECEC; font-size: 14px; vertical-align: top; }
  td.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .neg { color: #A3361F; }
  .muted { color: #4A6668; font-size: 13px; }
  footer { text-align: center; color: #4A6668; font-size: 12px; margin: 24px 0; }
  .print { margin-top: 12px; }
  @media print { .print { display: none; } body { background: #fff; } }
</style></head><body><main>${body}<footer>YeaStay Rewards</footer></main></body></html>`;
}

async function qrSvg(payload: string): Promise<string> {
  return QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 0, color: { dark: '#0B2E31', light: '#ffffff' } });
}

/** Printable or on-screen member card with the scan code (LOY11, LOY13). */
export async function renderCard(c: { number: string; name: string; tier: string | null; qr: string }): Promise<string> {
  return page(
    `Member card ${c.number}`,
    `<div class="card">
  <div class="brand">Yea<b>Stay</b> Rewards</div>
  <div class="num">${esc(c.number)}</div>
  <div>${esc(c.name)} ${c.tier ? `<span class="tier">${esc(c.tier)}</span>` : ''}</div>
  <div class="qr">${await qrSvg(c.qr)}</div>
</div>
<p class="muted">Show this code at the till to collect and use points. Staff scan it to confirm it is you before using your balance.</p>
<button class="print" onclick="window.print()">Print card</button>`,
  );
}

const TYPE_LABEL: Record<string, string> = {
  earn: 'Earned', credit: 'Cashback credited', redeem: 'Used', restore: 'Restored (return)', reverse: 'Reversed (return)',
  adjust: 'Adjustment', expire: 'Expired', merge_in: 'Moved in (merge)', merge_out: 'Moved out (merge)',
};

/** The member's own page from the secure link (LOY23). */
export async function renderSelfService(d: Json): Promise<string> {
  const p = d.balances.points;
  const w = d.balances.wallet;
  const rows = (d.events as Json[])
    .map((e) => {
      const amt = e.unit === 'points' ? `${Number(e.amount) > 0 ? '+' : ''}${Number(e.amount).toLocaleString('en-KE')} pts` : `${Number(e.amount) > 0 ? '+' : '−'}KES ${money(String(e.amount).replace('-', ''))}`;
      return `<tr><td>${esc(day(e.at))}<div class="muted">${esc(TYPE_LABEL[e.type] ?? label(e.type))}${e.outlet ? ` · ${esc(e.outlet)}` : e.property ? ` · ${esc(e.property)}` : ''}</div></td>
<td class="n ${Number(e.amount) < 0 ? 'neg' : ''}">${esc(amt)}</td></tr>`;
    })
    .join('');
  const expiring = p.expiring?.[0] ? `<p class="muted">${Number(p.expiring[0].amount).toLocaleString('en-KE')} points expire on ${esc(day(p.expiring[0].date))}.</p>` : '';
  return page(
    `YeaStay Rewards ${d.number}`,
    `<div class="card"><div class="brand">Yea<b>Stay</b> Rewards</div><div class="num">${esc(d.number)}</div>
<div>Hello ${esc(d.firstName)} ${d.club ? `<span class="tier">${esc(d.club.tierCode)} · ${esc(Number(d.club.discountPercent))}% off or ${esc(Number(d.club.cashbackPercent))}% back</span>` : ''}</div></div>
<div class="tiles">
  <div class="tile"><small>Points</small><b>${Number(p.available).toLocaleString('en-KE')}</b><small>worth KES ${money(String(Math.max(0, Number(p.available)) * Number(d.pointValue)))}</small></div>
  <div class="tile"><small>Wallet credit</small><b>${money(w.available)}</b><small>KES${Number(w.pendingCashback) ? ` · ${money(w.pendingCashback)} cashback this month` : ''}</small></div>
</div>
${expiring}
${Number(p.pendingEligible) ? `<p class="muted">Points on room charges are added when your stay is settled.</p>` : ''}
<h2>Statement</h2>
<table>${rows || '<tr><td class="muted">No activity yet</td></tr>'}</table>`,
  );
}
