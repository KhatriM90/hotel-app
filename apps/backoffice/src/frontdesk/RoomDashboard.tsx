import { useMemo, useState } from 'react';
import {
  addDays,
  csvCell,
  dashboardDates,
  DashboardSegment,
  hasPermission,
  HK_STATUSES,
  MAX_DASHBOARD_DAYS,
  needsHousekeeping,
  nightState,
  ROOM_NIGHT_LABELS,
  RoomNightState,
  segmentOn,
  segmentState,
  summarizeDashboard,
} from '@hotel/shared';
import { api } from '../api';
import { base, ErrorText, Field, label, Modal, useAction, useLoad, useSession } from '../ui';
import { CreditRow, creditMessage } from './StayCredit';
import { MoveModal } from './StayActions';

/**
 * Room status dashboard (client request, 5 Nov 2026), built from the
 * Roomscape prototype on live data: a timeline of rooms by date, a table of
 * room-nights and a card grid for one day. Booking state comes from stays and
 * blocks; housekeeping is shown beside it, never instead of it. Edits go
 * through the same endpoints as the rest of the front desk, with their
 * permissions, approvals and audit trail.
 */

interface Room {
  id: string;
  number: string;
  floor: string | null;
  building: string | null;
  roomTypeCode: string;
  roomTypeName: string;
  hkStatus: string;
  hkUpdatedAt: string | null;
}

interface Segment extends DashboardSegment {
  allocationId: string;
  blockReason: string | null;
  stayId: string | null;
  stayNumber: string | null;
  reservationId: string | null;
  reservationNumber: string | null;
  arrival: string | null;
  departure: string | null;
  adults: number | null;
  children: number | null;
  autoPostRoomCharges: boolean | null;
  agentName: string | null;
}

interface DashboardData {
  from: string;
  to: string;
  businessDate: string;
  rooms: Room[];
  segments: Segment[];
  credit: CreditRow[];
}

type View = 'timeline' | 'table' | 'grid';
type Span = 'day' | 'week' | 'month' | 'custom';
type StatusFilter = '' | RoomNightState | 'needs_cleaning' | 'credit';

const HK_LABEL: Record<string, string> = { clean: 'Clean', inspected: 'Inspected', dirty: 'Needs cleaning', in_progress: 'Cleaning in progress' };
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (d: string) => WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()];

function monthRange(date: string): [string, string] {
  const first = `${date.slice(0, 7)}-01`;
  const next = addDays(first, 32).slice(0, 7);
  return [first, addDays(`${next}-01`, -1)];
}

function rangeFor(span: Span, start: string, customTo: string): [string, string] {
  if (span === 'day') return [start, start];
  if (span === 'week') return [start, addDays(start, 6)];
  if (span === 'month') return monthRange(start);
  return [start, customTo];
}

export function RoomDashboardPage() {
  const { property, me, go } = useSession();
  const [view, setView] = useState<View>('timeline');
  const [span, setSpan] = useState<Span>('week');
  const [start, setStart] = useState(property.currentBusinessDate);
  const [customTo, setCustomTo] = useState(addDays(property.currentBusinessDate, 13));
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [floor, setFloor] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [snapshot, setSnapshot] = useState(property.currentBusinessDate);
  const [selected, setSelected] = useState<{ room: Room; date: string } | null>(null);

  const [from, to] = rangeFor(span, start, customTo);
  let rangeError: string | null = null;
  let dates: string[] = [];
  try {
    dates = dashboardDates(from, to);
  } catch (e) {
    rangeError = (e as Error).message;
  }

  const { data, error, reload } = useLoad(
    () => (rangeError ? Promise.resolve(null) : api.get<DashboardData>(`${base(property.code)}/room-dashboard?from=${from}&to=${to}`)),
    [property.code, from, to],
  );

  const creditByStay = useMemo(() => new Map((data?.credit ?? []).map((c) => [c.stayId, c])), [data]);
  const creditWarn = (stayId: string | null) => {
    const c = stayId ? creditByStay.get(stayId) : undefined;
    return c && (c.status === 'runs_out_tomorrow' || c.status === 'exhausted') ? c : undefined;
  };

  const types = useMemo(() => [...new Map((data?.rooms ?? []).map((r) => [r.roomTypeCode, r.roomTypeName])).entries()], [data]);
  const floors = useMemo(() => [...new Set((data?.rooms ?? []).map((r) => r.floor ?? '').filter(Boolean))].sort(), [data]);
  const segments = data?.segments ?? [];
  const snapDate = dates.includes(snapshot) ? snapshot : dates[0];

  /** Does this room match the filters on this date? Search matches the room number or the guest on that night. */
  const matchesOn = (room: Room, date: string): boolean => {
    const seg = segmentOn(segments, room.id, date);
    const st = seg ? segmentState(seg) : 'available';
    const term = search.trim().toLowerCase();
    if (term && !room.number.toLowerCase().includes(term) && !(seg?.guestName ?? '').toLowerCase().includes(term) && !(seg?.stayNumber ?? '').toLowerCase().includes(term)) return false;
    if (status === 'needs_cleaning') return needsHousekeeping(room.hkStatus);
    if (status === 'credit') return !!creditWarn(seg?.stayId ?? null);
    if (status) return status === 'occupied' ? st === 'occupied' : st === status;
    return true;
  };
  const baseRooms = (data?.rooms ?? []).filter((r) => (!type || r.roomTypeCode === type) && (!floor || r.floor === floor));
  // Timeline and table keep a room when it matches on any day of the period; the grid looks at its one day.
  const rooms = baseRooms.filter((r) => (view === 'grid' ? matchesOn(r, snapDate) : dates.some((d) => matchesOn(r, d))));
  const summary = summarizeDashboard(rooms, segments, view === 'grid' ? [snapDate] : dates);
  const attention =
    rooms.filter((r) => needsHousekeeping(r.hkStatus)).length +
    (data?.credit ?? []).filter((c) => (c.status === 'runs_out_tomorrow' || c.status === 'exhausted') && rooms.some((r) => r.number === c.roomNumber)).length;

  const shift = (dir: 1 | -1) => {
    if (span === 'month') setStart(monthRange(addDays(dir === 1 ? monthRange(start)[1] : monthRange(start)[0], dir))[0]);
    else if (span === 'custom') {
      const n = dates.length || 1;
      setStart(addDays(start, dir * n));
      setCustomTo(addDays(customTo, dir * n));
    } else setStart(addDays(start, dir * (span === 'day' ? 1 : 7)));
  };

  function exportCsv() {
    const lines = [['Room', 'Type', 'Floor', 'Date', 'Status', 'Guest', 'Stay', 'Booking', 'Housekeeping now'].map(csvCell).join(',')];
    for (const r of rooms) {
      for (const d of dates) {
        if (!matchesOn(r, d)) continue;
        const seg = segmentOn(segments, r.id, d);
        const st = seg ? segmentState(seg) : 'available';
        lines.push(
          [r.number, r.roomTypeName, r.floor ?? '', d, ROOM_NIGHT_LABELS[st], seg?.guestName ?? (seg?.kind === 'block' ? seg.blockReason : ''), seg?.stayNumber ?? '', seg?.reservationNumber ?? '', HK_LABEL[r.hkStatus] ?? r.hkStatus]
            .map(csvCell)
            .join(','),
        );
      }
    }
    const blob = new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${property.code}-room-status-${from}_${to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <>
      <div className="ys-page-head">
        <div>
          <h1>Room dashboard · {property.name}</h1>
          <p className="ys-muted">Every room, every night. Click a room-night to open the booking, move the guest, book, block or change housekeeping.</p>
        </div>
        <span className="spacer" />
        <button className="ys-btn ghost" onClick={exportCsv} disabled={!data}>Export CSV</button>
      </div>

      <div className="rd-stats" aria-live="polite">
        <Stat label="Occupancy" value={summary.occupancyPercent === null ? '—' : `${summary.occupancyPercent}%`} note="Occupied ÷ room-nights not blocked" />
        <Stat label="Available" value={summary.available} note="Room-nights free to sell" tone="available" />
        <Stat label="Reserved" value={summary.reserved} note="Booked or on hold, not yet arrived" tone="reserved" />
        <Stat label="Occupied" value={summary.occupied} note="Guest in house (or stayed)" tone="occupied" />
        <Stat label="Blocked" value={summary.blocked} note="Out of order or held back" tone="blocked" />
        <Stat label="Needs attention" value={attention} note="Rooms to clean, credit running out" tone="attention" />
      </div>
      <p className="ys-muted rd-scope">
        {view === 'grid' ? `Figures for ${snapDate}` : `Room-nights from ${from} to ${to} (${dates.length} night${dates.length === 1 ? '' : 's'})`} for the {rooms.length} room
        {rooms.length === 1 ? '' : 's'} shown.
      </p>

      <section className="ys-card rd-panel">
        <div className="rd-toolbar">
          <div className="ys-segmented" role="group" aria-label="View">
            {(['timeline', 'table', 'grid'] as const).map((v) => (
              <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{v === 'timeline' ? 'Calendar' : v === 'table' ? 'Table' : 'Room cards'}</button>
            ))}
          </div>
          <div className="ys-segmented" role="group" aria-label="Period">
            {(['day', 'week', 'month', 'custom'] as const).map((s) => (
              <button key={s} aria-pressed={span === s} onClick={() => setSpan(s)}>{label(s)}</button>
            ))}
          </div>
          <div className="rd-period">
            <button className="ys-btn ghost small" onClick={() => shift(-1)} aria-label="Previous period">‹</button>
            <button className="ys-btn ghost small" onClick={() => { setStart(property.currentBusinessDate); setSnapshot(property.currentBusinessDate); }}>Today</button>
            <button className="ys-btn ghost small" onClick={() => shift(1)} aria-label="Next period">›</button>
            <Field label={span === 'custom' ? 'From' : 'Starting'}>
              <input type="date" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} />
            </Field>
            {span === 'custom' && (
              <Field label="To (inclusive)">
                <input type="date" value={customTo} onChange={(e) => e.target.value && setCustomTo(e.target.value)} />
              </Field>
            )}
            {view === 'grid' && dates.length > 1 && (
              <Field label="Cards show">
                <select value={snapDate} onChange={(e) => setSnapshot(e.target.value)}>
                  {dates.map((d) => <option key={d} value={d}>{weekday(d)} {d}</option>)}
                </select>
              </Field>
            )}
          </div>
        </div>
        <div className="rd-filters">
          <Field label="Search">
            <input type="search" placeholder="Room number, guest or stay" value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <Field label="Room type">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All types</option>
              {types.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </Field>
          {floors.length > 0 && (
            <Field label="Floor">
              <select value={floor} onChange={(e) => setFloor(e.target.value)}>
                <option value="">All floors</option>
                {floors.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
          )}
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="">Any status</option>
              {(['available', 'reserved', 'hold', 'occupied', 'departed', 'blocked'] as const).map((s) => <option key={s} value={s}>{ROOM_NIGHT_LABELS[s]}</option>)}
              <option value="needs_cleaning">Needs cleaning (now)</option>
              <option value="credit">Credit running out</option>
            </select>
          </Field>
        </div>
        <Legend />
        <ErrorText error={rangeError ?? error} />
        {!data && !error && !rangeError && <p className="ys-muted rd-empty">Loading…</p>}
        {data && rooms.length === 0 && <p className="ys-muted rd-empty">No room matches these filters.</p>}
        {data && rooms.length > 0 && view === 'timeline' && (
          <Timeline rooms={rooms} dates={dates} segments={segments} businessDate={data.businessDate} creditWarn={creditWarn} onPick={(room, date) => setSelected({ room, date })} />
        )}
        {data && rooms.length > 0 && view === 'table' && (
          <RoomNightTable rooms={rooms} dates={dates} segments={segments} matches={matchesOn} creditWarn={creditWarn} onPick={(room, date) => setSelected({ room, date })} />
        )}
        {data && rooms.length > 0 && view === 'grid' && (
          <RoomCards rooms={rooms} date={snapDate} segments={segments} creditWarn={creditWarn} onPick={(room) => setSelected({ room, date: snapDate })} />
        )}
        <p className="ys-muted rd-foot">
          Nights run from one day to the next morning: a guest leaving on the 10th occupies the room on the nights of the 8th and 9th. Up to {MAX_DASHBOARD_DAYS} days at a time.
        </p>
      </section>

      {selected && data && (
        <RoomNightPanel
          room={selected.room}
          date={selected.date}
          segment={segmentOn(segments, selected.room.id, selected.date)}
          credit={(() => {
            const s = segmentOn(segments, selected.room.id, selected.date);
            return s?.stayId ? creditByStay.get(s.stayId) : undefined;
          })()}
          businessDate={data.businessDate}
          canBook={hasPermission(me.roles, 'reservation.manage')}
          onClose={() => setSelected(null)}
          onChanged={() => {
            setSelected(null);
            reload();
          }}
          go={go}
        />
      )}
    </>
  );
}

function Stat({ label: text, value, note, tone }: { label: string; value: string | number; note: string; tone?: string }) {
  return (
    <div className={`rd-stat${tone ? ` rd-${tone}` : ''}`}>
      <span>{tone && <i className="rd-dot" aria-hidden />}{text}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

function Legend() {
  return (
    <div className="rd-legend" aria-label="Legend">
      {(['available', 'reserved', 'hold', 'occupied', 'departed', 'blocked'] as const).map((s) => (
        <span key={s} className={`rd-${s}`}><i className="rd-dot" aria-hidden />{ROOM_NIGHT_LABELS[s]}</span>
      ))}
      <span className="rd-attention"><i className="rd-dot" aria-hidden />Needs cleaning (room, now)</span>
      <span>⚠ Credit running out</span>
    </div>
  );
}

function HkBadge({ status }: { status: string }) {
  return <span className={`rd-hk rd-hk-${status}`}>{HK_LABEL[status] ?? label(status)}</span>;
}

function Timeline({
  rooms, dates, segments, businessDate, creditWarn, onPick,
}: {
  rooms: Room[];
  dates: string[];
  segments: Segment[];
  businessDate: string;
  creditWarn: (stayId: string | null) => CreditRow | undefined;
  onPick: (room: Room, date: string) => void;
}) {
  const wide = dates.length <= 14;
  return (
    <div className="rd-scroll">
      {/* Fixed layout: every night gets the same width, however long the guest names are. */}
      <table className={`rd-timeline${wide ? ' wide' : ''}`} style={{ width: 140 + dates.length * (wide ? 120 : 40) }}>
        <thead>
          <tr>
            <th scope="col" style={{ width: 140 }}>Room</th>
            {dates.map((d) => (
              <th key={d} scope="col" className={d === businessDate ? 'today' : ''} style={{ width: wide ? 120 : 40 }}>
                <span>{weekday(d)}</span> {wide ? d.slice(5) : d.slice(8)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rooms.map((room) => {
            const cells = [];
            for (let i = 0; i < dates.length; ) {
              const d = dates[i];
              const seg = segmentOn(segments, room.id, d);
              if (!seg) {
                cells.push(
                  <td key={d} className={d === businessDate ? 'today' : ''}>
                    <button className="rd-cell rd-available" onClick={() => onPick(room, d)} aria-label={`Room ${room.number}, ${d}: available`} />
                  </td>,
                );
                i++;
                continue;
              }
              let n = 1;
              while (i + n < dates.length && segmentOn(segments, room.id, dates[i + n]) === seg) n++;
              const st = segmentState(seg);
              const warn = creditWarn(seg.stayId);
              const text = seg.kind === 'block' ? seg.blockReason ?? 'Blocked' : seg.guestName ?? '';
              cells.push(
                <td key={d} colSpan={n}>
                  <button
                    className={`rd-cell rd-${st}${seg.from < d || seg.from < dates[0] ? ' cont' : ''}${seg.to > addDays(dates[i + n - 1], 1) ? ' more' : ''}`}
                    onClick={() => onPick(room, d)}
                    title={`${ROOM_NIGHT_LABELS[st]} · ${text}${seg.stayNumber ? ` · ${seg.stayNumber}` : ''} · ${seg.from} to ${seg.to}`}
                  >
                    {warn && <span aria-label="Credit running out">⚠ </span>}
                    {text}
                    {wide && n > 1 && <small>{ROOM_NIGHT_LABELS[st]}{seg.agentName ? ` · ${seg.agentName}` : ''}</small>}
                  </button>
                </td>,
              );
              i += n;
            }
            return (
              <tr key={room.id}>
                <th scope="row">
                  <span className="rd-room">{room.number}</span>
                  <span className="rd-type">{room.roomTypeCode}{room.floor ? ` · fl ${room.floor}` : ''}</span>
                  {needsHousekeeping(room.hkStatus) && <HkBadge status={room.hkStatus} />}
                </th>
                {cells}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RoomNightTable({
  rooms, dates, segments, matches, creditWarn, onPick,
}: {
  rooms: Room[];
  dates: string[];
  segments: Segment[];
  matches: (room: Room, date: string) => boolean;
  creditWarn: (stayId: string | null) => CreditRow | undefined;
  onPick: (room: Room, date: string) => void;
}) {
  const rows = rooms.flatMap((r) => dates.filter((d) => matches(r, d)).map((d) => ({ room: r, date: d, seg: segmentOn(segments, r.id, d) })));
  const LIMIT = 2000;
  return (
    <div className="rd-scroll">
      <table className="ys-table compact rd-table">
        <thead>
          <tr><th>Date</th><th>Room</th><th>Type</th><th>Floor</th><th>Status</th><th>Guest / reason</th><th>Stay</th><th>Housekeeping now</th></tr>
        </thead>
        <tbody>
          {rows.slice(0, LIMIT).map(({ room, date, seg }) => {
            const st = seg ? segmentState(seg) : 'available';
            return (
              <tr key={`${room.id}-${date}`} className="ys-click" onClick={() => onPick(room, date)}>
                <td>{weekday(date)} {date}</td>
                <td><strong>{room.number}</strong></td>
                <td>{room.roomTypeName}</td>
                <td>{room.floor ?? '—'}</td>
                <td><span className={`rd-badge rd-${st}`}>{ROOM_NIGHT_LABELS[st]}</span></td>
                <td>{creditWarn(seg?.stayId ?? null) ? '⚠ ' : ''}{seg?.kind === 'block' ? seg.blockReason : seg?.guestName ?? '—'}</td>
                <td>{seg?.stayNumber ?? '—'}</td>
                <td><HkBadge status={room.hkStatus} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > LIMIT && <p className="ys-muted rd-empty">Showing the first {LIMIT} of {rows.length} room-nights. Narrow the period or filters, or export to CSV for all of them.</p>}
    </div>
  );
}

function RoomCards({
  rooms, date, segments, creditWarn, onPick,
}: {
  rooms: Room[];
  date: string;
  segments: Segment[];
  creditWarn: (stayId: string | null) => CreditRow | undefined;
  onPick: (room: Room) => void;
}) {
  return (
    <div className="rd-cards">
      {rooms.map((room) => {
        const seg = segmentOn(segments, room.id, date);
        const st = nightState(segments, room.id, date);
        const warn = creditWarn(seg?.stayId ?? null);
        return (
          <button key={room.id} className={`rd-card rd-${st}`} onClick={() => onPick(room)}>
            <span className="rd-card-head"><b>{room.number}</b><span className={`rd-badge rd-${st}`}>{ROOM_NIGHT_LABELS[st]}</span></span>
            <span className="rd-type">{room.roomTypeName}{room.floor ? ` · floor ${room.floor}` : ''}</span>
            <span className="rd-card-guest">
              {seg?.kind === 'block' ? seg.blockReason : seg?.guestName ?? 'No guest'}
              {seg?.kind === 'stay' && <small>{seg.from} → {seg.to}{seg.arrival === date ? ' · arrives' : ''}{seg.to === addDays(date, 1) ? ' · leaves tomorrow' : ''}</small>}
            </span>
            <span className="rd-card-foot">
              <HkBadge status={room.hkStatus} />
              {warn && <span className="rd-warn">⚠ {warn.status === 'exhausted' ? 'Credit used up' : 'Credit ends tomorrow'}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RoomNightPanel({
  room, date, segment, credit, businessDate, canBook, onClose, onChanged, go,
}: {
  room: Room;
  date: string;
  segment: Segment | undefined;
  credit: CreditRow | undefined;
  businessDate: string;
  canBook: boolean;
  onClose: () => void;
  onChanged: () => void;
  go: (page: string, params?: Record<string, string>) => void;
}) {
  const { property, me } = useSession();
  const st: RoomNightState = segment ? segmentState(segment) : 'available';
  const [moving, setMoving] = useState(false);
  const [blockTo, setBlockTo] = useState(addDays(date, 1));
  const [blockReason, setBlockReason] = useState('');
  const action = useAction();
  const canStatus = hasPermission(me.roles, 'room.status');
  const canBlock = hasPermission(me.roles, 'room.block');
  const canMove = hasPermission(me.roles, 'frontdesk.operate');
  const m = credit ? creditMessage(credit) : null;

  if (moving && segment?.stayId) {
    return (
      <MoveModal
        stay={{
          id: segment.stayId,
          number: segment.stayNumber ?? '',
          reservationId: segment.reservationId ?? '',
          roomTypeCode: room.roomTypeCode,
          roomNumber: room.number,
          arrivalDate: segment.arrival ?? segment.from,
          departureDate: segment.departure ?? segment.to,
          guestName: segment.guestName ?? undefined,
        }}
        onClose={() => setMoving(false)}
        onDone={onChanged}
      />
    );
  }

  return (
    <Modal title={`Room ${room.number} · ${weekday(date)} ${date}`} onClose={onClose}>
      <div className="ys-form">
        <p>
          <span className={`rd-badge rd-${st}`}>{ROOM_NIGHT_LABELS[st]}</span> {room.roomTypeName}{room.floor ? ` · floor ${room.floor}` : ''}
        </p>
        {segment?.kind === 'stay' && (
          <div className="ys-card">
            <p><strong>{segment.guestName}</strong> · stay {segment.stayNumber} · booking {segment.reservationNumber}</p>
            <p className="ys-muted">
              {segment.arrival} to {segment.departure} · {segment.adults} adult(s){segment.children ? `, ${segment.children} child(ren)` : ''}
              {segment.agentName ? ` · via ${segment.agentName}` : ''}
              {segment.autoPostRoomCharges === false ? ' · nightly posting switched off' : ''}
            </p>
            {m && <p className={`ys-tone-${m.tone}`}>{m.text}</p>}
            <div className="ys-actions">
              <button className="ys-btn" onClick={() => go('reservation', { id: segment.reservationId! })}>Open booking</button>
              {segment.status === 'checked_in' && canMove && date >= businessDate && (
                <button className="ys-btn ghost" onClick={() => setMoving(true)}>Move to another room</button>
              )}
            </div>
          </div>
        )}
        {segment?.kind === 'block' && (
          <div className="ys-card">
            <p>Blocked {segment.from} to {segment.to} (room free again on {segment.to}): {segment.blockReason}</p>
            {canBlock && (
              <button
                className="ys-btn ghost"
                disabled={action.busy}
                onClick={async () => {
                  const ok = await action.run(() => api.post(`${base(property.code)}/blocks/${segment.allocationId}/release`, {}));
                  if (ok) onChanged();
                }}
              >
                Release the block
              </button>
            )}
          </div>
        )}
        {!segment && (
          <div className="ys-card">
            <p>Free on the night of {date}.</p>
            <div className="ys-actions">
              {canBook && date >= businessDate && (
                <button className="ys-btn" onClick={() => go('new-reservation', { arrival: date, roomTypeCode: room.roomTypeCode, roomId: room.id })}>
                  Book room {room.number} from {date}
                </button>
              )}
            </div>
            {canBlock && date >= businessDate && (
              <form
                className="ys-row"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const ok = await action.run(({ key }) => api.post(`${base(property.code)}/rooms/${room.id}/blocks`, { from: date, to: blockTo, reason: blockReason }, key));
                  if (ok) onChanged();
                }}
              >
                <Field label="Block until (room free again on)">
                  <input type="date" required min={addDays(date, 1)} value={blockTo} onChange={(e) => setBlockTo(e.target.value)} />
                </Field>
                <Field label="Reason" required>
                  <input required minLength={3} value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="e.g. Plumbing repair" />
                </Field>
                <button className="ys-btn ghost" disabled={action.busy}>Block room</button>
              </form>
            )}
          </div>
        )}
        <div className="ys-card">
          <p>Housekeeping now: <HkBadge status={room.hkStatus} />{room.hkUpdatedAt ? <span className="ys-muted"> · updated {new Date(room.hkUpdatedAt).toLocaleString()}</span> : null}</p>
          {canStatus && (
            <div className="ys-segmented" role="group" aria-label="Set housekeeping status">
              {HK_STATUSES.map((h) => (
                <button
                  key={h}
                  aria-pressed={room.hkStatus === h}
                  disabled={action.busy || room.hkStatus === h}
                  onClick={async () => {
                    const ok = await action.run(() => api.patch(`${base(property.code)}/rooms/${room.id}/hk-status`, { hkStatus: h }));
                    if (ok) onChanged();
                  }}
                >
                  {HK_LABEL[h]}
                </button>
              ))}
            </div>
          )}
        </div>
        <ErrorText error={action.error} />
      </div>
    </Modal>
  );
}
