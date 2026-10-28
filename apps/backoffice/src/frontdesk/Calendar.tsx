import { useState } from 'react';
import { addDays } from '@hotel/shared';
import { api } from '../api';
import { base, ErrorText, Field, useLoad, useSession } from '../ui';

/** Availability calendar by room and day, week or month (RES-01). */

interface Cell {
  date: string;
  state: 'free' | 'reserved' | 'hold' | 'occupied' | 'departed' | 'blocked';
  stayNumber?: string;
  reservationId?: string;
  guestName?: string;
  isArrival?: boolean;
  isDeparture?: boolean;
  reason?: string;
}

interface Grid {
  dates: string[];
  rooms: Array<{ id: string; number: string; roomTypeCode: string; hkStatus: string; cells: Cell[] }>;
  roomTypes: Array<{ code: string; name: string; total: number; free: number[] }>;
  movement: Array<{ date: string; arrivals: number; departures: number }>;
}

const VIEWS = [
  ['Day', 1],
  ['Week', 7],
  ['Month', 31],
] as const;

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function CalendarPage() {
  const { property, go } = useSession();
  const [from, setFrom] = useState(property.currentBusinessDate);
  const [days, setDays] = useState<number>(7);
  const { data, error } = useLoad(() => api.get<Grid>(`${base(property.code)}/availability?from=${from}&days=${days}`), [property.code, from, days]);

  return (
    <>
      <div className="ys-page-head">
        <h1>Availability · {property.name}</h1>
        <span className="spacer" />
        <div className="ys-segmented" role="group" aria-label="View">
          {VIEWS.map(([name, n]) => (
            <button key={name} aria-pressed={days === n} onClick={() => setDays(n)}>{name}</button>
          ))}
        </div>
        <button className="ys-btn ghost" onClick={() => setFrom(addDays(from, -days))} aria-label="Previous">‹</button>
        <Field label="From">
          <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </Field>
        <button className="ys-btn ghost" onClick={() => setFrom(addDays(from, days))} aria-label="Next">›</button>
      </div>
      <ErrorText error={error} />
      {data && (
        <div className="ys-cal-wrap">
          <table className="ys-cal">
            <thead>
              <tr>
                <th>Room</th>
                {data.dates.map((d) => (
                  <th key={d} className={d === property.currentBusinessDate ? 'today' : ''}>
                    <span>{WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]}</span> {d.slice(8)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.roomTypes.map((t) => (
                <tr key={`t-${t.code}`} className="ys-cal-type">
                  <th title={t.name}>{t.code} free</th>
                  {t.free.map((n, i) => (
                    <td key={i} className={n === 0 ? 'full' : ''}>{n}/{t.total}</td>
                  ))}
                </tr>
              ))}
              {data.rooms.map((room) => (
                <tr key={room.id}>
                  <th>
                    {room.number} <small className="ys-muted">{room.roomTypeCode}</small>
                  </th>
                  {room.cells.map((c) => (
                    <td
                      key={c.date}
                      className={`cell ${c.state}${c.isArrival ? ' arrival' : ''}${c.isDeparture ? ' departure' : ''}`}
                      title={c.state === 'blocked' ? `Blocked: ${c.reason}` : c.guestName ? `${c.guestName} · ${c.stayNumber}` : 'Free'}
                      onClick={() => {
                        if (c.reservationId) go('reservation', { id: c.reservationId });
                        else if (c.state === 'free') go('new-reservation', { arrival: c.date, roomTypeCode: room.roomTypeCode });
                      }}
                    >
                      {c.isArrival || days === 1 ? (c.guestName ?? (c.state === 'blocked' ? 'Blocked' : '')) : ''}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="ys-cal-type">
                <th>Arrivals / departures</th>
                {data.movement.map((m) => (
                  <td key={m.date}>{m.arrivals}/{m.departures}</td>
                ))}
              </tr>
            </tbody>
          </table>
          <p className="ys-legend">
            <span className="cell reserved">Reserved</span>
            <span className="cell hold">On hold</span>
            <span className="cell occupied">In house</span>
            <span className="cell blocked">Blocked</span>
            <span className="cell free">Free (click to book)</span>
          </p>
        </div>
      )}
    </>
  );
}
