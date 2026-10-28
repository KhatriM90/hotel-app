import { useCallback, useEffect, useMemo, useState } from 'react';
import { hasPermission, Permission } from '@hotel/shared';
import { api, ApiError, Me, OutboxEvent, Outlet, Property } from './api';
import { Session, SessionContext } from './ui';
import { CalendarPage } from './frontdesk/Calendar';
import { DashboardPage } from './frontdesk/Dashboard';
import { FolioPage } from './frontdesk/Folio';
import { GuestPage, GuestsPage } from './frontdesk/Guests';
import { RequestsPage } from './frontdesk/Requests';
import { NewReservationPage, ReservationDetailPage, ReservationsPage } from './frontdesk/Reservations';
import { RatesPage, RoomsPage } from './frontdesk/Rooms';

type Page =
  | 'desk' | 'calendar' | 'reservations' | 'new-reservation' | 'reservation' | 'folio'
  | 'guests' | 'guest' | 'requests' | 'rooms' | 'rates'
  | 'overview' | 'outlets' | 'integration';

/** Main navigation; each entry shows only for users holding its permission (the API enforces the same, SEC-01). */
const NAV: Array<[Page, string, Permission?]> = [
  ['desk', 'Front desk', 'frontdesk.operate'],
  ['calendar', 'Availability', 'reservation.read'],
  ['reservations', 'Reservations', 'reservation.read'],
  ['guests', 'Guests', 'guest.read'],
  ['requests', 'Guest requests', 'guest_request.manage'],
  ['rooms', 'Rooms', 'room.read'],
  ['rates', 'Rates and policy', 'rate.read'],
  ['overview', 'Properties'],
  ['outlets', 'Outlets'],
  ['integration', 'SAP postings'],
];

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
              SAP branch {p.sapBranchId ?? 'TBC'}
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
            <tr><th>Code</th><th>Name</th><th>SAP outlet</th><th>SAP dim. 2</th><th>SAP warehouse</th><th>Type</th><th>Revenue centre</th><th>Alcohol</th></tr>
          </thead>
          <tbody>
            {outlets.map((o) => (
              <tr key={o.id}>
                <td>{o.code}</td><td>{o.name}</td><td>{o.sapOutletName ?? '—'}</td><td>{o.sapDimension2Code ?? '—'}</td><td>{o.issuingWarehouseCode ?? '—'}</td><td>{o.type}</td><td>{o.revenueCentre}</td>
                <td>{o.sellsAlcohol ? 'Yes' : 'No'}</td>
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
  const [route, setRoute] = useState<{ page: Page; params: Record<string, string> }>({ page: 'desk', params: {} });

  useEffect(() => {
    if (!api.token) return;
    api.me().then(setMe, () => api.logout()).finally(() => setChecking(false));
  }, []);

  const loadProperties = useCallback(() => {
    api.properties().then((ps) => {
      setProperties(ps);
      setCurrent((c) => c || ps[0]?.code || '');
    });
  }, []);

  useEffect(() => {
    if (!me) return;
    loadProperties();
    if (!hasPermission(me.roles, 'frontdesk.operate')) setRoute({ page: 'overview', params: {} });
  }, [me, loadProperties]);

  const property = properties.find((p) => p.code === current);
  const go = useCallback((page: string, params: Record<string, string> = {}) => {
    const { property: switchTo, ...rest } = params;
    if (switchTo) setCurrent(switchTo);
    setRoute({ page: page as Page, params: rest });
    window.scrollTo?.(0, 0);
  }, []);
  const session = useMemo<Session | null>(
    () => (me && property ? { me, property, go, refreshProperty: loadProperties } : null),
    [me, property, go, loadProperties],
  );

  if (checking) return null;
  if (!me) return <Login onLogin={setMe} />;

  const nav = NAV.filter(([, , perm]) => !perm || hasPermission(me.roles, perm));
  const { page, params } = route;
  const section: Page =
    page === 'new-reservation' || page === 'reservation' || page === 'folio' ? 'reservations' : page === 'guest' ? 'guests' : page;

  return (
    <>
      <header className="ys-header">
        <img src="/brand/yeastay-logo-white.svg" alt="YeaStay" />
        <span className="spacer" />
        {properties.length > 0 && (
          <select
            aria-label="Property"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value);
              // Records belong to one property; switching leaves the record page (CFG-02).
              if (['reservation', 'folio', 'new-reservation'].includes(page)) setRoute({ page: 'desk', params: {} });
            }}
          >
            {properties.map((p) => (
              <option key={p.code} value={p.code}>{p.name}</option>
            ))}
          </select>
        )}
        {property && <span className="ys-user">Business date {property.currentBusinessDate}</span>}
        <span className="ys-user">{me.displayName}</span>
        <button className="ys-btn" onClick={() => { api.logout(); setMe(null); }}>Sign out</button>
      </header>
      <div className="ys-layout">
        <nav className="ys-nav" aria-label="Main">
          {nav.map(([key, label]) => (
            <button key={key} aria-current={section === key ? 'page' : undefined} onClick={() => go(key)}>
              {label}
            </button>
          ))}
        </nav>
        <main className="ys-main">
          {page === 'overview' && <Overview properties={properties} />}
          {page === 'outlets' && property && <Outlets property={property} />}
          {page === 'integration' && property && <Integration property={property} />}
          {session && (
            <SessionContext.Provider value={session}>
              {page === 'desk' && <DashboardPage key={current} />}
              {page === 'calendar' && <CalendarPage key={current} />}
              {page === 'reservations' && <ReservationsPage key={current + (params.q ?? '')} params={params} />}
              {page === 'new-reservation' && <NewReservationPage key={current + JSON.stringify(params)} params={params} />}
              {page === 'reservation' && params.id && <ReservationDetailPage key={params.id} id={params.id} />}
              {page === 'folio' && params.id && <FolioPage key={params.id} id={params.id} />}
              {page === 'guests' && <GuestsPage />}
              {page === 'guest' && params.id && <GuestPage key={params.id} id={params.id} />}
              {page === 'requests' && <RequestsPage key={current} />}
              {page === 'rooms' && <RoomsPage key={current} />}
              {page === 'rates' && <RatesPage key={current} />}
            </SessionContext.Provider>
          )}
        </main>
      </div>
    </>
  );
}
