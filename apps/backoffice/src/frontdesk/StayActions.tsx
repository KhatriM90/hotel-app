import { useState } from 'react';
import { api } from '../api';
import { base, ErrorText, Field, kes, Modal, useAction, useLoad, useSession } from '../ui';

/** Dialogs for the stay actions reception performs (FD-03, FD-05, FD-06, FD-08, RES-03, RES-06). */

export interface StayRef {
  id: string;
  number: string;
  reservationId: string;
  folioId?: string;
  roomTypeCode?: string;
  roomNumber?: string | null;
  arrivalDate: string;
  departureDate: string;
  adults?: number;
  children?: number;
  guestName?: string;
}

interface FreeRoom {
  id: string;
  number: string;
  roomTypeCode: string;
  roomTypeName: string;
  hkStatus: string;
}

function useFreeRooms(arrival: string, departure: string, roomTypeCode?: string) {
  const { property } = useSession();
  const q = new URLSearchParams({ arrival, departure, ...(roomTypeCode ? { roomTypeCode } : {}) });
  return useLoad(() => api.get<FreeRoom[]>(`${base(property.code)}/availability/rooms?${q}`), [property.code, arrival, departure, roomTypeCode]);
}

const DOC_TYPES = [
  ['national_id', 'Kenyan national ID'],
  ['passport', 'Passport'],
  ['alien_id', 'Alien ID'],
  ['driving_licence', 'Driving licence'],
  ['other', 'Other'],
] as const;

export function CheckInModal({ stay, onClose, onDone }: { stay: StayRef; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const free = useFreeRooms(stay.arrivalDate, stay.departureDate, stay.roomTypeCode);
  const [roomId, setRoomId] = useState('');
  const [doc, setDoc] = useState({ documentType: 'national_id', documentNumber: '', issuingCountry: 'KE', expiryDate: '' });
  const [hasDoc, setHasDoc] = useState(false);
  const [roomChargeAllowed, setRoomCharge] = useState(true);
  const [creditLimit, setCreditLimit] = useState('');
  const [earlyCheckIn, setEarly] = useState(false);
  const [waiveFee, setWaive] = useState(false);
  const [notReady, setNotReady] = useState('');
  const [signedName, setSignedName] = useState(stay.guestName ?? '');
  const [occupant, setOccupant] = useState({ firstName: '', lastName: '' });
  const action = useAction();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await action.run(({ key, approval }) =>
      api.post(
        `${base(property.code)}/stays/${stay.id}/check-in`,
        {
          roomId: roomId || undefined,
          identity: hasDoc ? undefined : { ...doc, expiryDate: doc.expiryDate || undefined },
          occupants: occupant.firstName && occupant.lastName ? [occupant] : undefined,
          roomChargeAllowed,
          creditLimit: creditLimit || undefined,
          earlyCheckIn,
          waiveFee: earlyCheckIn && waiveFee,
          roomNotReadyReason: notReady || undefined,
          registration: signedName ? { method: 'paper_signature', signedName } : undefined,
          approval,
        },
        key,
      ),
    );
    if (ok) onDone();
  }

  return (
    <Modal title={`Check in ${stay.number}`} onClose={onClose} wide>
      <form onSubmit={submit} className="ys-form">
        <p className="ys-muted">
          {stay.guestName} · {stay.arrivalDate} to {stay.departureDate} · allocated room {stay.roomNumber ?? 'none'}
        </p>
        <Field label="Room" hint="Ready rooms (clean or inspected) are listed first.">
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">Keep allocated room {stay.roomNumber ?? ''}</option>
            {(free.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.number} · {r.roomTypeName} · {r.hkStatus.replace('_', ' ')}
              </option>
            ))}
          </select>
        </Field>
        <fieldset>
          <legend>Identity (FD-03)</legend>
          <label className="ys-check">
            <input type="checkbox" checked={hasDoc} onChange={(e) => setHasDoc(e.target.checked)} /> A verified, in-date document is already on file
          </label>
          {!hasDoc && (
            <div className="ys-row">
              <Field label="Document">
                <select value={doc.documentType} onChange={(e) => setDoc({ ...doc, documentType: e.target.value })}>
                  {DOC_TYPES.map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </Field>
              <Field label="Number">
                <input required value={doc.documentNumber} onChange={(e) => setDoc({ ...doc, documentNumber: e.target.value })} />
              </Field>
              <Field label="Country">
                <input required maxLength={2} value={doc.issuingCountry} onChange={(e) => setDoc({ ...doc, issuingCountry: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="Expiry">
                <input type="date" value={doc.expiryDate} onChange={(e) => setDoc({ ...doc, expiryDate: e.target.value })} />
              </Field>
            </div>
          )}
        </fieldset>
        <div className="ys-row">
          <Field label="Second occupant first name">
            <input value={occupant.firstName} onChange={(e) => setOccupant({ ...occupant, firstName: e.target.value })} />
          </Field>
          <Field label="Last name">
            <input value={occupant.lastName} onChange={(e) => setOccupant({ ...occupant, lastName: e.target.value })} />
          </Field>
        </div>
        <fieldset>
          <legend>Room charges (BIL-02)</legend>
          <label className="ys-check">
            <input type="checkbox" checked={roomChargeAllowed} onChange={(e) => setRoomCharge(e.target.checked)} /> Outlets may charge to this room
          </label>
          <Field label="Credit limit (KES, optional)">
            <input inputMode="decimal" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} placeholder="No limit" />
          </Field>
        </fieldset>
        <div className="ys-row">
          <label className="ys-check">
            <input type="checkbox" checked={earlyCheckIn} onChange={(e) => setEarly(e.target.checked)} /> Early check-in (policy fee)
          </label>
          {earlyCheckIn && (
            <label className="ys-check">
              <input type="checkbox" checked={waiveFee} onChange={(e) => setWaive(e.target.checked)} /> Waive the fee (needs approval)
            </label>
          )}
        </div>
        <Field label="Room not ready? Reason to proceed anyway (needs approval)">
          <input value={notReady} onChange={(e) => setNotReady(e.target.value)} />
        </Field>
        <Field label="Registration card signed by" hint="Print the card from the reservation; record who signed it here.">
          <input value={signedName} onChange={(e) => setSignedName(e.target.value)} />
        </Field>
        {action.approvalFields}
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn" disabled={action.busy}>{action.busy ? 'Checking in…' : 'Check in'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function MoveModal({ stay, onClose, onDone }: { stay: StayRef; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const free = useFreeRooms(property.currentBusinessDate, stay.departureDate);
  const [toRoomId, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [notReady, setNotReady] = useState('');
  const action = useAction();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await action.run(({ key, approval }) =>
      api.post(`${base(property.code)}/stays/${stay.id}/move`, { toRoomId, reason, roomNotReadyReason: notReady || undefined, approval }, key),
    );
    if (ok) onDone();
  }
  return (
    <Modal title={`Move ${stay.guestName ?? stay.number} from room ${stay.roomNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="ys-form">
        <p className="ys-muted">The stay {stay.number} and its folio keep every charge and payment; only the room changes (FD-05).</p>
        <Field label="New room">
          <select required value={toRoomId} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose a free room</option>
            {(free.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>{r.number} · {r.roomTypeName} · {r.hkStatus.replace('_', ' ')}</option>
            ))}
          </select>
        </Field>
        <Field label="Reason">
          <input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="Room not ready? Reason to proceed anyway (needs approval)">
          <input value={notReady} onChange={(e) => setNotReady(e.target.value)} />
        </Field>
        {action.approvalFields}
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn" disabled={action.busy}>Move guest</button>
        </div>
      </form>
    </Modal>
  );
}

interface Tender {
  tender: string;
  amount: string;
  reference: string;
}

export function TenderRows({ tenders, setTenders }: { tenders: Tender[]; setTenders: (t: Tender[]) => void }) {
  const set = (i: number, patch: Partial<Tender>) => setTenders(tenders.map((t, j) => (i === j ? { ...t, ...patch } : t)));
  return (
    <div className="ys-tenders">
      {tenders.map((t, i) => (
        <div className="ys-row" key={i}>
          <Field label="Tender">
            <select value={t.tender} onChange={(e) => set(i, { tender: e.target.value })}>
              <option value="cash">Cash</option>
              <option value="mpesa">M-PESA</option>
              <option value="card">Card</option>
              <option value="bank_transfer">Bank transfer</option>
              <option value="cheque">Cheque</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Amount (KES)">
            <input inputMode="decimal" value={t.amount} onChange={(e) => set(i, { amount: e.target.value })} />
          </Field>
          <Field label="Reference">
            <input value={t.reference} required={t.tender !== 'cash' && t.tender !== 'other'} onChange={(e) => set(i, { reference: e.target.value })} />
          </Field>
          {tenders.length > 1 && (
            <button type="button" className="ys-btn ghost" onClick={() => setTenders(tenders.filter((_, j) => j !== i))} aria-label="Remove tender">✕</button>
          )}
        </div>
      ))}
      <button type="button" className="ys-btn ghost" onClick={() => setTenders([...tenders, { tender: 'mpesa', amount: '', reference: '' }])}>+ Add tender</button>
    </div>
  );
}

export function toTenders(tenders: Tender[], status?: 'pending') {
  return tenders
    .filter((t) => t.amount)
    .map((t) => ({ tender: t.tender, amount: t.amount, reference: t.reference || undefined, ...(status && t.tender !== 'cash' ? { status } : {}) }));
}

export function CheckOutModal({
  stay,
  balance,
  dueAtCheckout = balance,
  nightsDue = 0,
  onClose,
  onDone,
}: {
  stay: StayRef;
  balance: string;
  dueAtCheckout?: string;
  nightsDue?: number;
  onClose: () => void;
  onDone: (invoiceId: string) => void;
}) {
  const { property } = useSession();
  const [tenders, setTenders] = useState<Tender[]>([{ tender: 'cash', amount: Number(dueAtCheckout) > 0 ? dueAtCheckout : '', reference: '' }]);
  const [transfer, setTransfer] = useState(false);
  const [companyId, setCompanyId] = useState('');
  const [reason, setReason] = useState('');
  const companies = useLoad(() => api.get<Array<{ id: string; name: string }>>('/companies?kind=company'), []);
  const action = useAction<{ invoice: { id: string } }>();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await action.run(({ key, approval }) =>
      api.post<{ invoice: { id: string } }>(
        `${base(property.code)}/stays/${stay.id}/check-out`,
        transfer ? { creditTransfer: { companyId, reason }, approval } : { tenders: toTenders(tenders), approval },
        key,
      ),
    );
    if (res) onDone(res.invoice.id);
  }
  return (
    <Modal title={`Check out ${stay.guestName ?? stay.number}`} onClose={onClose} wide>
      <form onSubmit={submit} className="ys-form">
        <p>
          To settle: <strong>{kes(dueAtCheckout)}</strong>
          {nightsDue > 0 && <> (folio balance {kes(balance)} plus {nightsDue} room night(s) that checkout posts first)</>}. The balance must be zero to check out (FD-08).
        </p>
        <label className="ys-check">
          <input type="checkbox" checked={transfer} onChange={(e) => setTransfer(e.target.checked)} /> Transfer the balance to a company account (needs approval)
        </label>
        {transfer ? (
          <div className="ys-row">
            <Field label="Company">
              <select required value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                <option value="">Choose</option>
                {(companies.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Reason">
              <input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
        ) : (
          <TenderRows tenders={tenders} setTenders={setTenders} />
        )}
        {action.approvalFields}
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn" disabled={action.busy}>{action.busy ? 'Settling…' : 'Settle and check out'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function AmendModal({ stay, onClose, onDone }: { stay: StayRef; onClose: () => void; onDone: (difference: string) => void }) {
  const { property } = useSession();
  const [arrival, setArrival] = useState(stay.arrivalDate);
  const [departure, setDeparture] = useState(stay.departureDate);
  const [adults, setAdults] = useState(stay.adults ?? 1);
  const [children, setChildren] = useState(stay.children ?? 0);
  const [override, setOverride] = useState('');
  const [reason, setReason] = useState('');
  const action = useAction<{ priceDifference: string }>();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await action.run(({ key, approval }) =>
      api.post<{ priceDifference: string }>(
        `${base(property.code)}/stays/${stay.id}/amend`,
        {
          arrival: arrival !== stay.arrivalDate ? arrival : undefined,
          departure: departure !== stay.departureDate ? departure : undefined,
          adults: adults !== stay.adults ? adults : undefined,
          children: children !== stay.children ? children : undefined,
          rateOverride: override ? { amountPerNight: override, reason } : undefined,
          reason,
          approval,
        },
        key,
      ),
    );
    if (res) onDone(res.priceDifference);
  }
  return (
    <Modal title={`Amend ${stay.number}`} onClose={onClose}>
      <form onSubmit={submit} className="ys-form">
        <p className="ys-muted">Nights that stay the same keep their agreed price; new nights use today’s rates (RES-05, RES-06).</p>
        <div className="ys-row">
          <Field label="Arrival"><input type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} /></Field>
          <Field label="Departure"><input type="date" value={departure} onChange={(e) => setDeparture(e.target.value)} /></Field>
        </div>
        <div className="ys-row">
          <Field label="Adults"><input type="number" min={1} max={12} value={adults} onChange={(e) => setAdults(Number(e.target.value))} /></Field>
          <Field label="Children"><input type="number" min={0} max={12} value={children} onChange={(e) => setChildren(Number(e.target.value))} /></Field>
        </div>
        <Field label="Override price per night (KES, needs approval)">
          <input inputMode="decimal" value={override} onChange={(e) => setOverride(e.target.value)} placeholder="Leave empty to use the rate plan" />
        </Field>
        <Field label="Reason"><input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {action.approvalFields}
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn" disabled={action.busy}>Save amendment</button>
        </div>
      </form>
    </Modal>
  );
}

export function CancelModal({
  reservationId,
  stayIds,
  mode,
  onClose,
  onDone,
}: {
  reservationId: string;
  stayIds?: string[];
  mode: 'cancel' | 'no-show';
  onClose: () => void;
  onDone: () => void;
}) {
  const { property } = useSession();
  const [reason, setReason] = useState('');
  const [waiveFee, setWaive] = useState(false);
  const action = useAction();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await action.run(({ key, approval }) =>
      api.post(`${base(property.code)}/reservations/${reservationId}/${mode}`, { stayIds, reason, waiveFee, approval }, key),
    );
    if (ok) onDone();
  }
  return (
    <Modal title={mode === 'cancel' ? 'Cancel booking' : 'Mark as no-show'} onClose={onClose}>
      <form onSubmit={submit} className="ys-form">
        <p className="ys-muted">
          The booking’s policy decides the charge (RES-07); it posts to the folio unless a manager waives it.
        </p>
        <Field label="Reason"><input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <label className="ys-check">
          <input type="checkbox" checked={waiveFee} onChange={(e) => setWaive(e.target.checked)} /> Waive any charge (needs approval)
        </label>
        {action.approvalFields}
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Back</button>
          <button className="ys-btn danger" disabled={action.busy}>{mode === 'cancel' ? 'Cancel booking' : 'Mark no-show'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function LateCheckoutModal({ stay, onClose, onDone }: { stay: StayRef; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const [departureTime, setTime] = useState('14:00');
  const [waiveFee, setWaive] = useState(false);
  const [reason, setReason] = useState('');
  const action = useAction();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await action.run(({ key, approval }) =>
      api.post(`${base(property.code)}/stays/${stay.id}/late-checkout`, { departureTime, waiveFee, reason: reason || undefined, approval }, key),
    );
    if (ok) onDone();
  }
  return (
    <Modal title="Late check-out (FD-06)" onClose={onClose}>
      <form onSubmit={submit} className="ys-form">
        <Field label="New departure time"><input type="time" required value={departureTime} onChange={(e) => setTime(e.target.value)} /></Field>
        <label className="ys-check">
          <input type="checkbox" checked={waiveFee} onChange={(e) => setWaive(e.target.checked)} /> Waive the fee (needs approval)
        </label>
        {waiveFee && <Field label="Reason"><input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        {action.approvalFields}
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn" disabled={action.busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
