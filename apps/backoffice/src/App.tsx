import { useEffect, useState } from 'react';
import { api, ApiError, Me, OutboxEvent, Outlet, Property } from './api';

type Page = 'overview' | 'outlets' | 'integration';

function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.login(username.trim(), password));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Wrong username or password' : 'Cannot reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ys-login">
      <form onSubmit={submit} aria-label="Sign in">
        <img className="logo" src="/brand/yeastay-logo-tagline.svg" alt="YeaStay" />
        <label htmlFor="username">Username</label>
        <input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="ys-error" role="alert">{error}</p>}
        <button className="ys-btn" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function Overview({ properties }: { properties: Property[] }) {
  return (
    <>
      <h1>Properties</h1>
      <div className="ys-grid">
        {properties.map((p) => (
          <div className="ys-card" key={p.id}>
            <h3>
              {p.name} {p.isHeadOffice && <span className="ys-badge hq">HQ</span>}
            </h3>
            <p className="ys-muted">{p.location}</p>
            <p>
              Code <strong>{p.code}</strong> · Business date <strong>{p.currentBusinessDate}</strong>
            </p>
            <p className="ys-muted">
              SAP branch {p.sapBranchId ?? 'TBC'} · eTIMS branch {p.etimsBranchId ?? 'TBC'}
            </p>
          </div>
        ))}
      </div>
    </>
  );
}

function Outlets({ property }: { property: Property }) {
  const [outlets, setOutlets] = useState<Outlet[] | null>(null);
  useEffect(() => {
    setOutlets(null);
    api.outlets(property.code).then(setOutlets, () => setOutlets([]));
  }, [property.code]);
  return (
    <>
      <h1>Outlets · {property.name}</h1>
      {!outlets ? (
        <p className="ys-muted">Loading…</p>
      ) : (
        <table className="ys-table">
          <thead>
            <tr><th>Code</th><th>Name</th><th>Type</th><th>Revenue centre</th><th>Warehouse</th><th>Alcohol</th></tr>
          </thead>
          <tbody>
            {outlets.map((o) => (
              <tr key={o.id}>
                <td>{o.code}</td><td>{o.name}</td><td>{o.type}</td><td>{o.revenueCentre}</td>
                <td>{o.issuingWarehouseCode ?? '—'}</td><td>{o.sellsAlcohol ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Integration({ property }: { property: Property }) {
  const [events, setEvents] = useState<OutboxEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setEvents(null);
    setError(null);
    api.outbox(property.code).then(setEvents, (e: ApiError) => setError(e.message));
  }, [property.code]);
  return (
    <>
      <h1>SAP postings · {property.name}</h1>
      {error && <p className="ys-error">{error}</p>}
      {events && (
        <table className="ys-table">
          <thead>
            <tr><th>Reference</th><th>Type</th><th>Status</th><th>Attempts</th><th>SAP doc</th><th>Last error</th></tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr><td colSpan={6} className="ys-muted">Nothing queued.</td></tr>
            )}
            {events.map((e) => (
              <tr key={e.id}>
                <td>{e.externalRef}</td><td>{e.eventType}</td>
                <td><span className={`ys-badge ${e.status}`}>{e.status}</span></td>
                <td>{e.attempts}</td><td>{e.sapDocNum ?? '—'}</td><td>{e.lastError ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(Boolean(api.token));
  const [properties, setProperties] = useState<Property[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [page, setPage] = useState<Page>('overview');

  useEffect(() => {
    if (!api.token) return;
    api.me().then(setMe, () => api.logout()).finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!me) return;
    api.properties().then((ps) => {
      setProperties(ps);
      setCurrent((c) => c || ps[0]?.code || '');
    });
  }, [me]);

  if (checking) return null;
  if (!me) return <Login onLogin={setMe} />;

  const property = properties.find((p) => p.code === current);
  const nav: Array<[Page, string]> = [
    ['overview', 'Overview'],
    ['outlets', 'Outlets'],
    ['integration', 'SAP postings'],
  ];

  return (
    <>
      <header className="ys-header">
        <img src="/brand/yeastay-logo-white.svg" alt="YeaStay" />
        <span className="spacer" />
        {properties.length > 0 && (
          <select aria-label="Property" value={current} onChange={(e) => setCurrent(e.target.value)}>
            {properties.map((p) => (
              <option key={p.code} value={p.code}>{p.name}</option>
            ))}
          </select>
        )}
        <span className="ys-user">{me.displayName}</span>
        <button className="ys-btn" onClick={() => { api.logout(); setMe(null); }}>Sign out</button>
      </header>
      <div className="ys-layout">
        <nav className="ys-nav" aria-label="Main">
          {nav.map(([key, label]) => (
            <button key={key} aria-current={page === key ? 'page' : undefined} onClick={() => setPage(key)}>
              {label}
            </button>
          ))}
        </nav>
        <main className="ys-main">
          {page === 'overview' && <Overview properties={properties} />}
          {page === 'outlets' && property && <Outlets property={property} />}
          {page === 'integration' && property && <Integration property={property} />}
        </main>
      </div>
    </>
  );
}
