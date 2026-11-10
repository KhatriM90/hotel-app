import { useState } from 'react';
import { api } from '../api';
import { base, ErrorText, Field, label, Modal, StatusBadge, useAction, useLoad, useSession } from '../ui';

/**
 * Printers for kitchen and bar tickets and guest bills (INT-04; Kahama meeting
 * item 2.4). The YeaStay POS bridge on a PC at the property sends each job to
 * the Epson printer and reports back. A job that fails three times moves to the
 * printer's backup and shows as an alert on the waiter's and the station's screen.
 */

const pos = (code: string) => `${base(code)}/pos`;
const when = (v: string | null) => (v ? new Date(v).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

interface Bridge { paired: boolean; pairedAt: string | null; lastSeenAt: string | null; online: boolean; bridgeId: string | null; version: string | null; mode: 'live' | 'mock' | null }
interface Printer {
  id: string; code: string; name: string; connection: 'network' | 'windows'; host: string | null; port: number; windowsName: string | null; paperMm: 58 | 80;
  backupPrinterId: string | null; backupPrinterName: string | null; isActive: boolean;
}
interface Setup {
  bridge: Bridge;
  printers: Printer[];
  stations: Array<{ code: string; name: string; kind: string; printerId: string | null; isActive: boolean }>;
  outlets: Array<{ code: string; name: string; printerId: string | null }>;
}
interface Job {
  id: string; kind: string; title: string; status: string; attempts: number; error: string | null; createdAt: string; printedAt: string | null; failedAt: string | null;
  printer: string; outlet: string | null; acknowledgedAt: string | null; acknowledgedBy: string | null; replacedById: string | null; replacedByStatus: string | null; replacedByPrinter: string | null;
}

export function PosPrintersPage() {
  const { property } = useSession();
  const setup = useLoad(() => api.get<Setup>(`${pos(property.code)}/printers`), [property.code]);
  const [editing, setEditing] = useState<Printer | 'new' | null>(null);
  const s = setup.data;
  return (
    <>
      <div className="ys-page-head">
        <h1>Printers · {property.name}</h1>
        <span className="spacer" />
        <button className="ys-btn" onClick={() => setEditing('new')}>Add printer</button>
      </div>
      <p className="ys-muted">
        Kitchen and bar tickets print as soon as an order is sent, and bills and receipts print on the outlet's receipt printer. The YeaStay POS bridge on a PC at this
        property sends each job to the printer. A job that fails is tried three times, then sent to the printer's backup, and the waiter and the station screen see a red
        alert until someone prints it again or marks it dealt with.
      </p>
      <ErrorText error={setup.error} />
      {s && (
        <>
          <BridgeCard bridge={s.bridge} onChanged={setup.reload} />
          <h2>Printers</h2>
          <table className="ys-table compact">
            <thead><tr><th>Code</th><th>Name</th><th>Connection</th><th>Paper</th><th>Backup</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {s.printers.length === 0 && <tr><td colSpan={7} className="ys-muted">No printers yet. Add each Epson with its IP address (network) or its Windows printer name (USB).</td></tr>}
              {s.printers.map((p) => <PrinterRow key={p.id} p={p} onEdit={() => setEditing(p)} />)}
            </tbody>
          </table>
          <Assignments setup={s} onChanged={setup.reload} />
          <Jobs />
        </>
      )}
      {editing && s && (
        <PrinterForm printer={editing === 'new' ? null : editing} printers={s.printers} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setup.reload(); }} />
      )}
    </>
  );
}

function BridgeCard({ bridge: b, onChanged }: { bridge: Bridge; onChanged: () => void }) {
  const { property } = useSession();
  const [token, setToken] = useState<string | null>(null);
  const action = useAction<unknown>();
  const pair = async () => {
    if (b.paired && !window.confirm('Pair a PC again? The PC paired now stops printing until it gets the new token.')) return;
    const res = (await action.run(({ key }) => api.post<{ token: string }>(`${pos(property.code)}/bridge/pair`, {}, key))) as { token: string } | undefined;
    if (res) {
      setToken(res.token);
      onChanged();
    }
  };
  const unpair = async () => {
    if (!window.confirm('Unpair the print PC? Nothing prints until a PC is paired again.')) return;
    if (await action.run(({ key }) => api.post(`${pos(property.code)}/bridge/unpair`, {}, key))) {
      setToken(null);
      onChanged();
    }
  };
  return (
    <section className="ys-card ys-section">
      <h2>Print PC</h2>
      {b.paired ? (
        <p>
          <span className={b.online ? 'ys-tone-ok' : 'ys-tone-warn'}>{b.online ? 'Online' : 'Offline'}</span>
          {b.bridgeId && <> · {b.bridgeId}</>}
          {b.mode && <> · {b.mode === 'mock' ? 'test mode (saves jobs to files)' : 'printing'}</>}
          {b.version && <> · bridge {b.version}</>}
          <span className="ys-muted"> · last seen {when(b.lastSeenAt)}</span>
        </p>
      ) : (
        <p className="ys-muted">No PC paired yet. Install the YeaStay POS bridge on a PC at the property that stays switched on, then pair it here.</p>
      )}
      {b.paired && !b.online && <p className="ys-warn-text">While the print PC is offline, tickets do not print: waiters see an alert after a minute.</p>}
      <div className="ys-row">
        <button className="ys-btn ghost" disabled={action.busy} onClick={pair}>{b.paired ? 'Pair again' : 'Pair print PC'}</button>
        {b.paired && <button className="ys-btn ghost" disabled={action.busy} onClick={unpair}>Unpair</button>}
      </div>
      <ErrorText error={action.error} />
      {token && (
        <div className="ys-token">
          <p>Put this in <code>appsettings.json</code> next to <code>YeaStayPosBridge.exe</code> on the print PC. It is shown only once.</p>
          <pre>{JSON.stringify({ CloudApiUrl: `${window.location.origin}/api`, BridgeToken: token, Mode: 'live' }, null, 2)}</pre>
        </div>
      )}
    </section>
  );
}

function PrinterRow({ p, onEdit }: { p: Printer; onEdit: () => void }) {
  const { property } = useSession();
  const action = useAction<unknown>();
  const [sent, setSent] = useState(false);
  return (
    <tr className={p.isActive ? '' : 'ys-muted'}>
      <td>{p.code}</td>
      <td>{p.name}</td>
      <td>{p.connection === 'network' ? `Network ${p.host}:${p.port}` : `Windows "${p.windowsName}"`}</td>
      <td>{p.paperMm} mm</td>
      <td>{p.backupPrinterName ?? '—'}</td>
      <td>{p.isActive ? 'In use' : 'Switched off'}</td>
      <td>
        <button className="ys-btn small ghost" onClick={onEdit}>Edit</button>{' '}
        <button
          className="ys-btn small ghost"
          disabled={action.busy || !p.isActive}
          onClick={() => void action.run(({ key }) => api.post(`${pos(property.code)}/printers/${p.id}/test`, {}, key)).then((r) => r && setSent(true))}
        >
          Test print
        </button>
        {sent && <span className="ys-muted"> sent; see the jobs below</span>}
        <ErrorText error={action.error} />
      </td>
    </tr>
  );
}

function PrinterForm({ printer, printers, onClose, onSaved }: { printer: Printer | null; printers: Printer[]; onClose: () => void; onSaved: () => void }) {
  const { property } = useSession();
  const [f, setF] = useState({
    code: printer?.code ?? '', name: printer?.name ?? '', connection: printer?.connection ?? 'network', host: printer?.host ?? '', port: String(printer?.port ?? 9100),
    windowsName: printer?.windowsName ?? '', paperMm: String(printer?.paperMm ?? 80), backupPrinterId: printer?.backupPrinterId ?? '', isActive: printer?.isActive ?? true,
  });
  const action = useAction<unknown>();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = {
      name: f.name, connection: f.connection,
      host: f.connection === 'network' ? f.host : null, port: Number(f.port) || 9100,
      windowsName: f.connection === 'windows' ? f.windowsName : null,
      paperMm: Number(f.paperMm), backupPrinterId: f.backupPrinterId || null, isActive: f.isActive,
    };
    const ok = await action.run(({ key }) =>
      printer ? api.patch(`${pos(property.code)}/printers/${printer.id}`, body) : api.post(`${pos(property.code)}/printers`, { code: f.code, ...body }, key),
    );
    if (ok) onSaved();
  };
  return (
    <Modal title={printer ? `Edit ${printer.name}` : 'Add printer'} onClose={onClose}>
      <form onSubmit={save} className="ys-form">
        {!printer && <Field label="Code" required hint="Short, e.g. KM-KIT1"><input value={f.code} onChange={set('code')} required pattern="[A-Za-z0-9-]{2,16}" /></Field>}
        <Field label="Name" required hint="As staff know it, e.g. Main kitchen Epson"><input value={f.name} onChange={set('name')} required minLength={2} maxLength={60} /></Field>
        <Field label="Connected by">
          <select value={f.connection} onChange={set('connection')}>
            <option value="network">Network (Ethernet or Wi-Fi), raw port 9100</option>
            <option value="windows">USB, installed in Windows on the print PC</option>
          </select>
        </Field>
        {f.connection === 'network' ? (
          <div className="ys-row">
            <Field label="IP address" required hint="Fix it in the router so it does not change"><input value={f.host} onChange={set('host')} required placeholder="192.168.1.50" /></Field>
            <Field label="Port"><input value={f.port} onChange={set('port')} inputMode="numeric" pattern="\d{1,5}" /></Field>
          </div>
        ) : (
          <Field label="Windows printer name" required hint="Exactly as in Settings > Printers on the print PC"><input value={f.windowsName} onChange={set('windowsName')} required /></Field>
        )}
        <Field label="Paper width">
          <select value={f.paperMm} onChange={set('paperMm')}><option value="80">80 mm</option><option value="58">58 mm</option></select>
        </Field>
        <Field label="Backup printer" hint="Where a job goes after three failed tries">
          <select value={f.backupPrinterId} onChange={set('backupPrinterId')}>
            <option value="">None</option>
            {printers.filter((p) => p.isActive && p.id !== printer?.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        {printer && (
          <label className="ys-check"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> In use</label>
        )}
        <ErrorText error={action.error} />
        <div className="ys-row">
          <button className="ys-btn" disabled={action.busy}>Save</button>
          <button type="button" className="ys-btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function Assignments({ setup, onChanged }: { setup: Setup; onChanged: () => void }) {
  const { property } = useSession();
  const action = useAction<unknown>();
  const active = setup.printers.filter((p) => p.isActive);
  const assign = (target: { station: string } | { outlet: string }, printerId: string) =>
    void action.run(() => api.put(`${pos(property.code)}/printer-assignments`, { ...target, printerId: printerId || null })).then((r) => r && onChanged());
  const pick = (value: string | null, onChange: (v: string) => void) => (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={action.busy}>
      <option value="">No printer (screen or tablet only)</option>
      {active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
  return (
    <>
      <h2>Which printer prints what</h2>
      <ErrorText error={action.error} />
      <div className="ys-row" style={{ alignItems: 'flex-start' }}>
        <table className="ys-table compact">
          <thead><tr><th>Kitchen and bar station</th><th>Ticket printer</th></tr></thead>
          <tbody>
            {setup.stations.filter((s) => s.isActive).map((s) => (
              <tr key={s.code}><td>{s.name} <span className="ys-muted">{label(s.kind)}</span></td><td>{pick(s.printerId, (v) => assign({ station: s.code }, v))}</td></tr>
            ))}
          </tbody>
        </table>
        <table className="ys-table compact">
          <thead><tr><th>Outlet</th><th>Bill and receipt printer</th></tr></thead>
          <tbody>
            {setup.outlets.map((o) => (
              <tr key={o.code}><td>{o.name}</td><td>{pick(o.printerId, (v) => assign({ outlet: o.code }, v))}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Words for a job's state that a supervisor can act on. */
export function jobState(j: Pick<Job, 'status' | 'acknowledgedAt' | 'acknowledgedBy' | 'replacedById' | 'replacedByStatus' | 'replacedByPrinter'>): string {
  if (j.status !== 'failed') return label(j.status);
  if (j.replacedById) return `Failed; ${j.replacedByPrinter ?? 'sent again'}: ${label(j.replacedByStatus ?? 'queued').toLowerCase()}`;
  if (j.acknowledgedAt) return `Failed; dealt with by ${j.acknowledgedBy ?? 'staff'}`;
  return 'Failed; waiting for staff';
}

function Jobs() {
  const { property } = useSession();
  const [onlyFailed, setOnlyFailed] = useState(false);
  const jobs = useLoad(() => api.get<Job[]>(`${pos(property.code)}/print-jobs?failed=${onlyFailed}`), [property.code, onlyFailed]);
  const action = useAction<unknown>();
  return (
    <>
      <div className="ys-page-head">
        <h2>Print jobs, last two days</h2>
        <span className="spacer" />
        <label className="ys-check"><input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} /> Failed only</label>
        <button className="ys-btn small ghost" onClick={jobs.reload}>Refresh</button>
      </div>
      <ErrorText error={jobs.error ?? action.error} />
      <table className="ys-table compact">
        <thead><tr><th>Time</th><th>What</th><th>Outlet</th><th>Printer</th><th>Tries</th><th>State</th><th>Problem</th><th></th></tr></thead>
        <tbody>
          {jobs.data?.length === 0 && <tr><td colSpan={8} className="ys-muted">No print jobs.</td></tr>}
          {(jobs.data ?? []).map((j) => (
            <tr key={j.id} className={j.status === 'failed' && !j.replacedById && !j.acknowledgedAt ? 'ys-warn-text' : ''}>
              <td>{when(j.createdAt)}</td>
              <td>{j.title}</td>
              <td>{j.outlet ?? '—'}</td>
              <td>{j.printer}</td>
              <td>{j.attempts}</td>
              <td><StatusBadge status={j.status} /> {j.status === 'failed' && <span className="ys-muted">{jobState(j)}</span>}</td>
              <td>{j.error ?? ''}</td>
              <td>
                {j.status === 'failed' && !j.replacedById && (
                  <button
                    className="ys-btn small ghost"
                    disabled={action.busy}
                    onClick={() => void action.run(({ key }) => api.post(`${pos(property.code)}/print-jobs/${j.id}/retry`, {}, key)).then((r) => r && jobs.reload())}
                  >
                    Print again
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
