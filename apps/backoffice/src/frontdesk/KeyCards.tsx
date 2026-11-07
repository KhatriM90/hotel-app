import { useEffect, useState } from 'react';
import { hasPermission } from '@hotel/shared';
import { api } from '../api';
import { base, ErrorText, Field, label, StatusBadge, useAction, useLoad, useSession } from '../ui';

/** Guest key cards for TEMIC20 locks (INT-09, FD-03, FD-05) and the door lock set-up page. */

export interface KeyCard {
  id: string;
  kind: 'new' | 'duplicate' | 'read';
  status: 'pending' | 'encoding' | 'done' | 'failed' | 'cancelled';
  stayNumber: string | null;
  roomNumber: string | null;
  cardNo: number | null;
  validTo: string | null;
  errorCode: number | null;
  error: string | null;
  readCardNo: number | null;
  requestedBy: string | null;
  requestedAt: string;
  state?: 'active' | 'replaced' | 'moved' | 'checked_out' | 'expired';
}

interface StayCards {
  enabled: boolean;
  encoderOnline: boolean;
  roomNumber: string | null;
  canIssueNew: boolean;
  canIssueDuplicate: boolean;
  blockedReason: string | null;
  warnings: string[];
  cards: KeyCard[];
}

const STATE_TEXT: Record<NonNullable<KeyCard['state']>, string> = {
  active: 'Opens the room',
  replaced: 'Cancelled by a newer guest card',
  moved: 'Previous room',
  checked_out: 'Guest checked out',
  expired: 'Expired',
};

const waiting = (c: KeyCard) => c.status === 'pending' || c.status === 'encoding';

/** Card status in reception's words. */
export function cardStatus(c: KeyCard): string {
  if (c.status === 'pending') return 'Waiting for the encoder: put a blank card on it';
  if (c.status === 'encoding') return 'Writing the card…';
  if (c.status === 'failed') return c.error ?? 'Failed';
  if (c.status === 'cancelled') return c.error ?? 'Cancelled';
  return c.state ? STATE_TEXT[c.state] : 'Done';
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }) : '');

/** Polls while something is waiting on the encoder, so reception sees "done" as soon as the card is written. */
function usePolling(active: boolean, reload: () => void, ms = 1500) {
  useEffect(() => {
    if (!active) return;
    const t = setInterval(reload, ms);
    return () => clearInterval(t);
  }, [active, reload, ms]);
}

export function KeyCardsPanel({ stayId }: { stayId: string }) {
  const { property, me } = useSession();
  const canIssue = hasPermission(me.roles, 'keycard.issue');
  const { data, error, reload } = useLoad(() => api.get<StayCards>(`${base(property.code)}/stays/${stayId}/key-cards`), [property.code, stayId]);
  const [count, setCount] = useState(1);
  const action = useAction();
  usePolling(!!data?.cards.some(waiting), reload);

  if (error) return <ErrorText error={error} />;
  if (!data || (!data.enabled && data.cards.length === 0)) return null;

  const issue = async (kind: 'new' | 'duplicate', n: number) => {
    const ok = await action.run(({ key }) => api.post(`${base(property.code)}/stays/${stayId}/key-cards`, { kind, count: n }, key));
    if (ok) reload();
  };
  const cancel = async (id: string) => {
    const ok = await action.run(() => api.post(`${base(property.code)}/door-locks/jobs/${id}/cancel`));
    if (ok) reload();
  };

  return (
    <div className="ys-keycards">
      <div className="ys-page-head">
        <h3>Key cards{data.roomNumber ? ` · room ${data.roomNumber}` : ''}</h3>
        {data.enabled && (
          <span className={data.encoderOnline ? 'ys-tone-ok' : 'ys-tone-warn'}>{data.encoderOnline ? 'Encoder ready' : 'Encoder PC offline'}</span>
        )}
        <span className="spacer" />
        {canIssue && data.canIssueNew && (
          <>
            <select aria-label="Number of cards" value={count} onChange={(e) => setCount(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} card{n > 1 ? 's' : ''}</option>)}
            </select>
            <button className="ys-btn small" disabled={action.busy} onClick={() => issue('new', count)}
              title="Makes a card with a new room code; cards of earlier guests stop working once it is used at the door">
              New key card{count > 1 ? 's' : ''}
            </button>
          </>
        )}
        {canIssue && data.canIssueDuplicate && (
          <button className="ys-btn small ghost" disabled={action.busy} onClick={() => issue('duplicate', 1)}
            title="Another card for the same guest; the cards already given keep working">
            Extra card
          </button>
        )}
      </div>
      {data.blockedReason && data.cards.length === 0 && <p className="ys-muted">{data.blockedReason}</p>}
      {data.enabled && !data.encoderOnline && data.canIssueNew && (
        <p className="ys-tone-warn">The encoder PC has not checked in for a while. Make sure the YeaStay lock bridge is running on it.</p>
      )}
      {data.warnings.map((w) => <p key={w} className="ys-tone-warn">{w}</p>)}
      <ErrorText error={action.error} />
      {data.cards.length > 0 && (
        <table className="ys-table compact">
          <thead><tr><th>Card</th><th>Type</th><th>Room</th><th>Valid until</th><th>Status</th><th>By</th><th /></tr></thead>
          <tbody>
            {data.cards.map((c) => (
              <tr key={c.id}>
                <td>{c.cardNo}</td>
                <td>{c.kind === 'new' ? 'New' : 'Extra'}</td>
                <td>{c.roomNumber}</td>
                <td>{fmt(c.validTo)}</td>
                <td className={c.status === 'failed' ? 'ys-tone-danger' : waiting(c) ? 'ys-tone-warn' : c.state === 'active' ? 'ys-tone-ok' : 'ys-muted'}>{cardStatus(c)}</td>
                <td className="ys-muted">{c.requestedBy} · {fmt(c.requestedAt)}</td>
                <td>{canIssue && c.status === 'pending' && <button className="ys-btn small ghost" onClick={() => cancel(c.id)}>Cancel</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Door locks page: read a card (reception) and set-up (managers)
// ---------------------------------------------------------------------------

interface Settings {
  vendor: string;
  enabled: boolean;
  systemCode: string | null;
  hotelCode: string | null;
  cardPass: string;
  comPort: number;
  cardGraceMinutes: number;
  bridge: { paired: boolean; pairedAt: string | null; lastSeenAt: string | null; online: boolean; bridgeId: string | null; version: string | null; mode: 'dll' | 'mock' | null };
}

interface LockRoom {
  id: string;
  number: string;
  floor: string | null;
  building: string | null;
  lockAddress: string | null;
  hasGuestCard: boolean;
}

type Job = KeyCard & { matched: KeyCard | null };

function ReadCard() {
  const { property } = useSession();
  const [job, setJob] = useState<Job | null>(null);
  const action = useAction<Job>();
  useEffect(() => {
    if (!job || !waiting(job)) return;
    const t = setInterval(() => {
      api.get<Job>(`${base(property.code)}/door-locks/jobs/${job.id}`).then(setJob, () => undefined);
    }, 1000);
    return () => clearInterval(t);
  }, [job, property.code]);
  const start = async () => {
    const j = await action.run(({ key }) => api.post<Job>(`${base(property.code)}/door-locks/read-card`, {}, key));
    if (j) setJob(j);
  };
  return (
    <section className="ys-card ys-section">
      <h2>Whose card is this?</h2>
      <p className="ys-muted">Put the card on the encoder and read it to see which guest and room it was made for.</p>
      <button className="ys-btn" disabled={action.busy || (!!job && waiting(job))} onClick={start}>Read card on encoder</button>
      <ErrorText error={action.error} />
      {job && waiting(job) && <p className="ys-tone-warn">Reading…</p>}
      {job?.status === 'failed' && <p className="ys-tone-danger">{job.error}</p>}
      {job?.status === 'done' && (
        job.matched ? (
          <p>
            Card {job.readCardNo}: <strong>{job.matched.stayNumber}</strong>, room {job.matched.roomNumber}, valid until {fmt(job.matched.validTo)}.{' '}
            <span className="ys-muted">{cardStatus(job.matched)}.</span>
          </p>
        ) : (
          <p>Card {job.readCardNo} was not made by YeaStay at this property.</p>
        )
      )}
    </section>
  );
}

function SettingsForm({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const { property } = useSession();
  const [form, setForm] = useState({
    enabled: settings.enabled,
    systemCode: settings.systemCode ?? '',
    hotelCode: settings.hotelCode ?? '',
    cardPass: settings.cardPass,
    comPort: settings.comPort,
    cardGraceMinutes: settings.cardGraceMinutes,
  });
  const action = useAction<Settings>();
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const s = await action.run(() =>
      api.put<Settings>(`${base(property.code)}/door-locks/settings`, { ...form, systemCode: form.systemCode || null, hotelCode: form.hotelCode || null }),
    );
    if (s) onSaved(s);
  };
  return (
    <form className="ys-form" onSubmit={save}>
      <div className="ys-row">
        <Field label="SystemCode" hint="From the lock supplier">
          <input value={form.systemCode} onChange={(e) => setForm({ ...form, systemCode: e.target.value.trim() })} autoComplete="off" />
        </Field>
        <Field label="HotelCode" hint="From the lock supplier">
          <input value={form.hotelCode} onChange={(e) => setForm({ ...form, hotelCode: e.target.value.trim() })} autoComplete="off" />
        </Field>
        <Field label="Card key" hint="Supplier default 82A094FFFFFF">
          <input value={form.cardPass} onChange={(e) => setForm({ ...form, cardPass: e.target.value.trim().toUpperCase() })} />
        </Field>
      </div>
      <div className="ys-row">
        <Field label="Encoder COM port" hint="Device Manager > Ports on the encoder PC">
          <input type="number" min={1} max={64} value={form.comPort} onChange={(e) => setForm({ ...form, comPort: Number(e.target.value) })} />
        </Field>
        <Field label="Minutes after check-out time" hint="Cards stop working this long after the stay's check-out time">
          <input type="number" min={0} max={720} value={form.cardGraceMinutes} onChange={(e) => setForm({ ...form, cardGraceMinutes: Number(e.target.value) })} />
        </Field>
      </div>
      <label className="ys-check">
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Make key cards from YeaStay at {property.name}
      </label>
      <ErrorText error={action.error} />
      <button className="ys-btn" disabled={action.busy}>Save</button>
    </form>
  );
}

function Pairing({ settings, onChanged }: { settings: Settings; onChanged: (s: Settings) => void }) {
  const { property } = useSession();
  const [token, setToken] = useState<string | null>(null);
  const action = useAction<{ token: string; settings: Settings }>();
  const pair = async () => {
    if (settings.bridge.paired && !window.confirm('Pair a PC again? The PC paired now stops working until it gets the new token.')) return;
    const res = await action.run(() => api.post<{ token: string; settings: Settings }>(`${base(property.code)}/door-locks/bridge/pair`));
    if (res) {
      setToken(res.token);
      onChanged(res.settings);
    }
  };
  const b = settings.bridge;
  const apiUrl = `${window.location.origin}/api`;
  return (
    <section className="ys-card ys-section">
      <h2>Encoder PC</h2>
      {b.paired ? (
        <p>
          <span className={b.online ? 'ys-tone-ok' : 'ys-tone-warn'}>{b.online ? 'Online' : 'Offline'}</span>
          {b.bridgeId && <> · {b.bridgeId}</>}
          {b.mode && <> · {b.mode === 'mock' ? 'test mode (no encoder)' : 'encoder'}</>}
          {b.version && <> · bridge {b.version}</>}
          {b.lastSeenAt && <span className="ys-muted"> · last seen {fmt(b.lastSeenAt)}</span>}
        </p>
      ) : (
        <p className="ys-muted">No PC paired yet. Install the YeaStay lock bridge on the PC the encoder is plugged into, then pair it here.</p>
      )}
      <button className="ys-btn ghost" disabled={action.busy} onClick={pair}>{b.paired ? 'Pair again' : 'Pair encoder PC'}</button>
      <ErrorText error={action.error} />
      {token && (
        <div className="ys-token">
          <p>
            Put this in <code>appsettings.json</code> next to <code>YeaStayLockBridge.exe</code> on the encoder PC. It is shown only once.
          </p>
          <pre>{JSON.stringify({ CloudApiUrl: apiUrl, BridgeToken: token, Mode: 'dll' }, null, 2)}</pre>
        </div>
      )}
    </section>
  );
}

function RoomAddresses() {
  const { property } = useSession();
  const { data, error, reload } = useLoad(() => api.get<LockRoom[]>(`${base(property.code)}/door-locks/rooms`), [property.code]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [paste, setPaste] = useState('');
  const [saved, setSaved] = useState(false);
  const action = useAction<LockRoom[]>();
  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="ys-muted">Loading rooms…</p>;

  const fromPaste = () => {
    const next = { ...edits };
    for (const line of paste.split(/\r?\n/)) {
      const [room, address] = line.split(/[\s,;\t]+/).filter(Boolean);
      if (room && address) next[room.toUpperCase()] = address;
    }
    setEdits(next);
    setPaste('');
  };
  const save = async () => {
    const rooms = Object.entries(edits).map(([number, a]) => ({ number, lockAddress: a.trim() || null }));
    if (!rooms.length) return;
    const res = await action.run(() => api.put<LockRoom[]>(`${base(property.code)}/door-locks/rooms`, { rooms }));
    if (res) {
      setEdits({});
      setSaved(true);
      reload();
    }
  };
  const missing = data.filter((r) => !r.lockAddress).length;
  return (
    <section className="ys-card ys-section">
      <h2>Room lock addresses</h2>
      <p className="ys-muted">
        The 11-digit address of each door, from the Room page of the lock software (for example 01010200600). {missing ? `${missing} room(s) have none yet.` : 'Every room has one.'}
      </p>
      <Field label="Paste from the lock software" hint="One room per line: room number, then address">
        <textarea rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'101 01010100100\n102 01010100200'} />
      </Field>
      <button className="ys-btn ghost small" onClick={fromPaste} disabled={!paste.trim()}>Fill in from pasted lines</button>
      <table className="ys-table compact">
        <thead><tr><th>Room</th><th>Floor</th><th>Lock address</th></tr></thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.id}>
              <td>{r.number}</td>
              <td>{r.floor}</td>
              <td>
                <input
                  aria-label={`Lock address for room ${r.number}`}
                  value={edits[r.number] ?? r.lockAddress ?? ''}
                  onChange={(e) => { setSaved(false); setEdits({ ...edits, [r.number]: e.target.value.replace(/\D/g, '').slice(0, 11) }); }}
                  inputMode="numeric"
                  placeholder="01…"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorText error={action.error} />
      {saved && <p className="ys-ok">Saved.</p>}
      <button className="ys-btn" disabled={action.busy || Object.keys(edits).length === 0} onClick={save}>
        Save {Object.keys(edits).length || ''} change{Object.keys(edits).length === 1 ? '' : 's'}
      </button>
    </section>
  );
}

export function DoorLocksPage() {
  const { property, me } = useSession();
  const canConfigure = hasPermission(me.roles, 'doorlock.configure');
  const canIssue = hasPermission(me.roles, 'keycard.issue');
  const { data, error } = useLoad(() => api.get<Settings>(`${base(property.code)}/door-locks/settings`), [property.code]);
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => setSettings(data), [data]);
  if (error) return <ErrorText error={error} />;
  if (!settings) return <p className="ys-muted">Loading…</p>;
  return (
    <>
      <div className="ys-page-head">
        <h1>Door locks</h1>
        <StatusBadge status={settings.enabled ? 'enabled' : 'disabled'} />
        <span className="ys-muted">{label(settings.vendor)} · {property.name}</span>
      </div>
      {canIssue && <ReadCard />}
      {canConfigure && (
        <>
          <section className="ys-card ys-section">
            <h2>Lock system</h2>
            <SettingsForm settings={settings} onSaved={setSettings} />
          </section>
          <Pairing settings={settings} onChanged={setSettings} />
          <RoomAddresses />
        </>
      )}
    </>
  );
}
