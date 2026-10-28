import { useState } from 'react';
import { hasPermission, HOUSE_ACCOUNT_KINDS, SERVICE_TYPES } from '@hotel/shared';
import { api } from '../api';
import { base, ErrorText, Field, kes, label, Modal, openPrintable, StatusBadge, useAction, useLoad, useSession } from '../ui';

/**
 * Back office for the point of sale: trading days and the Z close, business-day
 * cut-off and outlet POS settings (CFG-01, CFG-03), outlet price lists and
 * availability (POS-03, POS-12, POS-19), cashier shifts and variance review
 * (POS-13), house accounts (POS-18) and sales (RPT-03 basics).
 */

const pos = (code: string) => `${base(code)}/pos`;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface PosOutletStatus {
  id: string;
  code: string;
  name: string;
  type: string;
  cutoff: string;
  ownCutoff: string | null;
  dayId: string | null;
  dayDate: string | null;
  openChecks: number;
  openShifts: number;
  lastClosed: string | null;
  closeDue: boolean;
  localTime: string;
}

interface Totals {
  checks: { closed: number; open: number; void: number; merged: number; covers: number };
  grossSales: string;
  ruleDiscounts: string;
  discounts: string;
  comps: string;
  netSales: string;
  netExTax: string;
  tax: string;
  taxes: Array<{ taxCode: string; name: string | null; ratePercent: string; taxableAmount: string; taxAmount: string }>;
  settlements: { payments: Array<{ tender: string; amount: string; count: number }>; roomCharges: { amount: string; count: number }; total: string };
  houseAccounts: { total: string; accounts: Array<{ code: string; name: string; amount: string; checks: number }> };
  refunds: { total: string; byTender: Array<{ tender: string; amount: string; count: number }> };
  netAfterRefunds: string;
  corrections: { cancelled: { lines: number; listValue: string }; wasted: { lines: number; listValue: string } };
  byCategory: Array<{ code: string; name: string; quantity: string; amount: string }>;
  topItems: Array<{ name: string; quantity: string; amount: string }>;
  byWaiter: Array<{ waiter: string; checks: number; amount: string }>;
  reconciliation: { netSales: string; settled: string; difference: string };
  empty?: boolean;
}

interface Day {
  id: string;
  businessDate: string;
  status: 'open' | 'closed';
  outletCode?: string;
  outletName?: string;
  openedAt: string;
  closedAt: string | null;
  closedBy: string | null;
  totals: Totals | null;
}

function TotalsView({ t }: { t: Totals }) {
  if (t.empty) return <p className="ys-muted">No trading on this day.</p>;
  return (
    <div className="ys-form">
      <div className="ys-tiles small">
        <div className="ys-tile"><strong>{kes(t.netSales)}</strong><span>Net sales (incl. tax)</span></div>
        <div className="ys-tile"><strong>{t.checks.closed}</strong><span>Checks closed</span></div>
        <div className="ys-tile"><strong>{t.checks.covers}</strong><span>Covers</span></div>
        <div className={`ys-tile${t.reconciliation.difference !== '0.00' ? ' alert' : ''}`}><strong>{kes(t.reconciliation.difference)}</strong><span>Unsettled difference</span></div>
      </div>
      <div className="ys-grid">
        <table className="ys-table compact">
          <tbody>
            <tr><td>Gross sales</td><td className="ys-nowrap">{kes(t.grossSales)}</td></tr>
            <tr><td>Happy hour and price rules</td><td>−{kes(t.ruleDiscounts)}</td></tr>
            <tr><td>Discounts</td><td>−{kes(t.discounts)}</td></tr>
            <tr><td>Complimentary</td><td>−{kes(t.comps)}</td></tr>
            <tr><td><strong>Net sales</strong></td><td><strong>{kes(t.netSales)}</strong></td></tr>
            <tr><td>Net of tax</td><td>{kes(t.netExTax)}</td></tr>
            {t.taxes.map((x) => (
              <tr key={x.taxCode}><td>{x.taxCode} {Number(x.ratePercent)}% {x.name ?? ''}</td><td>{kes(x.taxAmount)}</td></tr>
            ))}
          </tbody>
        </table>
        <table className="ys-table compact">
          <tbody>
            {t.settlements.payments.map((p) => (
              <tr key={p.tender}><td>{label(p.tender)} ({p.count})</td><td className="ys-nowrap">{kes(p.amount)}</td></tr>
            ))}
            <tr><td>Charged to rooms ({t.settlements.roomCharges.count})</td><td>{kes(t.settlements.roomCharges.amount)}</td></tr>
            <tr><td><strong>Total settled</strong></td><td><strong>{kes(t.settlements.total)}</strong></td></tr>
            <tr><td>Refunds</td><td>−{kes(t.refunds.total)}</td></tr>
            <tr><td>House accounts (not revenue)</td><td>{kes(t.houseAccounts.total)}</td></tr>
            <tr><td>Cancelled lines ({t.corrections.cancelled.lines})</td><td>{kes(t.corrections.cancelled.listValue)}</td></tr>
            <tr><td>Waste lines ({t.corrections.wasted.lines})</td><td>{kes(t.corrections.wasted.listValue)}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="ys-grid">
        <table className="ys-table compact">
          <thead><tr><th>Category</th><th>Qty</th><th>Amount</th></tr></thead>
          <tbody>{t.byCategory.map((c) => <tr key={c.code}><td>{c.name}</td><td>{Number(c.quantity)}</td><td>{kes(c.amount)}</td></tr>)}</tbody>
        </table>
        <table className="ys-table compact">
          <thead><tr><th>Server</th><th>Checks</th><th>Amount</th></tr></thead>
          <tbody>{t.byWaiter.map((w) => <tr key={w.waiter}><td>{w.waiter}</td><td>{w.checks}</td><td>{kes(w.amount)}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trading days and Z close
// ---------------------------------------------------------------------------
function CloseOutletDay({ outlet, onClose, onDone }: { outlet: PosOutletStatus; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const { data, error } = useLoad(() => api.get<Day>(`${pos(property.code)}/days/${outlet.dayId}`), [outlet.dayId]);
  const action = useAction<{ dayId: string; totals: Totals }>();
  const [closed, setClosed] = useState<{ dayId: string } | null>(null);
  return (
    <Modal title={`${closed ? 'Z report' : 'Close POS day'} · ${outlet.name} · ${outlet.dayDate}`} onClose={closed ? onDone : onClose} wide>
      <ErrorText error={error} />
      {!data ? <p className="ys-muted">Loading…</p> : data.totals && <TotalsView t={data.totals} />}
      {!closed && (outlet.openChecks > 0 || outlet.openShifts > 0) && (
        <p className="ys-warn">
          {outlet.openChecks} open check(s) and {outlet.openShifts} open cash shift(s). Settle, transfer or void the checks and count the shifts first.
        </p>
      )}
      <ErrorText error={action.error} />
      <div className="ys-actions">
        {closed ? (
          <>
            <button className="ys-btn ghost" onClick={() => openPrintable(`${pos(property.code)}/days/${closed.dayId}/print`)}>Print Z report</button>
            <button className="ys-btn" onClick={onDone}>Done</button>
          </>
        ) : (
          <>
            <button className="ys-btn ghost" onClick={() => openPrintable(`${pos(property.code)}/days/${outlet.dayId}/print`)}>Print X report</button>
            <button className="ys-btn ghost" onClick={onClose}>Cancel</button>
            <button
              className="ys-btn"
              disabled={action.busy}
              onClick={async () => {
                const r = await action.run(({ key }) => api.post(`${pos(property.code)}/outlets/${outlet.code}/close-day`, { businessDate: outlet.dayDate }, key));
                if (r) setClosed({ dayId: r.dayId });
              }}
            >
              Close the day
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

function OutletHistory({ outlet, onClose }: { outlet: PosOutletStatus; onClose: () => void }) {
  const { property } = useSession();
  const { data, error } = useLoad(() => api.get<Day[]>(`${pos(property.code)}/outlets/${outlet.code}/days`), [outlet.code]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Modal title={`Trading days · ${outlet.name}`} onClose={onClose} wide>
      <ErrorText error={error} />
      <table className="ys-table compact">
        <thead><tr><th>Date</th><th>Status</th><th>Closed by</th><th>Net sales</th><th>Checks</th><th /></tr></thead>
        <tbody>
          {(data ?? []).map((d) => (
            <tr key={d.id}>
              <td>{d.businessDate}</td>
              <td><StatusBadge status={d.status} /></td>
              <td>{d.closedBy ?? '—'}</td>
              <td>{d.totals?.empty ? 'No trading' : kes(d.totals?.netSales)}</td>
              <td>{d.totals?.checks?.closed ?? '—'}</td>
              <td className="ys-actions-cell">
                <button className="ys-btn small ghost" onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? 'Hide' : 'Totals'}</button>
                <button className="ys-btn small ghost" onClick={() => openPrintable(`${pos(property.code)}/days/${d.id}/print`)}>Print</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && data?.find((d) => d.id === open)?.totals && <TotalsView t={data.find((d) => d.id === open)!.totals!} />}
    </Modal>
  );
}

export function PosDaysPage() {
  const { property, me } = useSession();
  const { data, error, reload } = useLoad(() => api.get<PosOutletStatus[]>(`${pos(property.code)}/outlets`), [property.code]);
  const [closing, setClosing] = useState<PosOutletStatus | null>(null);
  const [history, setHistory] = useState<PosOutletStatus | null>(null);
  const canClose = hasPermission(me.roles, 'pos.day_close');
  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="ys-muted">Loading…</p>;
  const due = data.filter((o) => o.closeDue);
  return (
    <>
      <div className="ys-page-head">
        <h1>POS trading days · {property.name}</h1>
        <span className="spacer" />
        <button className="ys-btn ghost" onClick={reload}>Refresh</button>
      </div>
      <p className="ys-muted">
        Each outlet’s trading day runs from its cut-off to the next morning’s cut-off. A day opens with its first check or cash shift and is
        closed here by a manager; closing freezes the Z totals. The property’s business day can only be closed once the POS days of that date are
        closed (empty days close themselves).
      </p>
      {due.length > 0 && <p className="ys-warn">Past their cut-off and still open: {due.map((o) => o.name).join(', ')}.</p>}
      <table className="ys-table">
        <thead>
          <tr><th>Outlet</th><th>Cut-off</th><th>Open day</th><th>Open checks</th><th>Open shifts</th><th>Last closed</th><th /></tr>
        </thead>
        <tbody>
          {data.map((o) => (
            <tr key={o.id}>
              <td>{o.name} <span className="ys-muted">{o.code}</span></td>
              <td>{o.cutoff}{o.ownCutoff ? ' (own)' : ''}</td>
              <td>{o.dayDate ? <>{o.dayDate} {o.closeDue && <span className="ys-badge st-late">close due</span>}</> : <span className="ys-muted">—</span>}</td>
              <td>{o.openChecks || ''}</td>
              <td>{o.openShifts || ''}</td>
              <td>{o.lastClosed ?? '—'}</td>
              <td className="ys-actions-cell">
                {o.dayId && canClose && <button className="ys-btn small" onClick={() => setClosing(o)}>Close day…</button>}
                <button className="ys-btn small ghost" onClick={() => setHistory(o)}>Z reports</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {closing && <CloseOutletDay outlet={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); reload(); }} />}
      {history && <OutletHistory outlet={history} onClose={() => setHistory(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Business day and POS settings (CFG-01, CFG-03)
// ---------------------------------------------------------------------------
interface OutletSettings {
  id: string;
  code: string;
  name: string;
  type: string;
  isActive: boolean;
  posEnabled: boolean;
  sellsAlcohol: boolean;
  businessDayCutoff: string | null;
  serviceTypes: string[];
  liquorPolicy: 'block' | 'warn';
  stockPolicy: 'block' | 'warn';
  liquorHours: Array<{ weekday: number; opensAt: string; closesAt: string }>;
  routes: { kitchen?: string; bar?: string };
}
interface Settings {
  property: { code: string; name: string; timezone: string; businessDayCutoff: string; posDiscountFreePercent: string; currentBusinessDate: string };
  outlets: OutletSettings[];
  stations: Array<{ code: string; name: string; kind: string; isActive: boolean }>;
}

function PropertySettingsForm({ s, onDone }: { s: Settings; onDone: () => void }) {
  const { property } = useSession();
  const [cutoff, setCutoff] = useState(s.property.businessDayCutoff);
  const [free, setFree] = useState(s.property.posDiscountFreePercent);
  const action = useAction();
  return (
    <form
      className="ys-card ys-section ys-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await action.run(() => api.put(`${pos(property.code)}/settings`, { businessDayCutoff: cutoff, posDiscountFreePercent: String(Number(free)) }))) onDone();
      }}
    >
      <h2>Business day</h2>
      <div className="ys-row">
        <Field label="Day cut-off" hint="Sales before this time belong to the previous trading day. Applies from the next trading day.">
          <input type="time" required value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
        </Field>
        <Field label="Discount without approval (%)" hint="Larger discounts need a manager; 100% is a comp and always needs one.">
          <input type="number" min={0} max={100} step="0.01" required value={free} onChange={(e) => setFree(e.target.value)} />
        </Field>
      </div>
      <ErrorText error={action.error} />
      <div className="ys-actions"><button className="ys-btn" disabled={action.busy}>Save</button></div>
    </form>
  );
}

function OutletSettingsModal({ o, s, onClose, onDone }: { o: OutletSettings; s: Settings; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const [form, setForm] = useState({
    posEnabled: o.posEnabled,
    ownCutoff: o.businessDayCutoff !== null,
    cutoff: o.businessDayCutoff ?? s.property.businessDayCutoff,
    serviceTypes: o.serviceTypes,
    liquorPolicy: o.liquorPolicy,
    stockPolicy: o.stockPolicy,
    kitchen: o.routes.kitchen ?? '',
    bar: o.routes.bar ?? '',
  });
  const [hours, setHours] = useState(
    WEEKDAYS.map((_, i) => {
      const h = o.liquorHours.find((x) => x.weekday === i + 1);
      return { on: Boolean(h), opensAt: h?.opensAt ?? '10:00', closesAt: h?.closesAt ?? '23:00' };
    }),
  );
  const action = useAction();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      posEnabled: form.posEnabled,
      businessDayCutoff: form.ownCutoff ? form.cutoff : null,
      serviceTypes: form.serviceTypes,
      liquorPolicy: form.liquorPolicy,
      stockPolicy: form.stockPolicy,
      routes: { kitchen: form.kitchen || null, bar: form.bar || null },
      ...(o.sellsAlcohol ? { liquorHours: hours.flatMap((h, i) => (h.on ? [{ weekday: i + 1, opensAt: h.opensAt, closesAt: h.closesAt }] : [])) } : {}),
    };
    if (await action.run(() => api.put(`${pos(property.code)}/outlets/${o.code}/settings`, body))) onDone();
  }
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  return (
    <Modal title={`${o.name} · POS settings`} onClose={onClose} wide>
      <form className="ys-form" onSubmit={submit}>
        <label className="ys-check"><input type="checkbox" checked={form.posEnabled} onChange={(e) => set({ posEnabled: e.target.checked })} /> Sells on the POS</label>
        <div className="ys-row">
          <label className="ys-check"><input type="checkbox" checked={form.ownCutoff} onChange={(e) => set({ ownCutoff: e.target.checked })} /> Own day cut-off</label>
          <Field label={form.ownCutoff ? 'Cut-off' : `Uses the property cut-off (${s.property.businessDayCutoff})`}>
            <input type="time" disabled={!form.ownCutoff} value={form.cutoff} onChange={(e) => set({ cutoff: e.target.value })} />
          </Field>
        </div>
        <fieldset>
          <legend>Service types</legend>
          {SERVICE_TYPES.map((t) => (
            <label className="ys-check" key={t}>
              <input
                type="checkbox"
                checked={form.serviceTypes.includes(t)}
                onChange={(e) => set({ serviceTypes: e.target.checked ? [...form.serviceTypes, t] : form.serviceTypes.filter((x) => x !== t) })}
              />{' '}
              {label(t)}
            </label>
          ))}
        </fieldset>
        <div className="ys-row">
          <Field label="Kitchen tickets go to">
            <select value={form.kitchen} onChange={(e) => set({ kitchen: e.target.value })}>
              <option value="">(no ticket)</option>
              {s.stations.filter((x) => x.isActive).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
            </select>
          </Field>
          <Field label="Bar tickets go to">
            <select value={form.bar} onChange={(e) => set({ bar: e.target.value })}>
              <option value="">(no ticket)</option>
              {s.stations.filter((x) => x.isActive).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
            </select>
          </Field>
          <Field label="When stock runs out">
            <select value={form.stockPolicy} onChange={(e) => set({ stockPolicy: e.target.value as 'block' | 'warn' })}>
              <option value="warn">Warn the waiter</option><option value="block">Block the sale</option>
            </select>
          </Field>
        </div>
        {o.sellsAlcohol && (
          <fieldset>
            <legend>Licensed alcohol hours (POS-17)</legend>
            <Field label="Outside these hours">
              <select value={form.liquorPolicy} onChange={(e) => set({ liquorPolicy: e.target.value as 'block' | 'warn' })}>
                <option value="block">Block; a manager can override with a reason</option><option value="warn">Warn only</option>
              </select>
            </Field>
            <table className="ys-table compact">
              <thead><tr><th>Day</th><th>Sells</th><th>Opens</th><th>Closes</th></tr></thead>
              <tbody>
                {hours.map((h, i) => (
                  <tr key={i}>
                    <td>{WEEKDAYS[i]}</td>
                    <td><input type="checkbox" checked={h.on} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} /></td>
                    <td><input type="time" disabled={!h.on} value={h.opensAt} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, opensAt: e.target.value } : x)))} /></td>
                    <td><input type="time" disabled={!h.on} value={h.closesAt} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, closesAt: e.target.value } : x)))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <small className="ys-muted">A closing time at or before the opening time runs past midnight (e.g. 18:00 to 02:00).</small>
          </fieldset>
        )}
        <ErrorText error={action.error} />
        <div className="ys-actions">
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn" disabled={action.busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

function HouseAccounts() {
  const { property, me } = useSession();
  const { data, error, reload } = useLoad(
    () => api.get<Array<{ id: string; code: string; name: string; kind: string; monthlyLimit: string | null; costCentre: string | null; usedThisMonth: string }>>(`${pos(property.code)}/house-accounts`),
    [property.code],
  );
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', kind: 'staff_meals', monthlyLimit: '', costCentre: '' });
  const action = useAction();
  return (
    <section className="ys-card ys-section">
      <div className="ys-page-head">
        <h2>House accounts (POS-18)</h2>
        <span className="spacer" />
        {hasPermission(me.roles, 'pos.menu.manage') && <button className="ys-btn small" onClick={() => setAdding(true)}>Add account</button>}
      </div>
      <p className="ys-muted">Staff meals, directors and management entertainment. Kept out of sales; each charge needs a manager and a reason.</p>
      <ErrorText error={error} />
      <table className="ys-table compact">
        <thead><tr><th>Code</th><th>Name</th><th>Kind</th><th>Cost centre</th><th>Used this month</th><th>Monthly limit</th></tr></thead>
        <tbody>
          {(data ?? []).map((a) => (
            <tr key={a.id}><td>{a.code}</td><td>{a.name}</td><td>{label(a.kind)}</td><td>{a.costCentre ?? '—'}</td><td>{kes(a.usedThisMonth)}</td><td>{a.monthlyLimit ? kes(a.monthlyLimit) : 'No limit'}</td></tr>
          ))}
        </tbody>
      </table>
      {adding && (
        <Modal title="Add house account" onClose={() => setAdding(false)}>
          <form
            className="ys-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await action.run(({ key }) =>
                api.post(`${pos(property.code)}/house-accounts`, { ...form, code: form.code.toUpperCase(), monthlyLimit: form.monthlyLimit || null, costCentre: form.costCentre || null }, key),
              );
              if (ok) {
                setAdding(false);
                reload();
              }
            }}
          >
            <div className="ys-row">
              <Field label="Code"><input required pattern="[A-Za-z0-9-]{2,16}" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
              <Field label="Name"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            </div>
            <div className="ys-row">
              <Field label="Kind">
                <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  {HOUSE_ACCOUNT_KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}
                </select>
              </Field>
              <Field label="Monthly limit (KES)" hint="Empty for no limit"><input inputMode="decimal" value={form.monthlyLimit} onChange={(e) => setForm({ ...form, monthlyLimit: e.target.value })} /></Field>
              <Field label="Cost centre"><input value={form.costCentre} onChange={(e) => setForm({ ...form, costCentre: e.target.value })} /></Field>
            </div>
            <ErrorText error={action.error} />
            <div className="ys-actions"><button className="ys-btn" disabled={action.busy}>Add</button></div>
          </form>
        </Modal>
      )}
    </section>
  );
}

export function PosSettingsPage() {
  const { property, me } = useSession();
  const { data, error, reload } = useLoad(() => api.get<Settings>(`${pos(property.code)}/settings`), [property.code]);
  const [editing, setEditing] = useState<OutletSettings | null>(null);
  const canEdit = hasPermission(me.roles, 'businessday.configure');
  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="ys-muted">Loading…</p>;
  return (
    <>
      <h1>Business day and POS settings · {property.name}</h1>
      {canEdit ? (
        <PropertySettingsForm key={JSON.stringify(data.property)} s={data} onDone={reload} />
      ) : (
        <p>Day cut-off <strong>{data.property.businessDayCutoff}</strong> · discounts up to {Number(data.property.posDiscountFreePercent)}% without approval</p>
      )}
      <section className="ys-card ys-section">
        <h2>Outlets</h2>
        <table className="ys-table compact">
          <thead><tr><th>Outlet</th><th>POS</th><th>Cut-off</th><th>Service</th><th>Tickets</th><th>Alcohol hours</th><th>Stock</th><th /></tr></thead>
          <tbody>
            {data.outlets.filter((o) => o.isActive).map((o) => (
              <tr key={o.id}>
                <td>{o.name} <span className="ys-muted">{o.code}</span></td>
                <td>{o.posEnabled ? 'Yes' : <span className="ys-muted">No</span>}</td>
                <td>{o.businessDayCutoff ? <strong>{o.businessDayCutoff}</strong> : <span className="ys-muted">{data.property.businessDayCutoff}</span>}</td>
                <td>{o.posEnabled ? o.serviceTypes.map(label).join(', ') : ''}</td>
                <td>{o.posEnabled ? [o.routes.kitchen && `food → ${o.routes.kitchen}`, o.routes.bar && `drinks → ${o.routes.bar}`].filter(Boolean).join(', ') : ''}</td>
                <td>{o.sellsAlcohol ? (o.liquorHours.length ? `${o.liquorHours.length} day(s), ${o.liquorPolicy}` : <span className="ys-warn-text">none set</span>) : ''}</td>
                <td>{o.posEnabled ? o.stockPolicy : ''}</td>
                <td>{canEdit && <button className="ys-btn small ghost" onClick={() => setEditing(o)}>Edit</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <HouseAccounts />
      {editing && <OutletSettingsModal o={editing} s={data} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Outlet menus and prices (POS-03, POS-12, POS-19)
// ---------------------------------------------------------------------------
interface OutletMenu {
  outlet: { code: string; name: string };
  categories: Array<{ code: string; name: string }>;
  items: Array<{ priceId: string; code: string; name: string; categoryCode: string; portionCode: string; portionName: string; price: string; isAvailable: boolean; isFavourite: boolean; stockRemaining: string | null; isAlcohol: boolean }>;
}

function PriceRow({ item, outletCode, canManage, onSaved }: { item: OutletMenu['items'][number]; outletCode: string; canManage: boolean; onSaved: () => void }) {
  const { property } = useSession();
  const [price, setPrice] = useState(item.price);
  const [stock, setStock] = useState(item.stockRemaining === null ? '' : String(Number(item.stockRemaining)));
  const action = useAction();
  const dirty = price !== item.price || stock !== (item.stockRemaining === null ? '' : String(Number(item.stockRemaining)));
  return (
    <tr>
      <td>{item.name}{item.portionName ? ` (${item.portionName})` : ''} {item.isAlcohol && <span className="ys-badge">alcohol</span>}</td>
      <td>{canManage ? <input aria-label="Price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: 110 }} /> : kes(item.price)}</td>
      <td>{canManage ? <input aria-label="Portions left" inputMode="decimal" placeholder="not counted" value={stock} onChange={(e) => setStock(e.target.value)} style={{ width: 110 }} /> : stock}</td>
      <td>
        <label className="ys-check">
          <input
            type="checkbox"
            checked={item.isAvailable}
            onChange={async (e) => {
              const v = e.target.checked;
              if (await action.run(({ key }) => api.post(`${pos(property.code)}/outlets/${outletCode}/prices/${item.priceId}/availability`, { isAvailable: v }, key))) onSaved();
            }}
          />{' '}
          {item.isAvailable ? 'On sale' : 'Not available'}
        </label>
      </td>
      <td>
        {canManage && (
          <label className="ys-check">
            <input
              type="checkbox"
              checked={item.isFavourite}
              onChange={async (e) => {
                const v = e.target.checked;
                if (await action.run(() => api.patch(`${pos(property.code)}/outlets/${outletCode}/prices/${item.priceId}`, { isFavourite: v }))) onSaved();
              }}
            />{' '}
            ★
          </label>
        )}
      </td>
      <td className="ys-actions-cell">
        {canManage && dirty && (
          <button
            className="ys-btn small"
            disabled={action.busy}
            onClick={async () => {
              if (await action.run(() => api.patch(`${pos(property.code)}/outlets/${outletCode}/prices/${item.priceId}`, { price, stockRemaining: stock === '' ? null : stock }))) onSaved();
            }}
          >
            Save
          </button>
        )}
        <ErrorText error={action.error} />
      </td>
    </tr>
  );
}

function CopyOutletModal({ outlets, to, onClose, onDone }: { outlets: PosOutletStatus[]; to: string; onClose: () => void; onDone: () => void }) {
  const [from, setFrom] = useState('');
  const action = useAction<{ pricesCopied: number; liquorHoursCopied: number }>();
  return (
    <Modal title={`Copy a template into ${to}`} onClose={onClose}>
      <form
        className="ys-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await action.run(({ key }) => api.post('/pos/outlets/copy', { fromOutletCode: from, toOutletCode: to }, key));
          if (r) onDone();
        }}
      >
        <p className="ys-muted">Copies prices, availability, favourites, service types, policies, cut-off and liquor hours. Tables and printers are not copied.</p>
        <Field label="Copy from (outlet code, any property you can see)">
          <input required list="ys-outlets" value={from} onChange={(e) => setFrom(e.target.value.toUpperCase())} placeholder="e.g. K1-COCKTAIL" />
          <datalist id="ys-outlets">{outlets.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}</datalist>
        </Field>
        <ErrorText error={action.error} />
        <div className="ys-actions"><button className="ys-btn" disabled={action.busy}>Copy</button></div>
      </form>
    </Modal>
  );
}

export function PosMenuPage() {
  const { property, me } = useSession();
  const outlets = useLoad(() => api.get<PosOutletStatus[]>(`${pos(property.code)}/outlets`), [property.code]);
  const [outlet, setOutlet] = useState('');
  const code = outlet || outlets.data?.[0]?.code || '';
  const menu = useLoad(() => (code ? api.get<OutletMenu>(`${pos(property.code)}/outlets/${code}/menu`) : Promise.resolve(null)), [property.code, code]);
  const [category, setCategory] = useState('');
  const [copying, setCopying] = useState(false);
  const canManage = hasPermission(me.roles, 'pos.menu.manage');
  return (
    <>
      <div className="ys-page-head">
        <h1>Menus and prices</h1>
        <span className="spacer" />
        <Field label="Outlet">
          <select value={code} onChange={(e) => setOutlet(e.target.value)}>
            {(outlets.data ?? []).map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
          </select>
        </Field>
        {canManage && code && <button className="ys-btn ghost" onClick={() => setCopying(true)}>Copy from template…</button>}
      </div>
      <p className="ys-muted">Prices include VAT and catering levy and apply to this outlet only. A change never alters orders already taken.</p>
      <ErrorText error={outlets.error ?? menu.error} />
      {menu.data && (
        <>
          <div className="ys-segmented">
            <button aria-pressed={category === ''} onClick={() => setCategory('')}>All</button>
            {menu.data.categories.map((c) => <button key={c.code} aria-pressed={category === c.code} onClick={() => setCategory(c.code)}>{c.name}</button>)}
          </div>
          <table className="ys-table compact">
            <thead><tr><th>Item</th><th>Price (KES)</th><th>Portions left today</th><th>Availability</th><th>Favourite</th><th /></tr></thead>
            <tbody>
              {menu.data.items.filter((i) => !category || i.categoryCode === category).map((i) => (
                <PriceRow key={`${i.priceId}-${i.price}-${i.isAvailable}-${i.isFavourite}-${i.stockRemaining}`} item={i} outletCode={code} canManage={canManage} onSaved={menu.reload} />
              ))}
            </tbody>
          </table>
        </>
      )}
      {copying && <CopyOutletModal outlets={outlets.data ?? []} to={code} onClose={() => setCopying(false)} onDone={() => { setCopying(false); menu.reload(); }} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Cashier shifts (POS-13)
// ---------------------------------------------------------------------------
interface ShiftRow {
  id: string;
  number: string;
  outletName: string;
  cashier: string;
  status: string;
  businessDate: string;
  openingFloat: string;
  openedAt: string;
  closedAt: string | null;
  countedAmount: string | null;
  expectedAmount: string | null;
  variance: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
}

function ReviewShift({ shift, onClose, onDone }: { shift: ShiftRow; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const { data } = useLoad(
    () => api.get<ShiftRow & { breakdown: Record<string, string>; movements: Array<{ kind: string; amount: string; reason: string; by: string }> }>(`${pos(property.code)}/shifts/${shift.id}`),
    [shift.id],
  );
  const [note, setNote] = useState('');
  const action = useAction();
  const b = data?.breakdown;
  return (
    <Modal title={`Shift ${shift.number} · ${shift.cashier}`} onClose={onClose}>
      <div className="ys-form">
        {b && (
          <table className="ys-table compact">
            <tbody>
              <tr><td>Opening float</td><td>{kes(b.openingFloat)}</td></tr>
              <tr><td>Cash sales</td><td>{kes(b.cashSales)}</td></tr>
              <tr><td>Paid in</td><td>{kes(b.paidIn)}</td></tr>
              <tr><td>Paid out</td><td>−{kes(b.paidOut)}</td></tr>
              <tr><td>Drops to safe</td><td>−{kes(b.drops)}</td></tr>
              <tr><td>Cash refunds</td><td>−{kes(b.cashRefunds)}</td></tr>
              <tr><td><strong>Expected</strong></td><td><strong>{kes(b.expected)}</strong></td></tr>
              <tr><td>Counted</td><td>{kes(shift.countedAmount)}</td></tr>
              <tr><td><strong>Variance</strong></td><td><strong>{kes(shift.variance)}</strong></td></tr>
            </tbody>
          </table>
        )}
        {data?.movements.length ? <ul className="ys-notes">{data.movements.map((m, i) => <li key={i}>{label(m.kind)} {kes(m.amount)}: {m.reason} ({m.by})</li>)}</ul> : null}
        {shift.reviewedAt ? (
          <p>Reviewed by {shift.reviewedBy}: {shift.reviewNote}</p>
        ) : shift.status === 'closed' ? (
          <form
            className="ys-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await action.run(({ key, approval }) => api.post(`${pos(property.code)}/shifts/${shift.id}/review`, { note, approval }, key))) onDone();
            }}
          >
            <Field label="Review note"><input required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Short 50, cashier to repay" /></Field>
            {action.approvalFields}
            <ErrorText error={action.error} />
            <div className="ys-actions"><button className="ys-btn" disabled={action.busy}>Sign off</button></div>
          </form>
        ) : (
          <p className="ys-muted">The shift is still open; the cashier counts and closes it on the tablet.</p>
        )}
      </div>
    </Modal>
  );
}

export function PosShiftsPage() {
  const { property } = useSession();
  const [filter, setFilter] = useState<'all' | 'open' | 'unreviewed'>('unreviewed');
  const { data, error, reload } = useLoad(
    () => api.get<ShiftRow[]>(`${pos(property.code)}/shifts${filter === 'open' ? '?status=open' : filter === 'unreviewed' ? '?unreviewed=true' : ''}`),
    [property.code, filter],
  );
  const [review, setReview] = useState<ShiftRow | null>(null);
  return (
    <>
      <div className="ys-page-head">
        <h1>Cash shifts · {property.name}</h1>
        <span className="spacer" />
        <div className="ys-segmented">
          {(['unreviewed', 'open', 'all'] as const).map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'unreviewed' ? 'Variances to review' : label(f)}</button>
          ))}
        </div>
      </div>
      <ErrorText error={error} />
      <table className="ys-table">
        <thead><tr><th>Shift</th><th>Outlet</th><th>Cashier</th><th>Day</th><th>Status</th><th>Float</th><th>Expected</th><th>Counted</th><th>Variance</th><th>Review</th></tr></thead>
        <tbody>
          {data?.length === 0 && <tr><td colSpan={10} className="ys-muted">Nothing here.</td></tr>}
          {(data ?? []).map((s) => (
            <tr key={s.id} className="ys-click" onClick={() => setReview(s)}>
              <td>{s.number}</td><td>{s.outletName}</td><td>{s.cashier}</td><td>{s.businessDate}</td><td><StatusBadge status={s.status} /></td>
              <td>{kes(s.openingFloat)}</td><td>{kes(s.expectedAmount)}</td><td>{kes(s.countedAmount)}</td>
              <td className={s.variance && Number(s.variance) !== 0 ? 'ys-warn-text' : ''}>{kes(s.variance)}</td>
              <td>{s.reviewedAt ? `✓ ${s.reviewedBy}` : s.status === 'closed' && Number(s.variance) !== 0 ? 'Needed' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {review && <ReviewShift shift={review} onClose={() => setReview(null)} onDone={() => { setReview(null); reload(); }} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sales (RPT-03 basics)
// ---------------------------------------------------------------------------
export function PosSalesPage() {
  const { property } = useSession();
  const [from, setFrom] = useState(property.currentBusinessDate);
  const [to, setTo] = useState(property.currentBusinessDate);
  const [outlet, setOutlet] = useState('');
  const outlets = useLoad(() => api.get<PosOutletStatus[]>(`${pos(property.code)}/outlets`), [property.code]);
  const { data, error } = useLoad(
    () => api.get<Totals & { byOutlet: Array<{ code: string; name: string; checks: number; netSales: string }> }>(`${pos(property.code)}/reports/sales?from=${from}&to=${to}${outlet ? `&outlet=${outlet}` : ''}`),
    [property.code, from, to, outlet],
  );
  return (
    <>
      <div className="ys-page-head">
        <h1>POS sales · {property.name}</h1>
        <span className="spacer" />
        <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Outlet">
          <select value={outlet} onChange={(e) => setOutlet(e.target.value)}>
            <option value="">All outlets</option>
            {(outlets.data ?? []).map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
          </select>
        </Field>
      </div>
      <p className="ys-muted">By trading date. Revenue is counted once, from closed checks; room charges are a way of settling, and house accounts are not sales.</p>
      <ErrorText error={error} />
      {data && (
        <>
          <TotalsView t={data} />
          {!outlet && (
            <table className="ys-table compact">
              <thead><tr><th>Outlet</th><th>Checks</th><th>Net sales</th></tr></thead>
              <tbody>{data.byOutlet.map((o) => <tr key={o.code}><td>{o.name}</td><td>{o.checks}</td><td>{kes(o.netSales)}</td></tr>)}</tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}
