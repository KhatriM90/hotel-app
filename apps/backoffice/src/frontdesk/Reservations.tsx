import { useEffect, useState } from 'react';
import { addDays, BOOKING_SOURCES, nightsBetween, STAY_STATUSES } from '@hotel/shared';
import { api } from '../api';
import { base, ErrorText, Field, kes, label, openPrintable, StatusBadge, useAction, useLoad, useSession } from '../ui';
import { AmendModal, CancelModal, CheckInModal, LateCheckoutModal, MoveModal, StayRef } from './StayActions';

/** Reservations: list, new booking and the booking record (RES-02 to RES-08). */

interface ReservationRow {
  id: string;
  number: string;
  source: string;
  bookerName: string;
  companyName: string | null;
  agentName: string | null;
  arrival: string;
  departure: string;
  rooms: number;
  statuses: string[];
  roomNumbers: string | null;
}

export interface RoomType {
  id: string;
  code: string;
  name: string;
  baseOccupancy: number;
  maxAdults: number;
  maxOccupancy: number;
  roomCount: number;
}

export interface RatePlan {
  id: string;
  code: string;
  name: string;
  isNegotiated: boolean;
  companyName: string | null;
  isActive: boolean;
}

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  companyName: string | null;
}

export function ReservationsPage({ params = {} }: { params?: Record<string, string> }) {
  const { property, go } = useSession();
  const [q, setQ] = useState(params.q ?? '');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState(property.currentBusinessDate);
  const query = new URLSearchParams({ ...(q.trim() ? { q: q.trim() } : {}), ...(status ? { status } : {}), ...(from ? { from } : {}) });
  const { data, error } = useLoad(() => api.get<ReservationRow[]>(`${base(property.code)}/reservations?${query}`), [property.code, query.toString()]);
  return (
    <>
      <div className="ys-page-head">
        <h1>Reservations · {property.name}</h1>
        <span className="spacer" />
        <button className="ys-btn" onClick={() => go('new-reservation')}>New booking</button>
      </div>
      <div className="ys-row filters">
        <Field label="Search"><input placeholder="Booking number, guest or agent ref" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {STAY_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </Field>
        <Field label="Departing after"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      </div>
      <ErrorText error={error} />
      {data && (
        <table className="ys-table">
          <thead>
            <tr><th>Booking</th><th>Booker</th><th>Dates</th><th>Rooms</th><th>Source</th><th>Status</th></tr>
          </thead>
          <tbody>
            {data.length === 0 && <tr><td colSpan={6} className="ys-muted">No bookings match.</td></tr>}
            {data.map((r) => (
              <tr key={r.id} className="ys-click" onClick={() => go('reservation', { id: r.id })}>
                <td><strong>{r.number}</strong></td>
                <td>{r.bookerName}{r.companyName ? ` · ${r.companyName}` : ''}{r.agentName ? ` · via ${r.agentName}` : ''}</td>
                <td className="ys-nowrap">{r.arrival} → {r.departure}</td>
                <td>{r.rooms}{r.roomNumbers ? ` (${r.roomNumbers})` : ''}</td>
                <td>{label(r.source)}</td>
                <td>{r.statuses.map((s) => <StatusBadge key={s} status={s} />)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// New booking (RES-02, RES-03, RES-04, RES-08)
// ---------------------------------------------------------------------------

interface RoomLine {
  roomTypeCode: string;
  ratePlanCode: string;
  adults: number;
  children: number;
  override: string;
  quote?: { total: string; nights: Array<{ date: string; amount: string; seasonName: string }> } | null;
  quoteError?: string | null;
}

function GuestPicker({ value, onChange }: { value: Guest | null; onChange: (g: Guest | null) => void }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<Guest[]>([]);
  useEffect(() => {
    if (term.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      api.get<Guest[]>(`/guests?q=${encodeURIComponent(term.trim())}`).then(setResults, () => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [term]);
  if (value) {
    return (
      <p>
        <strong>{value.firstName} {value.lastName}</strong> {value.phone && <span className="ys-muted">{value.phone}</span>}{' '}
        <button type="button" className="ys-link" onClick={() => onChange(null)}>change</button>
      </p>
    );
  }
  return (
    <div className="ys-picker">
      <Field label="Find an existing guest" hint="Search by name, phone or email so the same guest is not created twice (FD-02).">
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="At least 2 characters" />
      </Field>
      {results.length > 0 && (
        <ul className="ys-results">
          {results.map((g) => (
            <li key={g.id}>
              <button type="button" onClick={() => onChange(g)}>
                {g.firstName} {g.lastName} <span className="ys-muted">{[g.phone, g.email, g.companyName].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function NewReservationPage({ params }: { params: Record<string, string> }) {
  const { property, go } = useSession();
  const types = useLoad(() => api.get<RoomType[]>(`${base(property.code)}/room-types`), [property.code]);
  const plans = useLoad(() => api.get<RatePlan[]>(`${base(property.code)}/rate-plans`), [property.code]);
  const companies = useLoad(() => api.get<Array<{ id: string; name: string; kind: string }>>('/companies'), []);
  const arrivalDefault = params.arrival ?? property.currentBusinessDate;
  const [arrival, setArrival] = useState(arrivalDefault);
  const [departure, setDeparture] = useState(nextDay(arrivalDefault));
  const [source, setSource] = useState<string>('phone');
  const [status, setStatus] = useState<'confirmed' | 'hold' | 'enquiry'>('confirmed');
  const [holdMinutes, setHoldMinutes] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [agentReference, setAgentRef] = useState('');
  const [notes, setNotes] = useState('');
  const [existing, setExisting] = useState<Guest | null>(null);
  const [guest, setGuest] = useState({ firstName: '', lastName: '', phone: '', email: '', nationality: 'KE' });
  const [overrideReason, setOverrideReason] = useState('');
  const [lines, setLines] = useState<RoomLine[]>([{ roomTypeCode: params.roomTypeCode ?? '', ratePlanCode: 'RACK', adults: 1, children: 0, override: '' }]);
  const action = useAction<{ id: string }>();

  useEffect(() => {
    if (!lines[0].roomTypeCode && types.data?.length) setLine(0, { roomTypeCode: types.data[0].code });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.data]);

  // Live price for each room line, from the same rate engine that books (RES-05).
  const quoteKey = JSON.stringify([arrival, departure, lines.map((l) => [l.roomTypeCode, l.ratePlanCode, l.adults, l.children])]);
  useEffect(() => {
    if (departure <= arrival) return;
    lines.forEach((l, i) => {
      if (!l.roomTypeCode || !l.ratePlanCode) return;
      api
        .post<RoomLine['quote']>(`${base(property.code)}/rates/quote`, { roomTypeCode: l.roomTypeCode, ratePlanCode: l.ratePlanCode, arrival, departure, adults: l.adults, children: l.children })
        .then(
          (quote) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quote, quoteError: null } : x))),
          (e: Error) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quote: null, quoteError: e.message } : x))),
        );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey, property.code]);

  function setLine(i: number, patch: Partial<RoomLine>) {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await action.run(({ key, approval }) =>
      api.post<{ id: string }>(
        `${base(property.code)}/reservations`,
        {
          source,
          status,
          holdMinutes: status === 'hold' && holdMinutes ? Number(holdMinutes) : undefined,
          arrival,
          departure,
          companyId: companyId || undefined,
          agentId: agentId || undefined,
          agentReference: agentReference || undefined,
          notes: notes || undefined,
          guest: existing
            ? { id: existing.id }
            : { firstName: guest.firstName, lastName: guest.lastName, phone: guest.phone || undefined, email: guest.email || undefined, nationality: guest.nationality || undefined },
          rooms: lines.map((l) => ({
            roomTypeCode: l.roomTypeCode,
            ratePlanCode: l.ratePlanCode,
            adults: l.adults,
            children: l.children,
            rateOverride: l.override ? { amountPerNight: l.override, reason: overrideReason } : undefined,
          })),
          approval,
        },
        key,
      ),
    );
    if (res) go('reservation', { id: res.id });
  }

  const companyList = (companies.data ?? []).filter((c) => c.kind === 'company');
  const agentList = (companies.data ?? []).filter((c) => c.kind === 'agent');
  const anyOverride = lines.some((l) => l.override);

  return (
    <>
      <div className="ys-page-head"><h1>New booking · {property.name}</h1></div>
      <form className="ys-form ys-card" onSubmit={submit}>
        <div className="ys-row">
          <Field label="Arrival"><input type="date" required value={arrival} onChange={(e) => {
            setArrival(e.target.value);
            if (e.target.value && departure <= e.target.value) setDeparture(nextDay(e.target.value));
          }} /></Field>
          <Field label="Departure"><input type="date" required value={departure} min={nextDay(arrival)} onChange={(e) => setDeparture(e.target.value)} /></Field>
          <Field label="Nights"><input readOnly value={departure > arrival ? nightsBetween(arrival, departure).length : 0} /></Field>
          <Field label="Source">
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {BOOKING_SOURCES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="confirmed">Confirmed</option>
              <option value="hold">Provisional hold</option>
              <option value="enquiry">Enquiry (no room held)</option>
            </select>
          </Field>
          {status === 'hold' && (
            <Field label="Hold for (minutes)" hint="Empty uses the property policy.">
              <input inputMode="numeric" value={holdMinutes} onChange={(e) => setHoldMinutes(e.target.value)} />
            </Field>
          )}
        </div>

        <fieldset>
          <legend>Guest</legend>
          <GuestPicker value={existing} onChange={setExisting} />
          {!existing && (
            <div className="ys-row">
              <Field label="First name"><input required value={guest.firstName} onChange={(e) => setGuest({ ...guest, firstName: e.target.value })} /></Field>
              <Field label="Last name"><input required value={guest.lastName} onChange={(e) => setGuest({ ...guest, lastName: e.target.value })} /></Field>
              <Field label="Phone"><input value={guest.phone} onChange={(e) => setGuest({ ...guest, phone: e.target.value })} placeholder="+254…" /></Field>
              <Field label="Email"><input type="email" value={guest.email} onChange={(e) => setGuest({ ...guest, email: e.target.value })} /></Field>
              <Field label="Nationality"><input maxLength={2} value={guest.nationality} onChange={(e) => setGuest({ ...guest, nationality: e.target.value.toUpperCase() })} /></Field>
            </div>
          )}
        </fieldset>

        <div className="ys-row">
          <Field label="Company (corporate booking)">
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">None</option>
              {companyList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Travel agent">
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">None</option>
              {agentList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          {agentId && <Field label="Agent reference"><input value={agentReference} onChange={(e) => setAgentRef(e.target.value)} /></Field>}
        </div>

        <fieldset>
          <legend>Rooms (RES-08: one booking can hold several rooms)</legend>
          {lines.map((l, i) => {
            const t = types.data?.find((x) => x.code === l.roomTypeCode);
            return (
              <div key={i} className="ys-room-line">
                <div className="ys-row">
                  <Field label="Room type">
                    <select value={l.roomTypeCode} onChange={(e) => setLine(i, { roomTypeCode: e.target.value })}>
                      {(types.data ?? []).map((x) => <option key={x.code} value={x.code}>{x.code} · {x.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Rate plan">
                    <select value={l.ratePlanCode} onChange={(e) => setLine(i, { ratePlanCode: e.target.value })}>
                      {(plans.data ?? []).filter((p) => p.isActive).map((p) => (
                        <option key={p.code} value={p.code}>{p.code} · {p.name}{p.companyName ? ` (${p.companyName})` : ''}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label={`Adults${t ? ` (max ${t.maxAdults})` : ''}`}>
                    <input type="number" min={1} max={12} value={l.adults} onChange={(e) => setLine(i, { adults: Number(e.target.value) })} />
                  </Field>
                  <Field label="Children">
                    <input type="number" min={0} max={12} value={l.children} onChange={(e) => setLine(i, { children: Number(e.target.value) })} />
                  </Field>
                  <Field label="Override per night" hint="Needs approval">
                    <input inputMode="decimal" value={l.override} onChange={(e) => setLine(i, { override: e.target.value })} />
                  </Field>
                  {lines.length > 1 && (
                    <button type="button" className="ys-btn ghost" aria-label="Remove room" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
                  )}
                </div>
                {l.quoteError ? (
                  <p className="ys-error">{l.quoteError}</p>
                ) : l.quote ? (
                  <p className="ys-muted">
                    {l.quote.nights.map((n) => `${n.date.slice(5)} ${kes(n.amount)}`).join(' · ')} · <strong>Total {kes(l.quote.total)}</strong>
                  </p>
                ) : null}
              </div>
            );
          })}
          <button type="button" className="ys-btn ghost" onClick={() => setLines([...lines, { ...lines[lines.length - 1], override: '', quote: null }])}>+ Add a room</button>
        </fieldset>

        {anyOverride && (
          <Field label="Reason for the price override"><input required minLength={3} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} /></Field>
        )}
        <Field label="Notes"><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {action.approvalFields}
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={() => go('reservations')}>Cancel</button>
          <button className="ys-btn" disabled={action.busy}>{action.busy ? 'Booking…' : 'Create booking'}</button>
        </div>
      </form>
    </>
  );
}

const nextDay = (date: string) => addDays(date, 1);

// ---------------------------------------------------------------------------
// Booking record
// ---------------------------------------------------------------------------

interface DetailStay {
  id: string;
  number: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  holdExpiresAt: string | null;
  roomTypeCode: string;
  roomTypeName: string;
  ratePlanCode: string;
  ratePlanName: string;
  roomId: string | null;
  roomNumber: string | null;
  roomHkStatus: string | null;
  guest: { id: string; name: string };
  folioId: string;
  folioNumber: string;
  folioStatus: string;
  departureTime: string | null;
  registrationAcknowledgedAt: string | null;
  cancelReason: string | null;
  nights: Array<{ date: string; amount: string; seasonName: string; isOverride: boolean }>;
  total: string;
  occupants: Array<{ id: string; name: string; isPrimary: boolean }>;
  balance: { balance: string; chargesTotal: string; paymentsConfirmed: string; paymentsPending: string };
}

interface Detail {
  id: string;
  number: string;
  source: string;
  status: string;
  agentReference: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  booker: { id: string; name: string; phone: string | null; email: string | null };
  company: { name: string } | null;
  agent: { name: string } | null;
  policy: { freeCancellationHours: number; refundPolicy: string; depositType: string; depositValue: string } | null;
  stays: DetailStay[];
  deposit: { required: string; received: string; outstanding: string; dueDate: string | null };
  total: string;
  amendments: Array<{ id: string; stayNumber: string; kind: string; priceDifference: string; reason: string; by: string; approvedBy: string | null; at: string }>;
  documents: Array<{ id: string; documentType: string; number: string; total: string; issuedAt: string }>;
}

type Dialog =
  | { kind: 'check-in' | 'move' | 'amend' | 'late'; stay: DetailStay }
  | { kind: 'cancel' | 'no-show'; stayIds: string[] }
  | null;

function toRef(s: DetailStay, reservationId: string): StayRef {
  return { ...s, reservationId, guestName: s.guest.name };
}

export function ReservationDetailPage({ id }: { id: string }) {
  const { property, go } = useSession();
  const { data, error, reload } = useLoad(() => api.get<Detail>(`${base(property.code)}/reservations/${id}`), [property.code, id]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lifecycle = useAction();

  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="ys-muted">Loading…</p>;

  const done = (msg?: string) => {
    setDialog(null);
    setNotice(msg ?? null);
    reload();
  };
  const transition = (to: 'confirm' | 'hold', stayIds: string[]) =>
    lifecycle.run(({ key }) => api.post(`${base(property.code)}/reservations/${id}/${to}`, { stayIds }, key)).then((ok) => ok && done());
  const proforma = async () => {
    const doc = await lifecycle.run(({ key }) => api.post<{ id: string }>(`${base(property.code)}/reservations/${id}/proforma`, {}, key));
    if (doc) {
      reload();
      void openPrintable(`${base(property.code)}/documents/${(doc as { id: string }).id}/html`);
    }
  };
  const open = data.stays.filter((s) => ['enquiry', 'hold', 'confirmed'].includes(s.status));

  return (
    <>
      <div className="ys-page-head">
        <h1>Booking {data.number}</h1>
        <StatusBadge status={data.status} />
        <span className="spacer" />
        <button className="ys-btn ghost" onClick={proforma}>Pro forma</button>
        {open.length > 0 && <button className="ys-btn danger ghost" onClick={() => setDialog({ kind: 'cancel', stayIds: open.map((s) => s.id) })}>Cancel booking</button>}
      </div>
      {notice && <p className="ys-ok">{notice}</p>}
      <ErrorText error={lifecycle.error} />

      <div className="ys-grid">
        <div className="ys-card">
          <h3>Booker</h3>
          <p>
            <button className="ys-link" onClick={() => go('guest', { id: data.booker.id })}>{data.booker.name}</button>
          </p>
          <p className="ys-muted">{[data.booker.phone, data.booker.email].filter(Boolean).join(' · ')}</p>
          {data.company && <p>Company: {data.company.name}</p>}
          {data.agent && <p>Agent: {data.agent.name}{data.agentReference ? ` (${data.agentReference})` : ''}</p>}
          <p className="ys-muted">{label(data.source)} · by {data.createdBy ?? 'system'} · {new Date(data.createdAt).toLocaleString()}</p>
          {data.notes && <p>{data.notes}</p>}
        </div>
        <div className="ys-card">
          <h3>Money</h3>
          <p>Stay total <strong>{kes(data.total)}</strong></p>
          <p>
            Deposit required {kes(data.deposit.required)} · received {kes(data.deposit.received)}
            {Number(data.deposit.outstanding) > 0 && (
              <> · <strong className="ys-warn-text">{kes(data.deposit.outstanding)} due{data.deposit.dueDate ? ` by ${data.deposit.dueDate}` : ''}</strong></>
            )}
          </p>
          {data.policy && (
            <p className="ys-muted">
              Free cancellation up to {data.policy.freeCancellationHours} h before arrival. {data.policy.refundPolicy}
            </p>
          )}
        </div>
      </div>

      {data.stays.map((s) => (
        <section className="ys-card ys-section" key={s.id}>
          <div className="ys-page-head">
            <h2>
              {s.number} · {s.guest.name}
            </h2>
            <StatusBadge status={s.status} />
            <span className="spacer" />
            {s.status === 'enquiry' && <button className="ys-btn small ghost" onClick={() => transition('hold', [s.id])}>Hold room</button>}
            {['enquiry', 'hold'].includes(s.status) && <button className="ys-btn small" onClick={() => transition('confirm', [s.id])}>Confirm</button>}
            {s.status === 'confirmed' && <button className="ys-btn small" onClick={() => setDialog({ kind: 'check-in', stay: s })}>Check in</button>}
            {['hold', 'confirmed', 'checked_in'].includes(s.status) && <button className="ys-btn small ghost" onClick={() => setDialog({ kind: 'amend', stay: s })}>Amend</button>}
            {s.status === 'checked_in' && (
              <>
                <button className="ys-btn small ghost" onClick={() => setDialog({ kind: 'move', stay: s })}>Move room</button>
                <button className="ys-btn small ghost" onClick={() => setDialog({ kind: 'late', stay: s })}>Late check-out</button>
              </>
            )}
            {['confirmed', 'checked_in', 'checked_out'].includes(s.status) && (
              <button className="ys-btn small ghost" onClick={() => openPrintable(`${base(property.code)}/stays/${s.id}/registration-card`)}>Registration card</button>
            )}
            {['enquiry', 'hold', 'confirmed'].includes(s.status) && (
              <button className="ys-btn small ghost" onClick={() => setDialog({ kind: 'cancel', stayIds: [s.id] })}>Cancel room</button>
            )}
            {s.status === 'confirmed' && s.arrivalDate <= property.currentBusinessDate && (
              <button className="ys-btn small danger ghost" onClick={() => setDialog({ kind: 'no-show', stayIds: [s.id] })}>No-show</button>
            )}
            <button className="ys-btn small" onClick={() => go('folio', { id: s.folioId })}>Folio {s.folioNumber}</button>
          </div>
          <p>
            {s.roomTypeName} ({s.ratePlanCode}) · room <strong>{s.roomNumber ?? 'not allocated'}</strong>
            {s.roomHkStatus && <> <StatusBadge status={s.roomHkStatus} /></>} · {s.arrivalDate} → {s.departureDate}
            {s.departureTime ? ` at ${s.departureTime.slice(0, 5)}` : ''} · {s.adults} adult(s){s.children ? `, ${s.children} child(ren)` : ''}
          </p>
          {s.holdExpiresAt && s.status === 'hold' && <p className="ys-warn">Hold expires {new Date(s.holdExpiresAt).toLocaleString()}</p>}
          {s.cancelReason && <p className="ys-muted">Reason: {s.cancelReason}</p>}
          {s.occupants.length > 1 && <p className="ys-muted">Occupants: {s.occupants.map((o) => o.name).join(', ')}</p>}
          <table className="ys-table compact">
            <thead><tr><th>Night</th><th>Season</th><th>Price</th></tr></thead>
            <tbody>
              {s.nights.map((n) => (
                <tr key={n.date}><td>{n.date}</td><td>{n.seasonName}{n.isOverride ? ' (override)' : ''}</td><td>{kes(n.amount)}</td></tr>
              ))}
              <tr><th colSpan={2}>Total</th><th>{kes(s.total)}</th></tr>
            </tbody>
          </table>
          <p className="ys-muted">Folio balance {kes(s.balance?.balance)}{Number(s.balance?.paymentsPending ?? 0) > 0 ? ` · ${kes(s.balance.paymentsPending)} pending` : ''}</p>
        </section>
      ))}

      {data.amendments.length > 0 && (
        <section className="ys-section">
          <h2>Changes</h2>
          <table className="ys-table compact">
            <thead><tr><th>When</th><th>Stay</th><th>Change</th><th>Price difference</th><th>Reason</th><th>By</th></tr></thead>
            <tbody>
              {data.amendments.map((a) => (
                <tr key={a.id}>
                  <td>{new Date(a.at).toLocaleString()}</td><td>{a.stayNumber}</td><td>{label(a.kind)}</td><td>{kes(a.priceDifference)}</td><td>{a.reason}</td>
                  <td>{a.by}{a.approvedBy ? ` (approved by ${a.approvedBy})` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {data.documents.length > 0 && (
        <section className="ys-section">
          <h2>Documents</h2>
          <ul className="ys-docs">
            {data.documents.map((d) => (
              <li key={d.id}>
                <button className="ys-link" onClick={() => openPrintable(`${base(property.code)}/documents/${d.id}/html`)}>{label(d.documentType.toLowerCase())} {d.number}</button>{' '}
                <span className="ys-muted">{kes(d.total)} · {new Date(d.issuedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dialog?.kind === 'check-in' && <CheckInModal stay={toRef(dialog.stay, id)} onClose={() => setDialog(null)} onDone={() => done('Checked in.')} />}
      {dialog?.kind === 'move' && <MoveModal stay={toRef(dialog.stay, id)} onClose={() => setDialog(null)} onDone={() => done('Room changed.')} />}
      {dialog?.kind === 'late' && <LateCheckoutModal stay={toRef(dialog.stay, id)} onClose={() => setDialog(null)} onDone={() => done('Late check-out saved.')} />}
      {dialog?.kind === 'amend' && (
        <AmendModal stay={toRef(dialog.stay, id)} onClose={() => setDialog(null)} onDone={(diff) => done(`Booking amended. Price difference ${kes(diff)}.`)} />
      )}
      {(dialog?.kind === 'cancel' || dialog?.kind === 'no-show') && (
        <CancelModal reservationId={id} stayIds={dialog.stayIds} mode={dialog.kind} onClose={() => setDialog(null)} onDone={() => done()} />
      )}
    </>
  );
}
