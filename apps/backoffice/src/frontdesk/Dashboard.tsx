import { useState } from 'react';
import { hasPermission } from '@hotel/shared';
import { api } from '../api';
import { base, ErrorText, kes, label, Modal, StatusBadge, useAction, useLoad, useSession } from '../ui';
import { CheckInModal, StayRef } from './StayActions';

/** Front desk dashboard (FD-01): today's movement, readiness and balances for one property. */

export interface DeskStay extends StayRef {
  status: string;
  reservationNumber: string;
  guestName: string;
  roomHkStatus: string | null;
  folioId: string;
  balance: string | null;
  paymentsPending: string | null;
  depositRequired: string;
  departureTime: string | null;
}

interface Dashboard {
  businessDate: string;
  counts: Record<'arrivals' | 'departures' | 'inHouse' | 'overdueCheckouts' | 'rooms' | 'vacant' | 'blocked' | 'openRequests', number>;
  arrivals: DeskStay[];
  departures: DeskStay[];
  inHouse: DeskStay[];
  overdueCheckouts: DeskStay[];
  outstandingBalances: DeskStay[];
  roomReadiness: Array<{ status: string; rooms: number; occupied: number }>;
  arrivalsRoomNotReady: DeskStay[];
}

function StayTable({ stays, empty, action }: { stays: DeskStay[]; empty: string; action?: (s: DeskStay) => React.ReactNode }) {
  const { go } = useSession();
  if (!stays.length) return <p className="ys-muted">{empty}</p>;
  return (
    <table className="ys-table compact">
      <thead>
        <tr><th>Room</th><th>Guest</th><th>Stay</th><th>Dates</th><th>Balance</th><th /></tr>
      </thead>
      <tbody>
        {stays.map((s) => (
          <tr key={s.id}>
            <td>
              {s.roomNumber ?? '—'} {s.roomHkStatus && <StatusBadge status={s.roomHkStatus} />}
            </td>
            <td>{s.guestName}</td>
            <td>
              <button className="ys-link" onClick={() => go('reservation', { id: s.reservationId })}>{s.number}</button>
            </td>
            <td className="ys-nowrap">{s.arrivalDate} → {s.departureDate}{s.departureTime ? ` ${s.departureTime.slice(0, 5)}` : ''}</td>
            <td>
              {kes(s.balance)}
              {s.paymentsPending && Number(s.paymentsPending) > 0 && <small className="ys-muted"> ({kes(s.paymentsPending)} pending)</small>}
            </td>
            <td className="ys-actions-cell">{action?.(s)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CloseDayModal({ businessDate, onClose, onDone }: { businessDate: string; onClose: () => void; onDone: () => void }) {
  const { property } = useSession();
  const action = useAction<{ roomChargesPosted: number; businessDate: string; arrivalsNotCheckedIn: number }>();
  const [result, setResult] = useState<{ roomChargesPosted: number; businessDate: string; arrivalsNotCheckedIn: number } | null>(null);
  return (
    <Modal title={`Close business day ${businessDate}`} onClose={result ? onDone : onClose}>
      {result ? (
        <div className="ys-form">
          <p>
            Posted {result.roomChargesPosted} room night charge(s). The business date is now <strong>{result.businessDate}</strong>.
          </p>
          {result.arrivalsNotCheckedIn > 0 && (
            <p className="ys-warn">{result.arrivalsNotCheckedIn} arrival(s) were not checked in. Check them in, cancel them or mark them as no-shows.</p>
          )}
          <div className="ys-actions"><button className="ys-btn" onClick={onDone}>Done</button></div>
        </div>
      ) : (
        <div className="ys-form">
          <p>
            This posts tonight’s room charge to every in-house folio and moves the property to the next business date. It is the basic
            day close for this module; the full night audit (BIL-10) comes later.
          </p>
          <ErrorText error={action.error} />
          <div className="ys-actions">
            <button className="ys-btn ghost" onClick={onClose}>Cancel</button>
            <button
              className="ys-btn"
              disabled={action.busy}
              onClick={async () => {
                const r = await action.run(({ key }) => api.post(`${base(property.code)}/front-desk/close-day`, { businessDate }, key));
                if (r) setResult(r);
              }}
            >
              Close the day
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function DashboardPage() {
  const { property, me, go, refreshProperty } = useSession();
  const { data, error, reload } = useLoad(() => api.get<Dashboard>(`${base(property.code)}/front-desk/dashboard`), [property.code]);
  const [checkIn, setCheckIn] = useState<DeskStay | null>(null);
  const [closing, setClosing] = useState(false);

  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="ys-muted">Loading…</p>;
  const c = data.counts;
  const tiles: Array<[string, number, string?]> = [
    ['Arrivals', c.arrivals],
    ['Departures', c.departures],
    ['In house', c.inHouse],
    ['Overdue check-outs', c.overdueCheckouts, c.overdueCheckouts ? 'alert' : undefined],
    ['Vacant rooms', c.vacant],
    ['Blocked', c.blocked],
    ['Open requests', c.openRequests],
  ];

  return (
    <>
      <div className="ys-page-head">
        <h1>Front desk · {property.name}</h1>
        <span className="ys-muted">Business date {data.businessDate}</span>
        <span className="spacer" />
        <button className="ys-btn ghost" onClick={reload}>Refresh</button>
        <button className="ys-btn" onClick={() => go('new-reservation')}>New booking</button>
        {hasPermission(me.roles, 'businessday.close') && (
          <button className="ys-btn ghost" onClick={() => setClosing(true)}>Close day</button>
        )}
      </div>

      <div className="ys-tiles">
        {tiles.map(([name, n, tone]) => (
          <div key={name} className={`ys-tile ${tone ?? ''}`}>
            <strong>{n}</strong>
            <span>{name}</span>
          </div>
        ))}
      </div>

      <div className="ys-tiles small">
        {data.roomReadiness.map((r) => (
          <div key={r.status} className="ys-tile">
            <strong>{r.rooms}</strong>
            <span>{label(r.status)} ({r.occupied} occupied)</span>
          </div>
        ))}
      </div>

      {data.arrivalsRoomNotReady.length > 0 && (
        <p className="ys-warn">
          Room not ready for {data.arrivalsRoomNotReady.map((s) => `${s.guestName} (room ${s.roomNumber})`).join(', ')}.
        </p>
      )}

      <section className="ys-section">
        <h2>Arrivals</h2>
        <StayTable
          stays={data.arrivals}
          empty="No arrivals left today."
          action={(s) => (
            <>
              {s.arrivalDate < data.businessDate && <StatusBadge status="late" />}
              <button className="ys-btn small" onClick={() => setCheckIn(s)}>Check in</button>
            </>
          )}
        />
      </section>

      {data.overdueCheckouts.length > 0 && (
        <section className="ys-section">
          <h2>Overdue check-outs</h2>
          <StayTable stays={data.overdueCheckouts} empty="" action={(s) => <button className="ys-btn small" onClick={() => go('folio', { id: s.folioId })}>Folio</button>} />
        </section>
      )}

      <section className="ys-section">
        <h2>Departures</h2>
        <StayTable stays={data.departures} empty="No departures today." action={(s) => <button className="ys-btn small" onClick={() => go('folio', { id: s.folioId })}>Check out</button>} />
      </section>

      <section className="ys-section">
        <h2>In house</h2>
        <StayTable stays={data.inHouse} empty="Nobody is in house." action={(s) => <button className="ys-btn small ghost" onClick={() => go('folio', { id: s.folioId })}>Folio</button>} />
      </section>

      <section className="ys-section">
        <h2>Outstanding balances</h2>
        <StayTable stays={data.outstandingBalances} empty="No in-house guest owes anything." />
      </section>

      {checkIn && (
        <CheckInModal
          stay={checkIn}
          onClose={() => setCheckIn(null)}
          onDone={() => {
            setCheckIn(null);
            reload();
          }}
        />
      )}
      {closing && (
        <CloseDayModal
          businessDate={data.businessDate}
          onClose={() => setClosing(false)}
          onDone={() => {
            setClosing(false);
            refreshProperty();
            reload();
          }}
        />
      )}
    </>
  );
}
