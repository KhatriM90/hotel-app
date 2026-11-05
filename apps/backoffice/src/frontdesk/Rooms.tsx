import { useState } from 'react';
import { addDays, hasPermission, HK_STATUSES } from '@hotel/shared';
import { api } from '../api';
import { base, ErrorText, Field, kes, label, Modal, StatusBadge, useAction, useLoad, useSession } from '../ui';
import type { RatePlan, RoomType } from './Reservations';

/** Rooms and housekeeping status (FD-01, HK-01 basics), room blocks (RES-01), rates and booking policy (RES-05, RES-07). */

interface Room {
  id: string;
  number: string;
  floor: string | null;
  building: string | null;
  roomTypeCode: string;
  roomTypeName: string;
  hkStatus: string;
  hkUpdatedAt: string | null;
  stayId: string | null;
  stayNumber: string | null;
  stayStatus: string | null;
  guestName: string | null;
  departureDate: string | null;
  blockId: string | null;
  blockReason: string | null;
}

function BlockModal({ room, onClose, onDone }: { room: Room; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const [from, setFrom] = useState(property.currentBusinessDate);
  const [to, setTo] = useState(addDays(property.currentBusinessDate, 1));
  const [reason, setReason] = useState('');
  const action = useAction();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await action.run(({ key }) => api.post(`${base(property.code)}/rooms/${room.id}/blocks`, { from, to, reason }, key));
    if (ok) onDone();
  }
  return (
    <Modal title={`Block room ${room.number}`} onClose={onClose}>
      <form className="ys-form" onSubmit={submit}>
        <p className="ys-muted">A blocked room cannot be sold for these nights. Refused if a booking already holds the room.</p>
        <div className="ys-row">
          <Field label="From night"><input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Until (exclusive)"><input type="date" required value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <Field label="Reason"><input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. AC repair" /></Field>
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn" disabled={action.busy}>Block</button>
        </div>
      </form>
    </Modal>
  );
}

export function RoomsPage() {
  const { property, me, go } = useSession();
  const { data, error, reload } = useLoad(() => api.get<Room[]>(`${base(property.code)}/rooms`), [property.code]);
  const [blocking, setBlocking] = useState<Room | null>(null);
  const action = useAction();
  const canStatus = hasPermission(me.roles, 'room.status');
  const canBlock = hasPermission(me.roles, 'room.block');
  return (
    <>
      <div className="ys-page-head">
        <h1>Rooms · {property.name}</h1>
        <span className="ys-muted">{data?.length ?? 0} rooms</span>
      </div>
      <ErrorText error={error ?? action.error} />
      {data && (
        <table className="ys-table compact">
          <thead><tr><th>Room</th><th>Type</th><th>Housekeeping</th><th>Occupancy</th><th /></tr></thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.number}</strong> <small className="ys-muted">{[r.building, r.floor && `floor ${r.floor}`].filter(Boolean).join(' · ')}</small></td>
                <td>{r.roomTypeCode} · {r.roomTypeName}</td>
                <td>
                  {canStatus ? (
                    <select
                      aria-label={`Housekeeping status for ${r.number}`}
                      value={r.hkStatus}
                      onChange={(e) => action.run(() => api.patch(`${base(property.code)}/rooms/${r.id}/hk-status`, { hkStatus: e.target.value })).then((ok) => ok && reload())}
                    >
                      {HK_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                    </select>
                  ) : (
                    <StatusBadge status={r.hkStatus} />
                  )}
                </td>
                <td>
                  {r.blockId ? (
                    <><StatusBadge status="blocked" /> <span className="ys-muted">{r.blockReason}</span></>
                  ) : r.stayId ? (
                    <button className="ys-link" onClick={() => go('reservations', { q: r.stayNumber ?? '' })}>
                      {r.guestName} · {label(r.stayStatus)} until {r.departureDate}
                    </button>
                  ) : (
                    <span className="ys-muted">Vacant</span>
                  )}
                </td>
                <td>
                  {canBlock && r.blockId && (
                    <button className="ys-btn small ghost" onClick={() => action.run(({ key }) => api.post(`${base(property.code)}/blocks/${r.blockId}/release`, {}, key)).then((ok) => ok && reload())}>
                      Release block
                    </button>
                  )}
                  {canBlock && !r.blockId && <button className="ys-btn small ghost" onClick={() => setBlocking(r)}>Block</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {blocking && <BlockModal room={blocking} onClose={() => setBlocking(null)} onDone={() => { setBlocking(null); reload(); }} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Rates and policy
// ---------------------------------------------------------------------------

interface Price {
  id: string;
  roomTypeCode: string;
  seasonName: string;
  validFrom: string;
  validTo: string | null;
  priority: number;
  weekdayPrice: string;
  weekendPrice: string;
  extraAdultPrice: string;
  childPrice: string;
}

interface Policy {
  depositType: string;
  depositValue: string;
  depositDueDays: number;
  holdMinutes: number;
  freeCancellationHours: number;
  lateCancellationNights: number;
  noShowNights: number;
  refundPolicy: string;
  checkInTime: string;
  checkOutTime: string;
  earlyCheckInFee: string;
  lateCheckOutFee: string;
  registrationTerms: string;
  hotelPolicies: string;
}

/**
 * Edits the property's booking policy and the hotel policies (house rules)
 * that go into guest emails, the pro forma and the registration card (RES-07,
 * client request 5 Nov 2026). New bookings take a copy of the terms; existing
 * bookings keep the terms they were made under.
 */
function PolicyModal({ policy, onClose, onDone }: { policy: Policy; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const [f, setF] = useState({
    ...policy,
    depositValue: String(Number(policy.depositValue)),
    earlyCheckInFee: String(Number(policy.earlyCheckInFee)),
    lateCheckOutFee: String(Number(policy.lateCheckOutFee)),
  });
  const action = useAction();
  const num = (k: keyof Policy) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Number(e.target.value) });
  const str = (k: keyof Policy) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Booking and hotel policies" onClose={onClose} wide>
      <form
        className="ys-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const money = (v: string) => (Number(v) || 0).toFixed(2);
          const ok = await action.run(() =>
            api.put(`${base(property.code)}/policy`, {
              depositType: f.depositType, depositValue: String(Number(f.depositValue) || 0), depositDueDays: f.depositDueDays, holdMinutes: f.holdMinutes,
              freeCancellationHours: f.freeCancellationHours, lateCancellationNights: f.lateCancellationNights, noShowNights: f.noShowNights,
              refundPolicy: f.refundPolicy, checkInTime: f.checkInTime, checkOutTime: f.checkOutTime,
              earlyCheckInFee: money(f.earlyCheckInFee), lateCheckOutFee: money(f.lateCheckOutFee),
              registrationTerms: f.registrationTerms, hotelPolicies: f.hotelPolicies,
            }),
          );
          if (ok) onDone();
        }}
      >
        <p className="ys-muted">Changes apply to new bookings. Bookings already made keep the cancellation and deposit terms they were made under.</p>
        <div className="ys-row">
          <Field label="Deposit">
            <select value={f.depositType} onChange={str('depositType')}>
              <option value="none">None</option>
              <option value="percent">Percent of the stay</option>
              <option value="nights">Number of nights</option>
            </select>
          </Field>
          {f.depositType !== 'none' && <Field label={f.depositType === 'percent' ? 'Percent' : 'Nights'}><input inputMode="decimal" value={f.depositValue} onChange={str('depositValue')} /></Field>}
          <Field label="Deposit due (days before arrival)"><input type="number" min={0} value={f.depositDueDays} onChange={num('depositDueDays')} /></Field>
          <Field label="Hold rooms for (minutes)"><input type="number" min={5} value={f.holdMinutes} onChange={num('holdMinutes')} /></Field>
        </div>
        <div className="ys-row">
          <Field label="Free cancellation (hours before arrival)"><input type="number" min={0} value={f.freeCancellationHours} onChange={num('freeCancellationHours')} /></Field>
          <Field label="Late cancellation charge (nights)"><input type="number" min={0} value={f.lateCancellationNights} onChange={num('lateCancellationNights')} /></Field>
          <Field label="No-show charge (nights)"><input type="number" min={0} value={f.noShowNights} onChange={num('noShowNights')} /></Field>
        </div>
        <div className="ys-row">
          <Field label="Check-in from"><input type="time" value={f.checkInTime} onChange={str('checkInTime')} /></Field>
          <Field label="Check-out by"><input type="time" value={f.checkOutTime} onChange={str('checkOutTime')} /></Field>
          <Field label="Early check-in fee (KES)"><input inputMode="decimal" value={f.earlyCheckInFee} onChange={str('earlyCheckInFee')} /></Field>
          <Field label="Late check-out fee (KES)"><input inputMode="decimal" value={f.lateCheckOutFee} onChange={str('lateCheckOutFee')} /></Field>
        </div>
        <Field label="Cancellation and refund policy" hint="Shown on the booking, the pro forma and the confirmation email.">
          <textarea rows={3} value={f.refundPolicy} onChange={str('refundPolicy')} />
        </Field>
        <Field label="Hotel policies (house rules)" hint="One rule per line. Shown in the confirmation email, on the pro forma and on the registration card.">
          <textarea rows={6} value={f.hotelPolicies} onChange={str('hotelPolicies')} />
        </Field>
        <Field label="Registration card terms" hint="Printed above the guest's signature at check-in.">
          <textarea rows={6} value={f.registrationTerms} onChange={str('registrationTerms')} />
        </Field>
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn" disabled={action.busy}>Save policies</button>
        </div>
      </form>
    </Modal>
  );
}

function AddPriceModal({ plan, types, onClose, onDone }: { plan: RatePlan; types: RoomType[]; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const [form, setForm] = useState({
    roomTypeCode: types[0]?.code ?? '', seasonName: '', validFrom: property.currentBusinessDate, validTo: '', priority: '20',
    weekdayPrice: '', weekendPrice: '', extraAdultPrice: '0', childPrice: '0',
  });
  const action = useAction();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await action.run(({ key }) =>
      api.post(`${base(property.code)}/rate-plans/${plan.code}/prices`, { ...form, validTo: form.validTo || null, priority: Number(form.priority) }, key),
    );
    if (ok) onDone();
  }
  return (
    <Modal title={`New price for ${plan.name}`} onClose={onClose} wide>
      <form className="ys-form" onSubmit={submit}>
        <p className="ys-muted">Prices are never edited. A new row with a higher priority wins for its dates; existing bookings keep the price they were given.</p>
        <div className="ys-row">
          <Field label="Room type">
            <select value={form.roomTypeCode} onChange={set('roomTypeCode')}>{types.map((t) => <option key={t.code} value={t.code}>{t.code} · {t.name}</option>)}</select>
          </Field>
          <Field label="Season name"><input required value={form.seasonName} onChange={set('seasonName')} placeholder="e.g. Easter 2027" /></Field>
          <Field label="Priority"><input type="number" min={0} max={100} value={form.priority} onChange={set('priority')} /></Field>
        </div>
        <div className="ys-row">
          <Field label="Valid from"><input type="date" required value={form.validFrom} onChange={set('validFrom')} /></Field>
          <Field label="Valid to (inclusive, optional)"><input type="date" value={form.validTo} onChange={set('validTo')} /></Field>
        </div>
        <div className="ys-row">
          <Field label="Weekday (KES)"><input required inputMode="decimal" value={form.weekdayPrice} onChange={set('weekdayPrice')} /></Field>
          <Field label="Weekend (KES)"><input required inputMode="decimal" value={form.weekendPrice} onChange={set('weekendPrice')} /></Field>
          <Field label="Extra adult"><input inputMode="decimal" value={form.extraAdultPrice} onChange={set('extraAdultPrice')} /></Field>
          <Field label="Child"><input inputMode="decimal" value={form.childPrice} onChange={set('childPrice')} /></Field>
        </div>
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn" disabled={action.busy}>Add price</button>
        </div>
      </form>
    </Modal>
  );
}

export function RatesPage() {
  const { property, me } = useSession();
  const plans = useLoad(() => api.get<Array<RatePlan & { prices: Price[] }>>(`${base(property.code)}/rate-plans`), [property.code]);
  const types = useLoad(() => api.get<RoomType[]>(`${base(property.code)}/room-types`), [property.code]);
  const policy = useLoad(() => api.get<Policy>(`${base(property.code)}/policy`), [property.code]);
  const [adding, setAdding] = useState<RatePlan | null>(null);
  const [editingPolicy, setEditingPolicy] = useState(false);
  const canManage = hasPermission(me.roles, 'rate.manage');
  const canPolicy = hasPermission(me.roles, 'policy.manage');
  const p = policy.data;
  return (
    <>
      <div className="ys-page-head"><h1>Rates and policy · {property.name}</h1></div>
      <ErrorText error={plans.error ?? types.error ?? policy.error} />
      {types.data && (
        <section className="ys-section">
          <h2>Room types</h2>
          <table className="ys-table compact">
            <thead><tr><th>Code</th><th>Name</th><th>Rooms</th><th>Included guests</th><th>Max adults</th><th>Max guests</th></tr></thead>
            <tbody>
              {types.data.map((t) => (
                <tr key={t.code}><td>{t.code}</td><td>{t.name}</td><td>{t.roomCount}</td><td>{t.baseOccupancy}</td><td>{t.maxAdults}</td><td>{t.maxOccupancy}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {p && (
        <section className="ys-section ys-card">
          <div className="ys-page-head">
            <h2>Booking and hotel policies</h2>
            <span className="spacer" />
            {canPolicy && <button className="ys-btn small" onClick={() => setEditingPolicy(true)}>Edit policies</button>}
          </div>
          <p>
            Deposit: {p.depositType === 'none' ? 'none' : p.depositType === 'percent' ? `${Number(p.depositValue)}% of the stay` : `${Number(p.depositValue)} night(s)`}, due{' '}
            {p.depositDueDays} day(s) before arrival. Holds last {p.holdMinutes} minutes.
          </p>
          <p>
            Free cancellation up to {p.freeCancellationHours} hours before arrival, then {p.lateCancellationNights} night(s). No-show: {p.noShowNights} night(s).
          </p>
          <p>
            Check-in {p.checkInTime}, check-out {p.checkOutTime}. Early check-in {kes(p.earlyCheckInFee)}, late check-out {kes(p.lateCheckOutFee)}.
          </p>
          <p className="ys-muted">{p.refundPolicy}</p>
          <h3>Hotel policies</h3>
          {p.hotelPolicies ? <p className="ys-pre">{p.hotelPolicies}</p> : <p className="ys-muted">None written yet{canPolicy ? '. Use Edit policies to add the house rules.' : '.'}</p>}
        </section>
      )}
      {editingPolicy && p && <PolicyModal policy={p} onClose={() => setEditingPolicy(false)} onDone={() => { setEditingPolicy(false); policy.reload(); }} />}
      {(plans.data ?? []).map((plan) => (
        <section className="ys-section" key={plan.id}>
          <div className="ys-page-head">
            <h2>{plan.code} · {plan.name}</h2>
            {plan.isNegotiated && <StatusBadge status="negotiated" />}
            {plan.companyName && <span className="ys-muted">{plan.companyName}</span>}
            <span className="spacer" />
            {canManage && types.data && <button className="ys-btn small ghost" onClick={() => setAdding(plan)}>Add price</button>}
          </div>
          <table className="ys-table compact">
            <thead><tr><th>Type</th><th>Season</th><th>Dates</th><th>Priority</th><th>Weekday</th><th>Weekend</th><th>Extra adult</th><th>Child</th></tr></thead>
            <tbody>
              {plan.prices.map((pr) => (
                <tr key={pr.id}>
                  <td>{pr.roomTypeCode}</td><td>{pr.seasonName}</td><td>{pr.validFrom} → {pr.validTo ?? 'open'}</td><td>{pr.priority}</td>
                  <td>{kes(pr.weekdayPrice)}</td><td>{kes(pr.weekendPrice)}</td><td>{kes(pr.extraAdultPrice)}</td><td>{kes(pr.childPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {adding && types.data && <AddPriceModal plan={adding} types={types.data} onClose={() => setAdding(null)} onDone={() => { setAdding(null); plans.reload(); }} />}
    </>
  );
}
