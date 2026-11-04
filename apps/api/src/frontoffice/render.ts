import { Money } from '@hotel/shared';

/**
 * Printable guest documents (FD-04, BIL-09). Plain HTML with print CSS so any
 * browser prints them; the property's own name leads and YeaStay is a small
 * footer (brand rules). Content comes from the frozen document snapshot, so a
 * reprint is identical to the original.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const money = (v: unknown) => (v === null || v === undefined || v === '' ? '' : Money.of(String(v)).format().replace(/^KES /, ''));
const label = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function page(title: string, property: Json, body: string, subtitle = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --ink: #0b2e31; --muted: #4f6264; --line: #d5e1e2; --teal: #0e4d52; }
  * { box-sizing: border-box; }
  body { font: 13px/1.45 'Outfit', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: var(--ink); margin: 0; background: #fff; }
  .sheet { max-width: 800px; margin: 24px auto; padding: 32px; }
  header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid var(--teal); padding-bottom: 12px; margin-bottom: 18px; }
  header h1 { font-size: 22px; margin: 0; color: var(--teal); }
  header .doc { text-align: right; }
  header .doc h2 { margin: 0; font-size: 18px; letter-spacing: .04em; text-transform: uppercase; }
  .muted { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; margin: 10px 0 16px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; margin-bottom: 14px; }
  .grid div span { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .totals { margin-left: auto; width: 320px; }
  .totals td { border: 0; padding: 3px 8px; }
  .totals tr.strong td { font-weight: 700; border-top: 2px solid var(--ink); }
  .terms { white-space: pre-line; font-size: 12px; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 36px; }
  .sign div { border-top: 1px solid var(--ink); padding-top: 4px; font-size: 12px; color: var(--muted); }
  .sign img { max-height: 70px; display: block; }
  .note { font-size: 12px; background: #fff6e5; border: 1px solid #e8a33d; border-radius: 8px; padding: 8px 10px; margin: 12px 0; }
  footer { margin-top: 32px; font-size: 10px; color: var(--muted); text-align: center; }
  .print { position: fixed; top: 12px; right: 12px; }
  @media print { .print { display: none; } .sheet { margin: 0; padding: 0; } }
</style></head>
<body><button class="print" onclick="window.print()">Print</button><div class="sheet">
<header>
  <div><h1>${esc(property.name)}</h1>
    <div class="muted">${esc(property.address || property.location)}</div>
    ${property.phone ? `<div class="muted">${esc(property.phone)}${property.email ? ` · ${esc(property.email)}` : ''}</div>` : ''}
    ${property.kraPin ? `<div class="muted">KRA PIN ${esc(property.kraPin)}</div>` : ''}
  </div>
  <div class="doc"><h2>${esc(title)}</h2>${subtitle}</div>
</header>
${body}
<footer>Powered by YeaStay</footer>
</div></body></html>`;
}

function chargeRows(charges: Json[]): string {
  return charges
    .map(
      (c) => `<tr><td>${esc(c.serviceDate)}</td><td>${esc(c.description)}${c.outletName ? `<div class="muted">${esc(c.outletName)}</div>` : ''}${
        c.reference ? `<div class="muted">Ref ${esc(c.reference)}</div>` : ''
      }</td><td class="num">${esc(Number(c.quantity))}</td><td class="num">${money(c.unitPrice)}</td><td class="num">${
        Number(c.discountAmount) ? money(c.discountAmount) : ''
      }</td><td class="num">${money(c.amount)}</td></tr>`,
    )
    .join('');
}

function chargesTable(charges: Json[]): string {
  return `<table><thead><tr><th>Date</th><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Discount</th><th class="num">Amount</th></tr></thead>
<tbody>${chargeRows(charges) || '<tr><td colspan="6" class="muted">No charges</td></tr>'}</tbody></table>`;
}

function taxTable(taxes: Json[]): string {
  if (!taxes.length) return '';
  return `<table><thead><tr><th>Tax</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">Tax</th></tr></thead><tbody>${taxes
    .map((t) => `<tr><td>${esc(t.name ?? t.taxCode)} (${esc(t.taxCode)})</td><td class="num">${esc(Number(t.ratePercent))}%</td><td class="num">${money(t.taxableAmount)}</td><td class="num">${money(t.taxAmount)}</td></tr>`)
    .join('')}</tbody></table><p class="muted">All prices include VAT and catering levy.</p>`;
}

function paymentRows(payments: Json[]): string {
  return payments
    .map((p) => `<tr><td>${esc(p.receiptNumber ?? (p.tender === 'city_ledger' ? 'Transfer to company account' : ''))}</td><td>${esc(label(p.tender))}${p.isDeposit ? ' (deposit)' : ''}</td><td>${esc(p.reference ?? p.companyName ?? '')}</td><td class="num">${money(p.amount)}</td></tr>`)
    .join('');
}

export function renderDocument(doc: { documentType: string; number: string; content: Json }): string {
  const c = doc.content;
  const sub = `<div><strong>${esc(doc.number)}</strong></div><div class="muted">${esc(new Date(c.issuedAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }))}</div>`;
  if (doc.documentType === 'RECEIPT') {
    return page('Receipt', c.property, `
<div class="grid">
  <div><span>Received from</span>${esc(c.guest)}</div>
  <div><span>Folio / stay</span>${esc(c.folioNumber)} · ${esc(c.stayNumber)}</div>
  <div><span>Booking</span>${esc(c.reservationNumber)}</div>
  <div><span>Business date</span>${esc(c.businessDate)}</div>
</div>
<table class="totals"><tbody>
  <tr><td>${esc(label(c.tender))}${c.reference ? ` · ${esc(c.reference)}` : ''}</td><td class="num">${money(c.amount)}</td></tr>
  <tr class="strong"><td>Amount received${c.isDeposit ? ' (deposit)' : ''}</td><td class="num">KES ${money(c.amount)}</td></tr>
</tbody></table>
<p class="muted">Received by ${esc(c.issuedBy ?? '')}. This receipt is not a tax invoice.</p>`, sub);
  }
  if (doc.documentType === 'PROFORMA') {
    const stays = (c.stays as Json[])
      .map((s) => `<h3>${esc(s.roomType)} · ${esc(s.arrival)} to ${esc(s.departure)}</h3>
<p class="muted">${esc(s.ratePlan)} · ${esc(s.adults)} adult(s)${Number(s.children) ? `, ${esc(s.children)} child(ren)` : ''} · stay ${esc(s.number)}</p>
<table><thead><tr><th>Night</th><th>Season</th><th class="num">Room</th><th class="num">Supplements</th><th class="num">Amount</th></tr></thead><tbody>${(s.nights as Json[])
        .map((n) => `<tr><td>${esc(n.date)}</td><td>${esc(n.seasonName ?? '')}</td><td class="num">${money(n.base)}</td><td class="num">${Number(n.supplement) ? money(n.supplement) : ''}</td><td class="num">${money(n.amount)}</td></tr>`)
        .join('')}</tbody></table>`)
      .join('');
    return page('Pro forma', c.property, `
<div class="grid">
  <div><span>Prepared for</span>${esc(c.booker?.name)}${c.company ? `<br>${esc(c.company.name)}` : ''}${c.agent ? `<br>via ${esc(c.agent.name)}` : ''}</div>
  <div><span>Booking reference</span>${esc(c.reservationNumber)}</div>
</div>
${stays}
<table class="totals"><tbody>
  <tr class="strong"><td>Total accommodation</td><td class="num">KES ${money(c.total)}</td></tr>
  <tr><td>Deposit required</td><td class="num">${money(c.deposit?.required)}</td></tr>
  <tr><td>Deposit due by</td><td class="num">${esc(c.deposit?.dueDate ?? '')}</td></tr>
</tbody></table>
<div class="terms">${esc(c.policy?.refundPolicy ?? '')}</div>
<p class="muted">This pro forma is a quotation, not a tax invoice. Prices include VAT and catering levy.</p>`, sub);
  }
  // INVOICE
  return page('Invoice', c.property, `
<div class="grid">
  <div><span>Bill to</span>${esc(c.company ?? c.guest)}${c.company ? `<br>Guest: ${esc(c.guest)}` : ''}${c.companyPin ? `<br>KRA PIN ${esc(c.companyPin)}` : ''}</div>
  <div><span>Stay</span>${esc(c.stayNumber)} · room ${esc(c.room ?? '')}<br>${esc(c.arrival)} to ${esc(c.departure)}</div>
  <div><span>Folio</span>${esc(c.folioNumber)}</div>
  <div><span>Booking</span>${esc(c.reservationNumber)}</div>
</div>
${chargesTable(c.charges)}
${taxTable(c.taxSummary)}
<table><thead><tr><th>Receipt</th><th>Tender</th><th>Reference</th><th class="num">Amount</th></tr></thead><tbody>${paymentRows(c.payments)}</tbody></table>
<table class="totals"><tbody>
  <tr><td>Total charges</td><td class="num">${money(c.totals.chargesTotal)}</td></tr>
  <tr><td>Payments and transfers</td><td class="num">${money(c.totals.paymentsConfirmed)}</td></tr>
  <tr class="strong"><td>Balance</td><td class="num">KES ${money(c.totals.balance)}</td></tr>
</tbody></table>
${c.fiscal?.status === 'not_submitted' ? `<div class="note">Not yet a KRA TIMS fiscal invoice: ${esc(c.fiscal.note)}.</div>` : ''}`, sub);
}

export function renderStatement(folio: Json, property: Json): string {
  return page('Statement', property, `
<div class="grid">
  <div><span>Guest</span>${esc(folio.guestName)}</div>
  <div><span>Folio / stay</span>${esc(folio.number)} · ${esc(folio.stayNumber)}</div>
  <div><span>Room</span>${esc(folio.roomNumber ?? '')}</div>
  <div><span>Dates</span>${esc(folio.arrivalDate)} to ${esc(folio.departureDate)}</div>
</div>
${chargesTable(folio.charges)}
${taxTable(folio.taxSummary)}
<table><thead><tr><th>Receipt</th><th>Tender</th><th>Reference</th><th class="num">Amount</th></tr></thead><tbody>${paymentRows(
    (folio.payments as Json[]).filter((p) => p.status === 'confirmed'),
  )}</tbody></table>
<table class="totals"><tbody>
  <tr><td>Total charges</td><td class="num">${money(folio.balance.chargesTotal)}</td></tr>
  <tr><td>Payments received</td><td class="num">${money(folio.balance.paymentsConfirmed)}</td></tr>
  ${Number(folio.balance.paymentsPending) ? `<tr><td>Pending payments (not yet counted)</td><td class="num">${money(folio.balance.paymentsPending)}</td></tr>` : ''}
  <tr class="strong"><td>Balance due</td><td class="num">KES ${money(folio.balance.balance)}</td></tr>
</tbody></table>
<p class="muted">Running statement printed ${esc(new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }))}. This is not a tax invoice.</p>`);
}

export function renderRegistrationCard(d: Json): string {
  const s = d.stay;
  const terms = String(d.policy?.registrationTerms ?? '');
  const reg = d.registration ?? {};
  return page('Registration card', d.property, `
<div class="grid">
  <div><span>Guest</span>${esc(d.guest.name)}</div>
  <div><span>Nationality</span>${esc(d.guest.nationality ?? '')}</div>
  <div><span>Phone</span>${esc(d.guest.phone ?? '')}</div>
  <div><span>Email</span>${esc(d.guest.email ?? '')}</div>
  <div><span>Company</span>${esc(d.guest.company ?? '')}</div>
  <div><span>Identity document</span>${d.identity ? `${esc(label(d.identity.documentType))} ${esc(d.identity.documentNumber)} (${esc(d.identity.issuingCountry)})` : 'Not recorded'}</div>
  <div><span>Booking / stay</span>${esc(d.reservationNumber)} · ${esc(s.number)}</div>
  <div><span>Room</span>${esc(s.roomNumber ?? '')} · ${esc(s.roomTypeName)}</div>
  <div><span>Arrival</span>${esc(s.arrivalDate)}</div>
  <div><span>Departure</span>${esc(s.departureDate)}${s.departureTime ? ` at ${esc(s.departureTime)}` : ''}</div>
  <div><span>Guests</span>${esc(s.adults)} adult(s)${Number(s.children) ? `, ${esc(s.children)} child(ren)` : ''}</div>
  <div><span>Rate</span>${esc(s.ratePlanName)} · total KES ${money(s.total)}</div>
  <div><span>Room charges at outlets</span>${s.roomChargeAllowed ? `Allowed${s.creditLimit ? ` up to KES ${money(s.creditLimit)}` : ''}` : 'Not allowed'}</div>
  <div><span>Other occupants</span>${esc((s.occupants as Json[]).filter((o) => !o.isPrimary).map((o) => o.name).join(', ') || '—')}</div>
</div>
<div class="terms">${esc(terms)}</div>
<div class="sign">
  <div>${reg.signature ? `<img src="${esc(reg.signature)}" alt="Guest signature">` : ''}Guest signature${reg.signedName ? `: ${esc(reg.signedName)}` : ''}${
    reg.acknowledgedAt ? `<br>Acknowledged ${esc(new Date(reg.acknowledgedAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }))} (${esc(label(reg.method))})` : ''
  }</div>
  <div>Receptionist</div>
</div>`);
}
