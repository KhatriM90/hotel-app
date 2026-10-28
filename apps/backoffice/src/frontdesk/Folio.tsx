import { useState } from 'react';
import { addDays, Money } from '@hotel/shared';
import { api, Outlet } from '../api';
import { base, ErrorText, Field, kes, label, Modal, openPrintable, StatusBadge, useAction, useLoad, useSession } from '../ui';
import { CheckOutModal, TenderRows, toTenders } from './StayActions';

/** Guest folio: charges with tax, payments, balance, documents and checkout (BIL-01, BIL-06, BIL-09, FD-08). */

interface Charge {
  id: string;
  chargeCode: string;
  description: string;
  outletName: string | null;
  serviceDate: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  netAmount: string;
  taxAmount: string;
  reversalOf: string | null;
  roomNightDate: string | null;
  reason: string | null;
  postedBy: string | null;
  postedAt: string;
  isReversed: boolean;
  taxes: Array<{ taxCode: string; ratePercent: string; taxAmount: string }>;
}

interface Payment {
  id: string;
  tender: string;
  amount: string;
  reference: string | null;
  status: 'pending' | 'confirmed' | 'failed';
  isDeposit: boolean;
  receiptNumber: string | null;
  receiptDocumentId: string | null;
  receivedAt: string;
  receivedBy: string | null;
  failedReason: string | null;
  companyName: string | null;
}

interface Folio {
  id: string;
  number: string;
  status: string;
  stayId: string;
  stayNumber: string;
  stayStatus: string;
  reservationId: string;
  reservationNumber: string;
  guestId: string;
  guestName: string;
  roomNumber: string | null;
  arrivalDate: string;
  departureDate: string;
  roomChargeAllowed: boolean;
  creditLimit: string | null;
  charges: Charge[];
  payments: Payment[];
  taxSummary: Array<{ taxCode: string; name: string; ratePercent: string; taxableAmount: string; taxAmount: string }>;
  balance: { chargesTotal: string; paymentsConfirmed: string; paymentsPending: string; depositsUnapplied: string; balance: string };
  documents: Array<{ id: string; documentType: string; number: string; total: string; issuedAt: string }>;
}

const MANUAL_CODES = [
  ['FOOD', 'Food'],
  ['BEVERAGE', 'Beverage'],
  ['LAUNDRY', 'Laundry'],
  ['MINIBAR', 'Minibar'],
  ['OTHER', 'Other service'],
] as const;

function PostChargeModal({ folio, onClose, onDone }: { folio: Folio; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const outlets = useLoad(() => api.outlets(property.code), [property.code]);
  const [form, setForm] = useState({ chargeCode: 'FOOD', description: '', quantity: '1', unitPrice: '', outletCode: '', reference: '' });
  const action = useAction();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await action.run(({ key }) =>
      api.post(
        `${base(property.code)}/folios/${folio.id}/charges`,
        { ...form, description: form.description || undefined, outletCode: form.outletCode || undefined, reference: form.reference || undefined },
        key,
      ),
    );
    if (ok) onDone();
  }
  return (
    <Modal title={`Post a charge to ${folio.number}`} onClose={onClose}>
      <form className="ys-form" onSubmit={submit}>
        <p className="ys-muted">Prices include VAT and catering levy; the split is shown on the folio. Outlet sales from POS come later and are not posted twice (BIL-02).</p>
        <div className="ys-row">
          <Field label="Charge">
            <select value={form.chargeCode} onChange={(e) => setForm({ ...form, chargeCode: e.target.value })}>
              {MANUAL_CODES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
            </select>
          </Field>
          <Field label="Outlet">
            <select value={form.outletCode} onChange={(e) => setForm({ ...form, outletCode: e.target.value })}>
              <option value="">Front office</option>
              {(outlets.data ?? []).filter((o: Outlet) => o.isActive).map((o: Outlet) => <option key={o.code} value={o.code}>{o.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Description"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <div className="ys-row">
          <Field label="Quantity"><input inputMode="decimal" required value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} /></Field>
          <Field label="Unit price (KES)"><input inputMode="decimal" required value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} /></Field>
          <Field label="Reference"><input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="Docket number" /></Field>
        </div>
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn" disabled={action.busy}>Post charge</button>
        </div>
      </form>
    </Modal>
  );
}

function PaymentModal({ folio, onClose, onDone }: { folio: Folio; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const owed = Number(folio.balance.balance) > 0 ? folio.balance.balance : '';
  const [tenders, setTenders] = useState([{ tender: 'cash', amount: owed, reference: '' }]);
  const [awaiting, setAwaiting] = useState(false);
  const action = useAction();
  const beforeArrival = ['enquiry', 'hold', 'confirmed'].includes(folio.stayStatus);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await action.run(({ key }) => api.post(`${base(property.code)}/folios/${folio.id}/payments`, { tenders: toTenders(tenders, awaiting ? 'pending' : undefined) }, key));
    if (ok) onDone();
  }
  return (
    <Modal title={beforeArrival ? 'Take a deposit' : 'Take a payment'} onClose={onClose} wide>
      <form className="ys-form" onSubmit={submit}>
        <p className="ys-muted">
          Balance {kes(folio.balance.balance)}. Split across tenders if the guest pays several ways (BIL-06). M-PESA, card, bank and cheque need a reference; a reference can only be used once.
        </p>
        <TenderRows tenders={tenders} setTenders={setTenders} />
        <label className="ys-check">
          <input type="checkbox" checked={awaiting} onChange={(e) => setAwaiting(e.target.checked)} /> Non-cash tenders are awaiting confirmation (they will not reduce the balance until confirmed)
        </label>
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn" disabled={action.busy}>Record payment</button>
        </div>
      </form>
    </Modal>
  );
}

function ReverseModal({ folio, charge, onClose, onDone }: { folio: Folio; charge: Charge; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const [reason, setReason] = useState('');
  const action = useAction();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await action.run(({ key, approval }) => api.post(`${base(property.code)}/folios/${folio.id}/charges/${charge.id}/reverse`, { reason, approval }, key));
    if (ok) onDone();
  }
  return (
    <Modal title="Reverse a charge" onClose={onClose}>
      <form className="ys-form" onSubmit={submit}>
        <p>
          {charge.description} · {kes(charge.amount)}. The charge stays on the folio and a negative line cancels it; nothing is deleted.
        </p>
        <Field label="Reason"><input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {action.approvalFields}
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn danger" disabled={action.busy}>Reverse</button>
        </div>
      </form>
    </Modal>
  );
}

function FailModal({ payment, onClose, onDone }: { payment: Payment; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const [reason, setReason] = useState('');
  const action = useAction();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await action.run(({ key }) => api.post(`${base(property.code)}/payments/${payment.id}/fail`, { reason }, key));
    if (ok) onDone();
  }
  return (
    <Modal title="Mark payment as failed" onClose={onClose}>
      <form className="ys-form" onSubmit={submit}>
        <p>{label(payment.tender)} {kes(payment.amount)} {payment.reference ?? ''}</p>
        <Field label="Reason"><input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Back</button>
          <button className="ys-btn danger" disabled={action.busy}>Mark failed</button>
        </div>
      </form>
    </Modal>
  );
}

type Dialog = { kind: 'charge' } | { kind: 'pay' } | { kind: 'checkout' } | { kind: 'reverse'; charge: Charge } | { kind: 'fail'; payment: Payment } | null;

export function FolioPage({ id }: { id: string }) {
  const { property, go } = useSession();
  const { data: f, error, reload } = useLoad(() => api.get<Folio>(`${base(property.code)}/folios/${id}`), [property.code, id]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const confirm = useAction();
  const reservation = useLoad(
    () => (f ? api.get<{ stays: Array<{ id: string; nights: Array<{ date: string; amount: string }> }> }>(`${base(property.code)}/reservations/${f.reservationId}`) : Promise.resolve(null)),
    [property.code, f?.reservationId, f?.charges.length],
  );
  if (error) return <ErrorText error={error} />;
  if (!f) return <p className="ys-muted">Loading…</p>;

  // What checkout will post before settling: nights up to today not yet on the folio (same rule as the API).
  const leaving = property.currentBusinessDate > f.arrivalDate ? property.currentBusinessDate : addDays(f.arrivalDate, 1);
  const posted = new Set(f.charges.map((c) => c.roomNightDate).filter(Boolean));
  const nightsDue = (reservation.data?.stays.find((s) => s.id === f.stayId)?.nights ?? []).filter((n) => n.date < leaving && !posted.has(n.date));
  const dueAtCheckout = Money.of(f.balance.balance).add(Money.sum(nightsDue.map((n) => Money.of(n.amount)))).toString();
  const closed = f.status !== 'open';
  const done = () => {
    setDialog(null);
    reload();
  };
  const print = (docId: string) => openPrintable(`${base(property.code)}/documents/${docId}/html`);
  const reversedBy = new Set(f.charges.filter((c) => c.reversalOf).map((c) => c.reversalOf));

  return (
    <>
      <div className="ys-page-head">
        <h1>Folio {f.number}</h1>
        <StatusBadge status={f.status} />
        <span className="spacer" />
        <button className="ys-btn ghost" onClick={() => openPrintable(`${base(property.code)}/folios/${f.id}/statement`)}>Print statement</button>
        {!closed && <button className="ys-btn ghost" onClick={() => setDialog({ kind: 'charge' })}>Post charge</button>}
        {!closed && <button className="ys-btn ghost" onClick={() => setDialog({ kind: 'pay' })}>Take payment</button>}
        {f.stayStatus === 'checked_in' && <button className="ys-btn" onClick={() => setDialog({ kind: 'checkout' })}>Check out</button>}
      </div>
      <p>
        <button className="ys-link" onClick={() => go('guest', { id: f.guestId })}>{f.guestName}</button> · stay {f.stayNumber} ·{' '}
        <button className="ys-link" onClick={() => go('reservation', { id: f.reservationId })}>booking {f.reservationNumber}</button> · room {f.roomNumber ?? '—'} ·{' '}
        {f.arrivalDate} → {f.departureDate} · <StatusBadge status={f.stayStatus} />
      </p>
      <p className="ys-muted">
        Room charges {f.roomChargeAllowed ? 'allowed' : 'not allowed'}{f.creditLimit ? ` · credit limit ${kes(f.creditLimit)}` : ''}
      </p>

      <div className="ys-tiles">
        <div className="ys-tile"><strong>{kes(f.balance.chargesTotal)}</strong><span>Charges</span></div>
        <div className="ys-tile"><strong>{kes(f.balance.paymentsConfirmed)}</strong><span>Paid (confirmed)</span></div>
        {Number(f.balance.paymentsPending) > 0 && <div className="ys-tile alert"><strong>{kes(f.balance.paymentsPending)}</strong><span>Awaiting confirmation</span></div>}
        <div className={`ys-tile ${Number(f.balance.balance) > 0 ? 'alert' : ''}`}><strong>{kes(f.balance.balance)}</strong><span>Balance</span></div>
      </div>

      <section className="ys-section">
        <h2>Charges</h2>
        <table className="ys-table compact">
          <thead><tr><th>Date</th><th>Description</th><th>Outlet</th><th>Qty</th><th>Amount</th><th>Of which tax</th><th>Posted by</th><th /></tr></thead>
          <tbody>
            {f.charges.length === 0 && <tr><td colSpan={8} className="ys-muted">No charges yet.</td></tr>}
            {f.charges.map((c) => (
              <tr key={c.id} className={c.isReversed || c.reversalOf ? 'ys-reversed' : ''}>
                <td>{c.serviceDate}</td>
                <td>{c.description}{c.reason ? <small className="ys-muted"> · {c.reason}</small> : null}</td>
                <td>{c.outletName ?? '—'}</td>
                <td>{Number(c.quantity)}</td>
                <td>{kes(c.amount)}</td>
                <td title={c.taxes.map((t) => `${t.taxCode} ${t.ratePercent}%: ${t.taxAmount}`).join(', ')}>{kes(c.taxAmount)}</td>
                <td>{c.postedBy ?? 'System'}</td>
                <td>
                  {!closed && !c.reversalOf && !c.isReversed && !reversedBy.has(c.id) && (
                    <button className="ys-btn small ghost" onClick={() => setDialog({ kind: 'reverse', charge: c })}>Reverse</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {f.taxSummary.length > 0 && (
          <p className="ys-muted">
            Tax included: {f.taxSummary.map((t) => `${t.name} on ${kes(t.taxableAmount)} = ${kes(t.taxAmount)}`).join(' · ')}
          </p>
        )}
      </section>

      <section className="ys-section">
        <h2>Payments</h2>
        <ErrorText error={confirm.error} />
        <table className="ys-table compact">
          <thead><tr><th>Received</th><th>Tender</th><th>Reference</th><th>Amount</th><th>Status</th><th>Receipt</th><th /></tr></thead>
          <tbody>
            {f.payments.length === 0 && <tr><td colSpan={7} className="ys-muted">No payments yet.</td></tr>}
            {f.payments.map((p) => (
              <tr key={p.id}>
                <td>{new Date(p.receivedAt).toLocaleString()} <small className="ys-muted">{p.receivedBy}</small></td>
                <td>{label(p.tender)}{p.isDeposit ? ' (deposit)' : ''}{p.companyName ? ` · ${p.companyName}` : ''}</td>
                <td>{p.reference ?? '—'}</td>
                <td>{kes(p.amount)}</td>
                <td><StatusBadge status={p.status} />{p.failedReason ? <small className="ys-muted"> {p.failedReason}</small> : null}</td>
                <td>{p.receiptDocumentId ? <button className="ys-link" onClick={() => print(p.receiptDocumentId!)}>{p.receiptNumber}</button> : '—'}</td>
                <td>
                  {p.status === 'pending' && (
                    <>
                      <button
                        className="ys-btn small"
                        disabled={confirm.busy}
                        onClick={() => confirm.run(({ key }) => api.post(`${base(property.code)}/payments/${p.id}/confirm`, {}, key)).then((ok) => ok && reload())}
                      >
                        Confirm
                      </button>
                      <button className="ys-btn small ghost" onClick={() => setDialog({ kind: 'fail', payment: p })}>Failed</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {f.documents.length > 0 && (
        <section className="ys-section">
          <h2>Documents</h2>
          <ul className="ys-docs">
            {f.documents.map((d) => (
              <li key={d.id}>
                <button className="ys-link" onClick={() => print(d.id)}>{label(d.documentType.toLowerCase())} {d.number}</button>{' '}
                <span className="ys-muted">{kes(d.total)} · {new Date(d.issuedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dialog?.kind === 'charge' && <PostChargeModal folio={f} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'pay' && <PaymentModal folio={f} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'reverse' && <ReverseModal folio={f} charge={dialog.charge} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'fail' && <FailModal payment={dialog.payment} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'checkout' && (
        <CheckOutModal
          stay={{ id: f.stayId, number: f.stayNumber, reservationId: f.reservationId, arrivalDate: f.arrivalDate, departureDate: f.departureDate, guestName: f.guestName, roomNumber: f.roomNumber }}
          balance={f.balance.balance}
          dueAtCheckout={dueAtCheckout}
          nightsDue={nightsDue.length}
          onClose={() => setDialog(null)}
          onDone={(invoiceId) => {
            done();
            void print(invoiceId);
          }}
        />
      )}
    </>
  );
}
