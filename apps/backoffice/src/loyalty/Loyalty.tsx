import { useState } from 'react';
import { hasPermission } from '@hotel/shared';
import { api } from '../api';
import { base, ErrorText, Field, kes, label, Modal, openPrintable, StatusBadge, useAction, useLoad, useSession } from '../ui';

/**
 * Loyalty and club in the back office (addendum v1.2): member lookup and
 * enrolment at reception (LOY11), member profile, balances and history
 * (LOY17), corrections, merges and the club (LOY24, CLUB01), programme
 * settings (LOY01), month-end cashback preview and approval (CLUB03, CLUB04)
 * and the loyalty reports (LOY19, LOY21, LOY22).
 */

const loyalty = (code: string) => `${base(code)}/loyalty`;
const pts = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-KE'));
const when = (v: string | null | undefined) => (v ? new Date(v).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const thisMonth = () => new Date().toISOString().slice(0, 7);

interface MemberSummary {
  id: string;
  number: string;
  kind: 'individual' | 'corporate';
  name: string;
  phone: string | null;
  status: string;
  staffFlagged: boolean;
  points: { available: string; value: string; reserved: string; pendingEligible: string; expiring: { date: string; amount: string } | null; deficit: string };
  wallet: { available: string; reserved: string; pendingCashback: string; expiring: { date: string; amount: string } | null; deficit: string };
  club: { tier: string; discountPercent: string; cashbackPercent: string } | null;
}

interface MemberDetail extends MemberSummary {
  profile?: {
    email: string | null; enrolmentChannel: string; enrolledAt: string; enrolledAt_property: string | null; company: string | null; companyId: string | null;
    guestId: string | null; staffUsername: string | null; marketingConsentAt: string | null; programmeAcceptedAt: string; phoneVerifiedAt: string | null;
  };
  clubMembership?: { tierCode: string; tierName: string; status: string; startsOn: string; endsOn: string | null } | null;
  overrides?: Array<{ discountPercent: string | null; cashbackPercent: string | null; effectiveFrom: string; effectiveTo: string | null; reason: string; approvedBy: string }>;
  mergedFrom?: Array<{ number: string; displayName: string }>;
  card?: { qr: string };
  selfServicePath?: string;
}

const TYPE: Record<string, string> = {
  earn: 'Earned', credit: 'Cashback credited', redeem: 'Used', restore: 'Restored (return)', reverse: 'Reversed (return)',
  adjust: 'Adjustment', expire: 'Expired', merge_in: 'Merged in', merge_out: 'Merged out',
};

// ---------------------------------------------------------------------------
// Enrolment (reception) and lookup
// ---------------------------------------------------------------------------

export function EnrolForm({ guest, onDone, onCancel }: {
  guest?: { id: string; firstName: string; lastName: string; phone: string | null; email: string | null; companyId?: string | null };
  onDone: (m: MemberDetail) => void;
  onCancel: () => void;
}) {
  const { property } = useSession();
  const [f, setF] = useState({
    firstName: guest?.firstName ?? '', lastName: guest?.lastName ?? '', phone: guest?.phone ?? '', email: guest?.email ?? '',
    kind: 'individual' as 'individual' | 'corporate', companyId: guest?.companyId ?? '', adult: false, terms: false, marketing: false, notDuplicate: false,
  });
  const { data: companies } = useLoad(() => api.get<Array<{ id: string; name: string }>>('/companies?kind=company'), []);
  const act = useAction<MemberDetail>();
  const [dupe, setDupe] = useState(false);
  return (
    <form
      className="ys-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const m = await act.run(({ key }) =>
          api.post<MemberDetail>(`${loyalty(property.code)}/members`, {
            firstName: f.firstName, lastName: f.lastName, phone: f.phone, email: f.email || null, guestId: guest?.id ?? null,
            companyId: f.companyId || null, kind: f.kind, adultConfirmed: f.adult, programmeAccepted: f.terms, marketingConsent: f.marketing,
            channel: 'reception', confirmNotDuplicate: f.notDuplicate,
          }, key).catch((err) => {
            if (err.code === 'possible_duplicate') setDupe(true);
            throw err;
          }),
        );
        if (m) onDone(m);
      }}
    >
      <div className="ys-row">
        <Field label={f.kind === 'corporate' ? 'Company name' : 'First name'}><input required value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field>
        <Field label={f.kind === 'corporate' ? 'Name (continued)' : 'Last name'}><input required value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field>
      </div>
      <div className="ys-row">
        <Field label="Mobile phone" hint="Used for the one-time code before points are used"><input required value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+254 7…" /></Field>
        <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      </div>
      <div className="ys-row">
        <Field label="Member type">
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'individual' | 'corporate' })}>
            <option value="individual">Individual</option>
            <option value="corporate">Corporate</option>
          </select>
        </Field>
        <Field label="Company">
          <select value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })} required={f.kind === 'corporate'}>
            <option value="">—</option>
            {companies?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      </div>
      <label className="ys-check"><input type="checkbox" checked={f.adult} onChange={(e) => setF({ ...f, adult: e.target.checked })} /> The member is 18 or over</label>
      <label className="ys-check"><input type="checkbox" checked={f.terms} onChange={(e) => setF({ ...f, terms: e.target.checked })} /> The member accepts the programme terms and privacy notice</label>
      <label className="ys-check"><input type="checkbox" checked={f.marketing} onChange={(e) => setF({ ...f, marketing: e.target.checked })} /> Happy to receive offers (optional)</label>
      {dupe && (
        <label className="ys-check ys-warn-text"><input type="checkbox" checked={f.notDuplicate} onChange={(e) => setF({ ...f, notDuplicate: e.target.checked })} /> I checked: this is a different person from the member with this phone</label>
      )}
      <ErrorText error={act.error} />
      <div className="ys-actions">
        <button type="button" className="ys-btn ghost" onClick={onCancel}>Cancel</button>
        <button className="ys-btn" disabled={act.busy || !f.adult || !f.terms}>Enrol</button>
      </div>
    </form>
  );
}

function BalanceTiles({ m }: { m: MemberSummary }) {
  return (
    <div className="ys-tiles small">
      <div className={`ys-tile${Number(m.points.deficit) < 0 ? ' alert' : ''}`}>
        <strong>{pts(m.points.available)}</strong>
        <span>Points (worth {kes(m.points.value)}){Number(m.points.reserved) ? ` · ${pts(m.points.reserved)} held` : ''}</span>
      </div>
      <div className="ys-tile">
        <strong>{kes(m.wallet.available)}</strong>
        <span>Wallet credit{Number(m.wallet.reserved) ? ` · ${kes(m.wallet.reserved)} held` : ''}</span>
      </div>
      <div className="ys-tile">
        <strong>{m.points.expiring ? pts(m.points.expiring.amount) : '—'}</strong>
        <span>{m.points.expiring ? `Points expiring ${m.points.expiring.date.slice(0, 10)}` : 'No points expiring soon'}</span>
      </div>
      <div className="ys-tile">
        <strong>{Number(m.points.pendingEligible) ? kes(m.points.pendingEligible) : Number(m.wallet.pendingCashback) ? kes(m.wallet.pendingCashback) : '—'}</strong>
        <span>{Number(m.wallet.pendingCashback) ? 'Cashback accruing this month' : 'Spend waiting for settlement'}</span>
      </div>
    </div>
  );
}

export function LoyaltyMembersPage() {
  const { property, go, me } = useSession();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<MemberSummary[] | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const search = useAction<MemberSummary[]>();
  const canEnrol = hasPermission(me.roles, 'loyalty.enrol');
  return (
    <>
      <div className="ys-page-head">
        <h1>Loyalty members</h1>
        <span className="spacer" />
        {canEnrol && <button className="ys-btn" onClick={() => setEnrolling(true)}>Enrol a member</button>}
      </div>
      <form
        className="ys-row filters"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await search.run(() => api.get<MemberSummary[]>(`${loyalty(property.code)}/members?q=${encodeURIComponent(q)}`));
          if (r) setResults(r);
        }}
      >
        <Field label="Member number, card code, phone or name">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="YS100001, +254 712…, Wanjiru" />
        </Field>
        <button className="ys-btn" disabled={search.busy}>Find</button>
      </form>
      <ErrorText error={search.error} />
      {results && (
        <table className="ys-table">
          <thead><tr><th>Member</th><th>Name</th><th>Phone</th><th>Club</th><th>Points</th><th>Wallet</th><th>Status</th></tr></thead>
          <tbody>
            {results.length === 0 && <tr><td colSpan={7} className="ys-muted">No member found. Check the number or enrol them.</td></tr>}
            {results.map((m) => (
              <tr key={m.id} className="ys-link" onClick={() => go('loyalty-member', { id: m.id })}>
                <td><strong>{m.number}</strong>{m.kind === 'corporate' && <span className="ys-badge">Corporate</span>}{m.staffFlagged && <span className="ys-badge st-hold">Staff</span>}</td>
                <td>{m.name}</td><td>{m.phone}</td>
                <td>{m.club ? `${m.club.tier} · ${Number(m.club.discountPercent)}% / ${Number(m.club.cashbackPercent)}%` : '—'}</td>
                <td>{pts(m.points.available)}</td><td>{kes(m.wallet.available)}</td><td><StatusBadge status={m.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {enrolling && (
        <Modal title="Enrol a member" onClose={() => setEnrolling(false)}>
          <EnrolForm onCancel={() => setEnrolling(false)} onDone={(m) => { setEnrolling(false); go('loyalty-member', { id: m.id }); }} />
        </Modal>
      )}
    </>
  );
}

/** Member box on the guest page: shows the guest's membership or offers enrolment (LOY11 at reception). */
export function GuestLoyaltyPanel({ guest }: { guest: { id: string; firstName: string; lastName: string; phone: string | null; email: string | null; companyId?: string | null } }) {
  const { property, go, me } = useSession();
  const { data, reload } = useLoad(() => api.get<MemberSummary[]>(`${loyalty(property.code)}/members?guestId=${guest.id}`), [guest.id, property.code]);
  const [enrolling, setEnrolling] = useState(false);
  if (!hasPermission(me.roles, 'loyalty.lookup')) return null;
  const m = data?.[0];
  return (
    <section className="ys-section">
      <h2>Loyalty</h2>
      {!data ? <p className="ys-muted">Loading…</p> : m ? (
        <div className="ys-card">
          <p>
            Member <strong>{m.number}</strong> · {pts(m.points.available)} points · {kes(m.wallet.available)} wallet
            {m.club && <> · Club {m.club.tier}</>}{' '}
            <button className="ys-btn small ghost" onClick={() => go('loyalty-member', { id: m.id })}>Open</button>
          </p>
        </div>
      ) : (
        <p className="ys-muted">
          Not a member. {hasPermission(me.roles, 'loyalty.enrol') && <button className="ys-btn small" onClick={() => setEnrolling(true)}>Enrol in YeaStay Rewards</button>}
        </p>
      )}
      {enrolling && (
        <Modal title="Enrol in YeaStay Rewards" onClose={() => setEnrolling(false)}>
          <EnrolForm guest={guest} onCancel={() => setEnrolling(false)} onDone={() => { setEnrolling(false); reload(); }} />
        </Modal>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Member profile, actions and history (LOY17, LOY24, CLUB01)
// ---------------------------------------------------------------------------

type Dialog = null | 'adjust' | 'merge' | 'staff' | 'club' | 'override' | 'status';

export function LoyaltyMemberPage({ id }: { id: string }) {
  const { property, me } = useSession();
  const { data: m, error, reload } = useLoad(() => api.get<MemberDetail>(`${loyalty(property.code)}/members/${id}`), [id, property.code]);
  const [unit, setUnit] = useState<'' | 'points' | 'wallet'>('');
  const { data: history, reload: reloadHistory } = useLoad(
    () => api.get<{ events: Array<Record<string, any>>; pending: Array<Record<string, any>>; cashback: Array<Record<string, any>> }>(`${loyalty(property.code)}/members/${id}/history${unit ? `?unit=${unit}` : ''}`), // eslint-disable-line @typescript-eslint/no-explicit-any
    [id, unit, property.code],
  );
  const [dialog, setDialog] = useState<Dialog>(null);
  const refresh = () => { setDialog(null); reload(); reloadHistory(); };
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(me.roles, p);

  if (error) return <ErrorText error={error} />;
  if (!m) return <p className="ys-muted">Loading…</p>;
  return (
    <>
      <div className="ys-page-head">
        <h1>{m.name} <span className="ys-muted">{m.number}</span></h1>
        <StatusBadge status={m.status} />
        {m.kind === 'corporate' && <span className="ys-badge">Corporate</span>}
        {m.staffFlagged && <span className="ys-badge st-hold">Staff{m.profile?.staffUsername ? ` · ${m.profile.staffUsername}` : ''}</span>}
        <span className="spacer" />
        {m.status === 'active' && <button className="ys-btn ghost" onClick={() => openPrintable(`${loyalty(property.code)}/members/${id}/card`)}>Member card</button>}
        {m.selfServicePath && <a className="ys-btn ghost" href={m.selfServicePath} target="_blank" rel="noreferrer">Member's own page</a>}
      </div>
      <BalanceTiles m={m} />
      {m.profile && (
        <div className="ys-grid">
          <div className="ys-card">
            <h3>Profile</h3>
            <p>{[m.phone, m.profile.email, m.profile.company].filter(Boolean).join(' · ')}</p>
            <p className="ys-muted">
              Enrolled {when(m.profile.enrolledAt)} at {m.profile.enrolledAt_property ?? 'another property'} ({label(m.profile.enrolmentChannel)}) · Offers:{' '}
              {m.profile.marketingConsentAt ? 'yes' : 'no'} · Phone verified: {m.profile.phoneVerifiedAt ? 'yes' : 'not yet'}
            </p>
            {m.mergedFrom?.length ? <p className="ys-muted">Merged from {m.mergedFrom.map((x) => x.number).join(', ')}</p> : null}
          </div>
          <div className="ys-card">
            <h3>Club</h3>
            {m.clubMembership ? (
              <>
                <p>
                  {m.clubMembership.tierName} · <StatusBadge status={m.clubMembership.status} /> from {m.clubMembership.startsOn}
                  {m.clubMembership.endsOn ? ` to ${m.clubMembership.endsOn}` : ''}
                </p>
                {m.club && <p>Today: {Number(m.club.discountPercent)}% discount or {Number(m.club.cashbackPercent)}% monthly cashback</p>}
                {m.overrides?.map((o, i) => (
                  <p key={i} className="ys-muted">
                    Override {o.discountPercent ?? '—'}% / {o.cashbackPercent ?? '—'}% from {o.effectiveFrom}{o.effectiveTo ? ` to ${o.effectiveTo}` : ''}, approved by {o.approvedBy}: {o.reason}
                  </p>
                ))}
              </>
            ) : <p className="ys-muted">Not a club member.</p>}
          </div>
        </div>
      )}
      <div className="ys-actions">
        {can('loyalty.manage') && <button className="ys-btn ghost" onClick={() => setDialog('adjust')}>Correct balance</button>}
        {can('loyalty.manage') && <button className="ys-btn ghost" onClick={() => setDialog('merge')}>Merge a duplicate</button>}
        {can('loyalty.manage') && <button className="ys-btn ghost" onClick={() => setDialog('staff')}>{m.staffFlagged ? 'Staff link' : 'Flag as staff'}</button>}
        {can('loyalty.manage') && <button className="ys-btn ghost" onClick={() => setDialog('status')}>Status</button>}
        {can('loyalty.club.manage') && <button className="ys-btn ghost" onClick={() => setDialog('club')}>Club membership</button>}
        {can('loyalty.club.manage') && m.clubMembership && <button className="ys-btn ghost" onClick={() => setDialog('override')}>Individual rate</button>}
      </div>

      <section className="ys-section">
        <div className="ys-page-head">
          <h2>History</h2>
          <span className="spacer" />
          <div className="ys-segmented">
            {(['', 'points', 'wallet'] as const).map((u) => (
              <button key={u} aria-pressed={unit === u} onClick={() => setUnit(u)}>{u ? label(u) : 'All'}</button>
            ))}
          </div>
        </div>
        <table className="ys-table compact">
          <thead><tr><th>When</th><th>What</th><th>Where</th><th>Bill / folio</th><th>Change</th><th>Value</th><th>By / reason</th></tr></thead>
          <tbody>
            {history?.events.length === 0 && <tr><td colSpan={7} className="ys-muted">No activity yet.</td></tr>}
            {history?.events.map((e) => (
              <tr key={e.id}>
                <td className="ys-nowrap">{when(e.at)}</td>
                <td>{TYPE[e.type] ?? label(e.type)} {e.unit === 'wallet' ? '(wallet)' : ''}</td>
                <td>{e.visible === false ? `${e.property ?? ''} (details hidden)` : [e.property, e.outlet].filter(Boolean).join(' · ')}</td>
                <td>{e.checkNumber ?? e.folioNumber ?? ''}{e.returnNumber ? ` · ${e.returnNumber}` : ''}</td>
                <td className={Number(e.amount) < 0 ? 'ys-warn-text' : ''}>{e.unit === 'points' ? pts(e.amount) : kes(e.amount)}</td>
                <td>{e.value ? kes(e.value) : ''}</td>
                <td className="ys-muted">{[e.actor, e.reason, e.programmeVersion ? `rules v${e.programmeVersion}` : null].filter(Boolean).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!!history?.pending.length && (
          <>
            <h3>Waiting for settlement</h3>
            <table className="ys-table compact">
              <thead><tr><th>Sale date</th><th>From</th><th>Property</th><th>Bill / folio</th><th>Eligible</th><th>Status</th></tr></thead>
              <tbody>
                {history.pending.map((p) => (
                  <tr key={p.id}>
                    <td>{p.saleDate}</td><td>{label(p.source)}</td><td>{p.property}</td><td>{p.checkNumber ?? p.folioNumber}</td><td>{kes(p.eligibleAmount)}</td><td><StatusBadge status={p.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {!!history?.cashback.length && (
          <>
            <h3>Cashback accruals</h3>
            <table className="ys-table compact">
              <thead><tr><th>Sale date</th><th>Month</th><th>Property</th><th>Bill / folio</th><th>Eligible</th><th>Rate</th><th>Cashback</th></tr></thead>
              <tbody>
                {history.cashback.map((a) => (
                  <tr key={a.id}>
                    <td>{a.saleDate}</td><td>{String(a.settlementMonth).slice(0, 7)}</td><td>{a.property}</td><td>{a.checkNumber ?? a.folioNumber}</td>
                    <td>{kes(a.eligibleAmount)}</td><td>{Number(a.ratePercent)}%</td><td>{kes((Number(a.eligibleAmount) * Number(a.ratePercent) / 100).toFixed(2))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      {dialog === 'adjust' && <AdjustDialog id={id} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'merge' && <MergeDialog id={id} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'staff' && <StaffDialog id={id} current={m.profile?.staffUsername ?? ''} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'club' && <ClubDialog id={id} current={m.clubMembership ?? null} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'override' && <OverrideDialog id={id} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'status' && <StatusDialog id={id} current={m.status} onClose={() => setDialog(null)} onDone={refresh} />}
    </>
  );
}

function AdjustDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const [f, setF] = useState({ unit: 'points', amount: '', reason: '' });
  const act = useAction();
  return (
    <Modal title="Correct balance" onClose={onClose}>
      <form className="ys-form" onSubmit={async (e) => {
        e.preventDefault();
        if (await act.run(({ key, approval }) => api.post(`${loyalty(property.code)}/members/${id}/adjust`, { ...f, approval }, key))) onDone();
      }}>
        <p className="ys-muted">A correction is a new entry with your reason and a manager's approval; history is never edited. Use a minus sign to take off.</p>
        <div className="ys-row">
          <Field label="Balance"><select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}><option value="points">Points</option><option value="wallet">Wallet (KES)</option></select></Field>
          <Field label="Change"><input required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder={f.unit === 'points' ? '250 or -250' : '500.00'} /></Field>
        </div>
        <Field label="Reason"><input required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        {act.approvalFields}
        <ErrorText error={act.error} />
        <div className="ys-actions"><button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button><button className="ys-btn" disabled={act.busy}>Save correction</button></div>
      </form>
    </Modal>
  );
}

function MergeDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<MemberSummary[]>([]);
  const [from, setFrom] = useState<MemberSummary | null>(null);
  const [reason, setReason] = useState('');
  const find = useAction<MemberSummary[]>();
  const act = useAction();
  return (
    <Modal title="Merge a duplicate into this member" onClose={onClose}>
      <div className="ys-form">
        <p className="ys-muted">The duplicate's points and credit move here with their own expiry dates; its history stays and points to this member.</p>
        <div className="ys-row">
          <Field label="Find the duplicate"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Member number or phone" /></Field>
          <button className="ys-btn ghost" onClick={async () => { const r = await find.run(() => api.get<MemberSummary[]>(`${loyalty(property.code)}/members?q=${encodeURIComponent(q)}`)); if (r) setFound(r.filter((x) => x.id !== id)); }}>Find</button>
        </div>
        {found.map((x) => (
          <label key={x.id} className="ys-check"><input type="radio" name="from" checked={from?.id === x.id} onChange={() => setFrom(x)} /> {x.number} · {x.name} · {pts(x.points.available)} pts · {kes(x.wallet.available)}</label>
        ))}
        <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Same person, two cards" /></Field>
        {act.approvalFields}
        <ErrorText error={find.error ?? act.error} />
        <div className="ys-actions">
          <button className="ys-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ys-btn danger" disabled={!from || reason.length < 3 || act.busy} onClick={async () => {
            if (await act.run(({ key, approval }) => api.post(`${loyalty(property.code)}/members/${id}/merge`, { fromMemberId: from!.id, reason, approval }, key))) onDone();
          }}>Merge {from?.number ?? ''}</button>
        </div>
      </div>
    </Modal>
  );
}

function StaffDialog({ id, current, onClose, onDone }: { id: string; current: string; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const [username, setUsername] = useState(current);
  const [reason, setReason] = useState('');
  const act = useAction();
  return (
    <Modal title="Staff account" onClose={onClose}>
      <form className="ys-form" onSubmit={async (e) => {
        e.preventDefault();
        if (await act.run(({ key }) => api.post(`${loyalty(property.code)}/members/${id}/staff`, { username: username.trim() || null, reason }, key))) onDone();
      }}>
        <p className="ys-muted">A flagged staff member earns nothing on bills they serve or cash up, and shows in the exceptions report (LOY22).</p>
        <Field label="Staff username" hint="Leave empty to flag without a user link"><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="k1.waiter" /></Field>
        <Field label="Reason"><input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorText error={act.error} />
        <div className="ys-actions"><button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button><button className="ys-btn" disabled={act.busy}>Save</button></div>
      </form>
    </Modal>
  );
}

function StatusDialog({ id, current, onClose, onDone }: { id: string; current: string; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const [status, setStatus] = useState(current);
  const act = useAction();
  return (
    <Modal title="Member status" onClose={onClose}>
      <form className="ys-form" onSubmit={async (e) => {
        e.preventDefault();
        if (await act.run(() => api.patch(`${loyalty(property.code)}/members/${id}`, { status }))) onDone();
      }}>
        <Field label="Status"><select value={status} onChange={(e) => setStatus(e.target.value)}>{['active', 'suspended', 'closed'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        <p className="ys-muted">Suspended members keep their balance but cannot earn or redeem until reactivated.</p>
        <ErrorText error={act.error} />
        <div className="ys-actions"><button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button><button className="ys-btn" disabled={act.busy}>Save</button></div>
      </form>
    </Modal>
  );
}

function ClubDialog({ id, current, onClose, onDone }: { id: string; current: MemberDetail['clubMembership'] | null; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const { data: programme } = useLoad(() => api.get<{ tiers: Array<{ code: string; name: string }> }>('/loyalty/programme'), []);
  const [f, setF] = useState({
    tierCode: current?.tierCode ?? 'CLUB', status: current?.status ?? 'active', startsOn: current?.startsOn ?? `${thisMonth()}-01`, endsOn: current?.endsOn ?? '', reason: '',
  });
  const act = useAction();
  return (
    <Modal title="Club membership" onClose={onClose}>
      <form className="ys-form" onSubmit={async (e) => {
        e.preventDefault();
        if (await act.run(() => api.put(`${loyalty(property.code)}/members/${id}/club`, { ...f, endsOn: f.endsOn || null }))) onDone();
      }}>
        <div className="ys-row">
          <Field label="Tier"><select value={f.tierCode} onChange={(e) => setF({ ...f, tierCode: e.target.value })}>{(programme?.tiers ?? [{ code: 'CLUB', name: 'Club' }]).map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></Field>
          <Field label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{['active', 'suspended', 'expired'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        </div>
        <div className="ys-row">
          <Field label="From"><input type="date" required value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} /></Field>
          <Field label="To (optional)"><input type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} /></Field>
        </div>
        <Field label="Reason"><input required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        <ErrorText error={act.error} />
        <div className="ys-actions"><button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button><button className="ys-btn" disabled={act.busy}>Save</button></div>
      </form>
    </Modal>
  );
}

function OverrideDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const [f, setF] = useState({ discountPercent: '', cashbackPercent: '', effectiveFrom: new Date().toISOString().slice(0, 10), effectiveTo: '', reason: '' });
  const act = useAction();
  return (
    <Modal title="Individual club rate" onClose={onClose}>
      <form className="ys-form" onSubmit={async (e) => {
        e.preventDefault();
        if (await act.run(({ key, approval }) => api.post(`${loyalty(property.code)}/members/${id}/club/overrides`, {
          discountPercent: f.discountPercent || null, cashbackPercent: f.cashbackPercent || null, effectiveFrom: f.effectiveFrom, effectiveTo: f.effectiveTo || null, reason: f.reason, approval,
        }, key))) onDone();
      }}>
        <p className="ys-muted">Takes precedence over the tier rate only between these dates (CAT04). Needs the owner or area manager's approval.</p>
        <div className="ys-row">
          <Field label="Discount %"><input value={f.discountPercent} onChange={(e) => setF({ ...f, discountPercent: e.target.value })} placeholder="tier rate" /></Field>
          <Field label="Cashback %"><input value={f.cashbackPercent} onChange={(e) => setF({ ...f, cashbackPercent: e.target.value })} placeholder="tier rate" /></Field>
        </div>
        <div className="ys-row">
          <Field label="From"><input type="date" required value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
          <Field label="To (optional)"><input type="date" value={f.effectiveTo} onChange={(e) => setF({ ...f, effectiveTo: e.target.value })} /></Field>
        </div>
        <Field label="Reason"><input required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        {act.approvalFields}
        <ErrorText error={act.error} />
        <div className="ys-actions"><button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button><button className="ys-btn" disabled={act.busy}>Save</button></div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Programme settings (LOY01, CLUB01)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Settings = Record<string, any>;

const csv = (v: string[]) => v.join(', ');
const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

export function LoyaltyProgrammePage() {
  const { me } = useSession();
  const { data, error, reload } = useLoad(() => api.get<{ current: { version: number; settings: Settings }; versions: Array<Record<string, any>>; tiers: Array<Record<string, any>> }>('/loyalty/programme'), []);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [note, setNote] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [tier, setTier] = useState<Record<string, any> | null>(null);
  const save = useAction();
  const canEdit = hasPermission(me.roles, 'loyalty.programme');
  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="ys-muted">Loading…</p>;
  const s = draft ?? data.current.settings;
  const set = (section: string, key: string, value: unknown) => setDraft({ ...s, [section]: { ...s[section], [key]: value } });
  const num = (section: string, key: string) => (
    <input type="number" value={s[section][key] ?? ''} disabled={!canEdit} onChange={(e) => set(section, key, e.target.value === '' ? null : Number(e.target.value))} />
  );
  const text = (section: string, key: string) => <input value={s[section][key] ?? ''} disabled={!canEdit} onChange={(e) => set(section, key, e.target.value)} />;
  const bool = (section: string, key: string, text: string) => (
    <label className="ys-check"><input type="checkbox" disabled={!canEdit} checked={!!s[section][key]} onChange={(e) => set(section, key, e.target.checked)} /> {text}</label>
  );
  return (
    <>
      <div className="ys-page-head"><h1>Loyalty programme</h1><span className="spacer" /><span className="ys-muted">Rules version {data.current.version} in force</span></div>
      <p className="ys-muted">Every change is a new version from now or a later date. Sales keep the version they were made under, so a change never recalculates old bills or refunds.</p>
      <div className="ys-grid">
        <div className="ys-card ys-form">
          <h3>Points</h3>
          <div className="ys-row"><Field label="Spend per point (KES)">{text('points', 'earnUnit')}</Field><Field label="Value of a point (KES)">{text('points', 'pointValue')}</Field></div>
          <div className="ys-row"><Field label="Most of a bill payable with points (%)">{text('points', 'redeemCapPercent')}</Field><Field label="Minimum points to redeem">{num('points', 'minRedeemPoints')}</Field></div>
          <div className="ys-row"><Field label="Points expire after (months)">{num('points', 'expiryMonths')}</Field><Field label="Grace for restored points (days)">{num('points', 'restoreGraceDays')}</Field></div>
          <Field label="Most points one member can earn in a day" hint="Leave empty for no limit">{num('points', 'dailyEarnCap')}</Field>
        </div>
        <div className="ys-card ys-form">
          <h3>What earns</h3>
          <Field label="Earn on">
            <select value={s.eligibility.basis} disabled={!canEdit} onChange={(e) => set('eligibility', 'basis', e.target.value)}>
              <option value="net">Spend before VAT and levy</option><option value="gross">Spend including VAT and levy</option>
            </select>
          </Field>
          <Field label="Excluded charge codes" hint="Comma separated, e.g. CANCEL_FEE, NO_SHOW_FEE"><input disabled={!canEdit} value={csv(s.eligibility.excludedChargeCodes)} onChange={(e) => set('eligibility', 'excludedChargeCodes', list(e.target.value))} /></Field>
          <Field label="Excluded menu categories"><input disabled={!canEdit} value={csv(s.eligibility.excludedCategoryCodes)} onChange={(e) => set('eligibility', 'excludedCategoryCodes', list(e.target.value))} /></Field>
          <Field label="Only these outlets take part" hint="Empty means every outlet"><input disabled={!canEdit} value={csv(s.eligibility.participatingOutletCodes)} onChange={(e) => set('eligibility', 'participatingOutletCodes', list(e.target.value))} /></Field>
          {bool('eligibility', 'rewardsOnAlcohol', 'Points and credit can pay for alcohol (LOY25)')}
          {bool('rooms', 'corporateEarns', 'Corporate bookings earn on rooms')}
          <Field label="Rate plans that never earn"><input disabled={!canEdit} value={csv(s.rooms.excludedRatePlanCodes)} onChange={(e) => set('rooms', 'excludedRatePlanCodes', list(e.target.value))} /></Field>
        </div>
        <div className="ys-card ys-form">
          <h3>Club and stacking</h3>
          <div className="ys-row"><Field label="Default club discount (%)">{text('club', 'defaultDiscountPercent')}</Field><Field label="Default club cashback (%)">{text('club', 'defaultCashbackPercent')}</Field></div>
          {bool('stacking', 'enabled', 'Allow benefits to combine on one bill (discount + points + cashback)')}
          <Field label="Combined ceiling when stacking (% of the bill)">{text('stacking', 'ceilingPercent')}</Field>
          <Field label="When stacking is off, a club member gets by default">
            <select disabled={!canEdit} value={s.club.benefitWhenNotStacking} onChange={(e) => set('club', 'benefitWhenNotStacking', e.target.value)}>
              <option value="discount">the discount at the till</option><option value="cashback">cashback at month end</option>
            </select>
          </Field>
          {bool('club', 'earnsPoints', 'Club members also earn points')}
          <div className="ys-row"><Field label="Minimum monthly spend (KES)">{text('club', 'minMonthlySpend')}</Field><Field label="Monthly cashback cap (KES)" hint="Empty for none"><input disabled={!canEdit} value={s.club.monthlyCap ?? ''} onChange={(e) => set('club', 'monthlyCap', e.target.value || null)} /></Field></div>
          <div className="ys-row"><Field label="Most of a bill payable with wallet (%)">{text('club', 'walletCapPercent')}</Field><Field label="Wallet credit expires after (months)">{num('club', 'walletExpiryMonths')}</Field></div>
        </div>
        <div className="ys-card ys-form">
          <h3>Checks and finance</h3>
          <Field label="One-time code delivery">
            <select disabled={!canEdit} value={s.verification.otpDelivery} onChange={(e) => set('verification', 'otpDelivery', e.target.value)}>
              <option value="screen">Show on staff screen (demo, no SMS gateway yet)</option><option value="sms">SMS</option>
            </select>
          </Field>
          <Field label="Hold rewards on an open bill for (minutes)"><input type="number" disabled={!canEdit} value={s.reservationMinutes} onChange={(e) => setDraft({ ...s, reservationMinutes: Number(e.target.value) })} /></Field>
          <div className="ys-row"><Field label="Alert: bills per member per day">{num('misuse', 'billsPerDayAlert')}</Field><Field label="Alert: one waiter's share of a member's bills (%)">{num('misuse', 'waiterSharePercentAlert')}</Field></div>
          <Field label="Rewards on the bill are treated as">
            <select disabled={!canEdit} value={s.rewardTreatment} onChange={(e) => setDraft({ ...s, rewardTreatment: e.target.value })}>
              <option value="discount">a discount (lowers VAT)</option><option value="tender">a payment (VAT on the full price)</option>
            </select>
          </Field>
        </div>
      </div>
      {canEdit && draft && (
        <div className="ys-card ys-form">
          <div className="ys-row">
            <Field label="What changed and why"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <Field label="In force from" hint="Empty means now"><input type="datetime-local" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></Field>
          </div>
          <ErrorText error={save.error} />
          <div className="ys-actions">
            <button className="ys-btn ghost" onClick={() => setDraft(null)}>Discard changes</button>
            <button className="ys-btn" disabled={save.busy || note.length < 3} onClick={async () => {
              const ok = await save.run(({ key }) => api.post('/loyalty/programme/versions', { settings: draft, note, effectiveFrom: effectiveFrom ? new Date(effectiveFrom).toISOString() : null }, key));
              if (ok) { setDraft(null); setNote(''); setEffectiveFrom(''); reload(); }
            }}>Save as new version</button>
          </div>
        </div>
      )}

      <section className="ys-section">
        <h2>Club tiers</h2>
        <table className="ys-table compact">
          <thead><tr><th>Tier</th><th>Discount</th><th>Cashback</th><th>Since</th><th>Active members</th><th /></tr></thead>
          <tbody>
            {data.tiers.map((t) => (
              <tr key={t.code}>
                <td>{t.name} ({t.code})</td>
                <td>{t.discountPercent ? `${Number(t.discountPercent)}%` : `programme default (${Number(s.club.defaultDiscountPercent)}%)`}</td>
                <td>{t.cashbackPercent ? `${Number(t.cashbackPercent)}%` : `programme default (${Number(s.club.defaultCashbackPercent)}%)`}</td>
                <td>{when(t.effectiveFrom)}</td><td>{t.members}</td>
                <td>{canEdit && <button className="ys-btn small ghost" onClick={() => setTier({ code: t.code, discountPercent: t.discountPercent ?? '', cashbackPercent: t.cashbackPercent ?? '', effectiveFrom: '', reason: '' })}>Change rate</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="ys-section">
        <h2>Versions</h2>
        <table className="ys-table compact">
          <thead><tr><th>Version</th><th>In force from</th><th>Note</th><th>By</th></tr></thead>
          <tbody>
            {data.versions.map((v) => (
              <tr key={v.id}><td>{v.version}{v.scheduled ? ' (scheduled)' : ''}</td><td>{when(v.effectiveFrom)}</td><td>{v.note}</td><td>{v.createdBy ?? 'System'}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      {tier && <TierDialog tier={tier} onClose={() => setTier(null)} onDone={() => { setTier(null); reload(); }} />}
    </>
  );
}

function TierDialog({ tier, onClose, onDone }: { tier: Record<string, any>; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState(tier);
  const act = useAction();
  return (
    <Modal title={`Change ${tier.code} rate`} onClose={onClose}>
      <form className="ys-form" onSubmit={async (e) => {
        e.preventDefault();
        if (await act.run(() => api.put(`/loyalty/programme/tiers/${tier.code}`, {
          discountPercent: f.discountPercent || null, cashbackPercent: f.cashbackPercent || null, reason: f.reason,
          effectiveFrom: f.effectiveFrom ? new Date(f.effectiveFrom).toISOString() : null,
        }))) onDone();
      }}>
        <p className="ys-muted">Sales before the change keep their old rate, including at month end (CAT03).</p>
        <div className="ys-row">
          <Field label="Discount %" hint="Empty uses the programme default"><input value={f.discountPercent} onChange={(e) => setF({ ...f, discountPercent: e.target.value })} /></Field>
          <Field label="Cashback %" hint="Empty uses the programme default"><input value={f.cashbackPercent} onChange={(e) => setF({ ...f, cashbackPercent: e.target.value })} /></Field>
        </div>
        <Field label="In force from" hint="Empty means now"><input type="datetime-local" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
        <Field label="Reason"><input required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        <ErrorText error={act.error} />
        <div className="ys-actions"><button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button><button className="ys-btn" disabled={act.busy}>Save</button></div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Month-end cashback (CLUB03, CLUB04)
// ---------------------------------------------------------------------------

/** Finance maps the SAP G/L accounts; journals held until then go to SAP once (LOY18, CLUB07). */
function SapAccountsCard() {
  const { me } = useSession();
  const { data, reload } = useLoad(() => api.get<Record<string, any>>('/loyalty/sap-accounts'), []);
  const [f, setF] = useState<{ cashbackExpense: string; walletLiability: string; reason: string } | null>(null);
  const save = useAction<Record<string, any>>();
  const [released, setReleased] = useState<number | null>(null);
  const canMap = hasPermission(me.roles, 'loyalty.finance');
  if (!data) return null;
  const cur = data.current;
  return (
    <section className="ys-section">
      <h2>SAP accounts</h2>
      <div className="ys-card">
        {cur ? (
          <p>
            Cashback expense <strong>{cur.cashbackExpense}</strong> · Wallet liability <strong>{cur.walletLiability}</strong>
            <span className="ys-muted"> · set by {cur.createdBy ?? '—'}, {when(cur.createdAt)}</span>
          </p>
        ) : (
          <p className="ys-warn-text">Not mapped yet. Cashback and wallet journals wait here and go to SAP once the accounts are saved.</p>
        )}
        {data.held.count > 0 && <p className="ys-muted">{data.held.count} journal(s) waiting, {kes(data.held.amount)} in total.</p>}
        {canMap && !f && (
          <button className="ys-btn ghost" onClick={() => setF({ cashbackExpense: cur?.cashbackExpense ?? '', walletLiability: cur?.walletLiability ?? '', reason: '' })}>
            {cur ? 'Change accounts' : 'Map accounts'}
          </button>
        )}
        {f && (
          <form
            className="ys-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const out = await save.run(() => api.put<Record<string, any>>('/loyalty/sap-accounts', f));
              if (out) { setF(null); setReleased(out.released); reload(); }
            }}
          >
            <div className="ys-row">
              <Field label="Cashback expense account" hint="SAP G/L account code"><input required maxLength={15} value={f.cashbackExpense} onChange={(e) => setF({ ...f, cashbackExpense: e.target.value.trim() })} /></Field>
              <Field label="Wallet liability account" hint="SAP G/L account code"><input required maxLength={15} value={f.walletLiability} onChange={(e) => setF({ ...f, walletLiability: e.target.value.trim() })} /></Field>
            </div>
            <Field label="Reason"><input required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
            <p className="ys-muted">A change applies to journals from now on; journals already sent to SAP keep their accounts.</p>
            <div className="ys-row">
              <button type="button" className="ys-btn ghost" onClick={() => setF(null)}>Cancel</button>
              <button className="ys-btn" disabled={save.busy}>Save and send waiting journals</button>
            </div>
            <ErrorText error={save.error} />
          </form>
        )}
        {released !== null && <p className="ys-muted">{released} waiting journal(s) sent to SAP.</p>}
      </div>
    </section>
  );
}

export function CashbackPage() {
  const { me } = useSession();
  const [month, setMonth] = useState(thisMonth());
  const { data: preview, error, reload } = useLoad(() => api.get<Record<string, any>>(`/loyalty/cashback/preview?month=${month}`), [month]);
  const { data: batches, reload: reloadBatches } = useLoad(() => api.get<Array<Record<string, any>>>('/loyalty/cashback/batches'), []);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const gen = useAction<Record<string, any>>();
  const canApprove = hasPermission(me.roles, 'approve.cashback_batch');
  const refresh = () => { reload(); reloadBatches(); };
  return (
    <>
      <div className="ys-page-head">
        <h1>Club cashback</h1>
        <span className="spacer" />
        <Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
      </div>
      <p className="ys-muted">
        Cashback is worked out from sales that were fully settled in the month, each at its own sale-date rate. Finance reviews the draft, a second person with approval rights approves it, and posting credits each member's wallet once.
      </p>
      <ErrorText error={error} />
      {preview && (
        <>
          {!preview.monthEnded && <p className="ys-warn-text">This month has not ended. A batch now covers sales so far; later sales go into an adjustment batch.</p>}
          <div className="ys-tiles small">
            <div className="ys-tile"><strong>{preview.totals.members}</strong><span>Members</span></div>
            <div className="ys-tile"><strong>{kes(preview.totals.spend)}</strong><span>Qualifying spend</span></div>
            <div className="ys-tile"><strong>{kes(preview.totals.returns)}</strong><span>Returns</span></div>
            <div className="ys-tile"><strong>{kes(preview.totals.amount)}</strong><span>To credit ({preview.nextBatch} batch)</span></div>
          </div>
          <table className="ys-table compact">
            <thead><tr><th>Member</th><th>Spend</th><th>Returns</th><th>Rates</th><th>Entitlement</th><th>Already credited</th><th>This batch</th><th>Check</th></tr></thead>
            <tbody>
              {preview.lines.length === 0 && <tr><td colSpan={8} className="ys-muted">No club cashback for this month.</td></tr>}
              {preview.lines.map((l: Record<string, any>) => (
                <tr key={l.memberId}>
                  <td>{l.number} · {l.name}</td><td>{kes(l.spend)}</td><td>{kes(l.returns)}</td>
                  <td className="ys-muted">{l.rates.map((r: Record<string, string>) => `${kes(r.eligible)} at ${Number(r.rate)}%`).join('; ')}</td>
                  <td>{kes(l.entitlement)}</td><td>{kes(l.previouslyCredited)}</td><td><strong>{kes(l.amount)}</strong></td>
                  <td className="ys-warn-text">{l.flags.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!!preview.pending.length && (
            <p className="ys-muted">
              {preview.pending.length} club sale(s) are still waiting for a folio or company payment and will count in the month they are settled.
            </p>
          )}
          {batches?.some((b) => b.month === month && ['draft', 'approved'].includes(b.status)) ? (
            <p className="ys-muted">A batch for this month is waiting for approval or posting: open it below.</p>
          ) : (
          <div className="ys-row">
            <Field label="Note for the batch"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <button className="ys-btn" disabled={gen.busy} onClick={async () => {
              const b = await gen.run(({ key }) => api.post<Record<string, any>>('/loyalty/cashback/batches', { month, note: note || null }, key));
              if (b) { setOpen(b.id); refresh(); }
            }}>Save as draft {preview.nextBatch} batch</button>
          </div>
          )}
          <ErrorText error={gen.error} />
        </>
      )}
      <SapAccountsCard />
      <section className="ys-section">
        <h2>Batches</h2>
        <table className="ys-table compact">
          <thead><tr><th>Month</th><th>Kind</th><th>Status</th><th>Members</th><th>Amount</th><th>Prepared</th><th>Approved</th><th>Posted</th></tr></thead>
          <tbody>
            {batches?.length === 0 && <tr><td colSpan={8} className="ys-muted">No batches yet.</td></tr>}
            {batches?.map((b) => (
              <tr key={b.id} className="ys-link" onClick={() => setOpen(b.id)}>
                <td>{b.month}</td><td>{label(b.kind)}</td><td><StatusBadge status={b.status} /></td><td>{b.totals.members}</td><td>{kes(b.totals.amount)}</td>
                <td>{b.createdBy} · {when(b.createdAt)}</td><td>{b.approvedBy ? `${b.approvedBy} · ${when(b.approvedAt)}` : '—'}</td><td>{when(b.postedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {open && <BatchDialog id={open} canApprove={canApprove} onClose={() => setOpen(null)} onChanged={refresh} />}
    </>
  );
}

function BatchDialog({ id, canApprove, onClose, onChanged }: { id: string; canApprove: boolean; onClose: () => void; onChanged: () => void }) {
  const { data: b, error, reload } = useLoad(() => api.get<Record<string, any>>(`/loyalty/cashback/batches/${id}`), [id]);
  const [reason, setReason] = useState('');
  const act = useAction();
  const done = () => { reload(); onChanged(); };
  return (
    <Modal title={b ? `Cashback ${b.month} · ${label(b.kind)} batch` : 'Cashback batch'} onClose={onClose} wide>
      <ErrorText error={error} />
      {b && (
        <div className="ys-form">
          <p>Status <StatusBadge status={b.status} /> · {b.totals.members} members · {kes(b.totals.amount)}{b.note ? ` · ${b.note}` : ''}</p>
          <table className="ys-table compact">
            <thead><tr><th>Member</th><th>Spend</th><th>Returns</th><th>Entitlement</th><th>Already credited</th><th>Amount</th><th>Status</th><th>Check</th></tr></thead>
            <tbody>
              {b.lines.map((l: Record<string, any>) => (
                <tr key={l.memberId}>
                  <td>{l.number} · {l.name}</td><td>{kes(l.spend)}</td><td>{kes(l.returns)}</td><td>{kes(l.entitlement)}</td><td>{kes(l.previouslyCredited)}</td>
                  <td><strong>{kes(l.amount)}</strong></td><td><StatusBadge status={l.status} />{l.error ? ` ${l.error}` : ''}</td><td className="ys-warn-text">{l.flags.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {['draft', 'approved'].includes(b.status) && <Field label="Reason or approval note"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
          {act.approvalFields}
          <ErrorText error={act.error} />
          <div className="ys-actions">
            {['draft', 'approved'].includes(b.status) && (
              <button className="ys-btn ghost danger" disabled={act.busy || reason.length < 3} onClick={async () => { if (await act.run(({ key }) => api.post(`/loyalty/cashback/batches/${id}/discard`, { reason }, key))) done(); }}>Discard</button>
            )}
            {b.status === 'draft' && (
              <button className="ys-btn" disabled={act.busy || reason.length < 3} title={canApprove ? '' : 'Needs approval by the owner or group accounts'}
                onClick={async () => { if (await act.run(({ key, approval }) => api.post(`/loyalty/cashback/batches/${id}/approve`, { reason, approval }, key))) done(); }}>Approve</button>
            )}
            {['approved', 'exception'].includes(b.status) && (
              <button className="ys-btn" disabled={act.busy} onClick={async () => { if (await act.run(({ key }) => api.post(`/loyalty/cashback/batches/${id}/post`, {}, key))) done(); }}>
                {b.status === 'exception' ? 'Post the rest' : 'Post to wallets'}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Reports (LOY19, LOY21, LOY22, LAT11)
// ---------------------------------------------------------------------------

export function LoyaltyReportsPage() {
  const { me, property } = useSession();
  const first = `${thisMonth()}-01`;
  const [range, setRange] = useState({ from: first, to: new Date().toISOString().slice(0, 10) });
  const qs = `from=${range.from}&to=${range.to}`;
  const { data: movement, error } = useLoad(() => api.get<Record<string, any>>(`/loyalty/reports/movement?${qs}`), [qs]);
  const { data: liability } = useLoad(() => api.get<Record<string, any>>('/loyalty/reports/liability'), []);
  const { data: activity } = useLoad(() => api.get<Record<string, any>>(`/loyalty/reports/activity?${qs}`), [qs]);
  const { data: pending, reload: reloadPending } = useLoad(() => api.get<Array<Record<string, any>>>('/loyalty/reports/pending'), []);
  const { data: ex } = useLoad(() => api.get<Record<string, any>>(`/loyalty/reports/exceptions?${qs}`), [qs]);
  const paid = useAction();
  const canFinance = hasPermission(me.roles, 'loyalty.finance');
  return (
    <>
      <div className="ys-page-head">
        <h1>Loyalty reports</h1>
        <span className="spacer" />
        <Field label="From"><input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
      </div>
      <ErrorText error={error} />
      {movement && (
        <section className="ys-section">
          <h2>Movement and reconciliation {movement.reconciled ? <span className="ys-badge posted">Reconciled</span> : <span className="ys-badge dead">Difference</span>}</h2>
          <table className="ys-table compact">
            <thead><tr><th /><th>Opening</th>{['earn', 'credit', 'redeem', 'restore', 'reverse', 'adjust', 'expire', 'merge_in', 'merge_out'].map((t) => <th key={t}>{TYPE[t]}</th>)}<th>Closing</th><th>Ledger vs balances</th></tr></thead>
            <tbody>
              {movement.units.map((u: Record<string, any>) => {
                const f = (v: string) => (u.unit === 'points' ? pts(v) : kes(v));
                return (
                  <tr key={u.unit}>
                    <td>{u.unit === 'points' ? 'Points' : 'Wallet (KES)'}</td><td>{f(u.opening)}</td>
                    {['earn', 'credit', 'redeem', 'restore', 'reverse', 'adjust', 'expire', 'merge_in', 'merge_out'].map((t) => <td key={t}>{f(u.movements[t]?.amount ?? '0')}</td>)}
                    <td><strong>{f(u.closing)}</strong></td><td className={Number(u.lotsDifference) || Number(u.identityDifference) ? 'ys-warn-text' : ''}>{f(u.lotsDifference)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      {liability && (
        <section className="ys-section">
          <h2>Outstanding liability</h2>
          <div className="ys-tiles small">
            <div className="ys-tile"><strong>{kes(liability.totals.points)}</strong><span>Points (at KES {Number(liability.pointValue)} each)</span></div>
            <div className="ys-tile"><strong>{kes(liability.totals.wallet)}</strong><span>Wallet credit</span></div>
            <div className="ys-tile"><strong>{kes(liability.cashbackAccruedNotPosted)}</strong><span>Cashback accrued, not yet posted</span></div>
            <div className={`ys-tile${liability.deficits.length ? ' alert' : ''}`}><strong>{liability.deficits.length}</strong><span>Negative balances</span></div>
          </div>
          <div className="ys-grid">
            <table className="ys-table compact">
              <thead><tr><th>Earned at</th><th>Unit</th><th>Outstanding</th><th>Value</th><th>Members</th></tr></thead>
              <tbody>{liability.byProperty.map((r: Record<string, any>, i: number) => <tr key={i}><td>{r.property}</td><td>{label(r.unit)}</td><td>{r.unit === 'points' ? pts(r.outstanding) : kes(r.outstanding)}</td><td>{kes(r.value)}</td><td>{r.members}</td></tr>)}</tbody>
            </table>
            <table className="ys-table compact">
              <thead><tr><th>Expires</th><th>Unit</th><th>Amount</th><th>Value</th></tr></thead>
              <tbody>{liability.byExpiry.map((r: Record<string, any>, i: number) => <tr key={i}><td>{r.month}</td><td>{label(r.unit)}</td><td>{r.unit === 'points' ? pts(r.outstanding) : kes(r.outstanding)}</td><td>{kes(r.value)}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}
      {activity && (
        <section className="ys-section">
          <h2>Activity by outlet</h2>
          <table className="ys-table compact">
            <thead><tr><th>Property</th><th>Outlet</th><th>Member bills</th><th>Members</th><th>Club discount</th><th>Points used</th><th>Wallet used</th><th>Points earned</th><th>Points pending</th><th>Cashback accrued</th></tr></thead>
            <tbody>
              {activity.outlets.length === 0 && <tr><td colSpan={10} className="ys-muted">No member bills in this period.</td></tr>}
              {activity.outlets.map((o: Record<string, any>) => (
                <tr key={o.property + o.outlet}><td>{o.property}</td><td>{o.outletName}</td><td>{o.bills}</td><td>{o.members}</td><td>{kes(o.memberDiscount)}</td><td>{pts(o.pointsRedeemed)}</td><td>{kes(o.walletRedeemed)}</td><td>{pts(o.pointsEarned)}</td><td>{pts(o.pointsPending)}</td><td>{kes(o.cashbackAccrued)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {pending && (
        <section className="ys-section">
          <h2>Waiting for settlement</h2>
          <ErrorText error={paid.error} />
          <table className="ys-table compact">
            <thead><tr><th>Member</th><th>Property</th><th>From</th><th>Bill / folio</th><th>Sale date</th><th>Eligible</th><th>Status</th><th /></tr></thead>
            <tbody>
              {pending.length === 0 && <tr><td colSpan={8} className="ys-muted">Nothing waiting.</td></tr>}
              {pending.map((p) => (
                <tr key={p.id}>
                  <td>{p.number} · {p.name}</td><td>{p.property}</td><td>{label(p.source)}</td><td>{p.check ?? p.folio}</td><td>{p.saleDate}</td><td>{kes(p.eligible)}</td><td><StatusBadge status={p.status} /></td>
                  <td>
                    {canFinance && p.status === 'awaiting_company_payment' && p.property === property.code && (
                      <button className="ys-btn small" disabled={paid.busy} onClick={async () => {
                        if (await paid.run(({ key }) => api.post(`${loyalty(property.code)}/folios/${p.folioId}/company-paid`, { reason: 'Company payment received' }, key))) reloadPending();
                      }}>Company paid</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {canFinance && <p className="ys-muted">To confirm a company payment at another property, switch property at the top first.</p>}
        </section>
      )}
      {ex && (
        <section className="ys-section">
          <h2>Exceptions</h2>
          <div className="ys-grid">
            <div className="ys-card">
              <h3>Staff members on their own bills</h3>
              {ex.staffOwn.length ? ex.staffOwn.map((r: Record<string, any>, i: number) => <p key={i}>{r.date} · {r.property} {r.check} · {r.number} {r.name}</p>) : <p className="ys-muted">None</p>}
            </div>
            <div className="ys-card">
              <h3>{ex.thresholds.billsPerDayAlert}+ bills in a day</h3>
              {ex.frequent.length ? ex.frequent.map((r: Record<string, any>, i: number) => <p key={i}>{r.date} · {r.number} {r.name}: {r.bills} bills</p>) : <p className="ys-muted">None</p>}
            </div>
            <div className="ys-card">
              <h3>One waiter serves most of a member's bills</h3>
              {ex.waiter.length ? ex.waiter.map((r: Record<string, any>, i: number) => <p key={i}>{r.number} {r.name}: {r.waiter} {r.bills}/{r.memberBills} ({r.sharePercent}%)</p>) : <p className="ys-muted">None</p>}
            </div>
            <div className="ys-card">
              <h3>Manual corrections and merges</h3>
              {ex.manual.length ? ex.manual.map((r: Record<string, any>, i: number) => <p key={i}>{when(r.at)} · {r.number} {TYPE[r.type]} {r.unit === 'points' ? pts(r.amount) : kes(r.amount)} by {r.by}{r.approvedBy && r.approvedBy !== r.by ? `, approved by ${r.approvedBy}` : ''}: {r.reason}</p>) : <p className="ys-muted">None</p>}
            </div>
            <div className="ys-card">
              <h3>Rewards released from bills</h3>
              {ex.timeouts.length ? ex.timeouts.map((r: Record<string, any>, i: number) => <p key={i}>{when(r.at)} · {r.check} · {r.number} {r.unit} {r.amount}: {r.reason}</p>) : <p className="ys-muted">None</p>}
            </div>
            <div className="ys-card">
              <h3>Failed code attempts</h3>
              {ex.failedOtp.length ? ex.failedOtp.map((r: Record<string, any>, i: number) => <p key={i}>{when(r.at)} · {r.number}: {r.attempts} wrong codes</p>) : <p className="ys-muted">None</p>}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
