import { useState } from 'react';
import { addDays } from '@hotel/shared';
import { api } from '../api';
import { base, DownloadButtons, ErrorText, Field, kes, label, useLoad, useSession } from '../ui';

/**
 * Hotel report (RPT-02) and daily flash report (RPT-07, RPT-08), on screen and
 * as Excel or PDF downloads (RPT-06). Figures come from the API, which applies
 * the permission and property scope.
 */

const pct = (v: string | null | undefined) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`);

interface Day {
  date: string;
  closed: boolean;
  availableRooms: number;
  blockedRooms: number;
  occupiedRooms: number;
  compRooms: number;
  roomsSold: number;
  roomRevenue: string;
  occupancy: string;
  adr: string;
  revpar: string;
  arrivals: number;
  departures: number;
  cancellations: number;
  noShows: number;
}

interface Segment {
  occupiedRooms: number;
  compRooms: number;
  roomsSold: number;
  roomRevenue: string;
  adr: string;
}

interface Lost {
  stayNumber: string;
  bookingNumber: string;
  guest: string;
  source: string;
  roomType: string;
  arrival: string;
  nights: number;
  bookedValue: string;
  feeCharged: string;
  reason: string | null;
  at: string;
}

interface HotelReport {
  days: Day[];
  totals: Omit<Day, 'date' | 'closed'> & { closedDays: number };
  byRoomType: Array<Segment & { code: string; name: string }>;
  bySource: Array<Segment & { source: string }>;
  cancellations: Lost[];
  noShows: Lost[];
  definitions: string[];
}

function LostTable({ rows, when }: { rows: Lost[]; when: string }) {
  return (
    <table className="ys-table compact">
      <thead><tr><th>Stay</th><th>Guest</th><th>Source</th><th>Room type</th><th>Arrival</th><th>Nights</th><th>Booked value</th><th>Fee charged</th><th>Reason</th><th>{when}</th></tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={10} className="ys-muted">None in this period.</td></tr>}
        {rows.map((r) => (
          <tr key={r.stayNumber}>
            <td>{r.stayNumber}</td><td>{r.guest}</td><td>{label(r.source)}</td><td>{r.roomType}</td><td>{r.arrival}</td><td>{r.nights}</td>
            <td>{kes(r.bookedValue)}</td><td>{kes(r.feeCharged)}</td><td>{r.reason ?? '—'}</td><td className="ys-nowrap">{r.at}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SegmentTable({ title, rows }: { title: string; rows: Array<Segment & { key: string; name: string }> }) {
  return (
    <div>
      <h2>{title}</h2>
      <table className="ys-table compact">
        <thead><tr><th>{title.replace(/^By /, '').replace(/^\w/, (c) => c.toUpperCase())}</th><th>Occupied</th><th>Comp</th><th>Sold</th><th>Room revenue</th><th>ADR</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={6} className="ys-muted">No room nights posted.</td></tr>}
          {rows.map((r) => <tr key={r.key}><td>{r.name}</td><td>{r.occupiedRooms}</td><td>{r.compRooms}</td><td>{r.roomsSold}</td><td>{kes(r.roomRevenue)}</td><td>{kes(r.adr)}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

export function HotelReportPage() {
  const { property, go } = useSession();
  const lastClosed = addDays(property.currentBusinessDate, -1);
  const [from, setFrom] = useState(addDays(lastClosed, -6));
  const [to, setTo] = useState(lastClosed);
  const valid = !!from && !!to && from <= to;
  const filter = `from=${from}&to=${to}`;
  const { data, error } = useLoad(
    () => (valid ? api.get<HotelReport>(`${base(property.code)}/reports/hotel?${filter}`) : Promise.resolve(null)),
    [property.code, filter],
  );
  const t = data?.totals;
  return (
    <>
      <div className="ys-page-head">
        <h1>Room sales · {property.name}</h1>
        <span className="spacer" />
        <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <DownloadButtons path={`${base(property.code)}/reports/hotel/export?${filter}`} disabled={!valid} />
      </div>
      <p className="ys-muted">
        Room sales, occupancy, ADR, RevPAR, cancellations and no-shows by business date (RPT-02). Room nights count once the day is closed. The download holds every
        table below; to get one table on its own, use <button type="button" className="ys-link" onClick={() => go('reports')}>Reports</button>.
      </p>
      <ErrorText error={error} />
      {data && t && (
        <>
          <div className="ys-tiles small">
            <div className="ys-tile"><strong>{pct(t.occupancy)}</strong><span>Occupancy</span></div>
            <div className="ys-tile"><strong>{kes(t.adr)}</strong><span>ADR</span></div>
            <div className="ys-tile"><strong>{kes(t.revpar)}</strong><span>RevPAR</span></div>
            <div className="ys-tile"><strong>{kes(t.roomRevenue)}</strong><span>Room revenue (net of tax)</span></div>
            <div className="ys-tile"><strong>{t.roomsSold}</strong><span>Rooms sold{t.compRooms ? ` (+${t.compRooms} comp)` : ''}</span></div>
            <div className="ys-tile"><strong>{t.cancellations} / {t.noShows}</strong><span>Cancellations / no-shows</span></div>
          </div>
          <h2>Daily room sales</h2>
          <table className="ys-table compact">
            <thead>
              <tr><th>Date</th><th>Available</th><th>Occupied</th><th>Comp</th><th>Occupancy</th><th>Room revenue</th><th>ADR</th><th>RevPAR</th><th>Arrivals</th><th>Departures</th><th>Cancelled</th><th>No-shows</th><th>Day</th></tr>
            </thead>
            <tbody>
              {data.days.map((d) => (
                <tr key={d.date} className={d.closed ? '' : 'ys-muted'}>
                  <td className="ys-nowrap">{d.date}</td><td>{d.availableRooms}{d.blockedRooms ? ` (${d.blockedRooms} blocked)` : ''}</td><td>{d.occupiedRooms}</td><td>{d.compRooms}</td>
                  <td>{pct(d.occupancy)}</td><td>{kes(d.roomRevenue)}</td><td>{kes(d.adr)}</td><td>{kes(d.revpar)}</td>
                  <td>{d.arrivals}</td><td>{d.departures}</td><td>{d.cancellations}</td><td>{d.noShows}</td><td>{d.closed ? 'Closed' : 'Open'}</td>
                </tr>
              ))}
              <tr>
                <td><strong>Closed days ({t.closedDays})</strong></td><td>{t.availableRooms}</td><td>{t.occupiedRooms}</td><td>{t.compRooms}</td>
                <td><strong>{pct(t.occupancy)}</strong></td><td><strong>{kes(t.roomRevenue)}</strong></td><td><strong>{kes(t.adr)}</strong></td><td><strong>{kes(t.revpar)}</strong></td>
                <td>{t.arrivals}</td><td>{t.departures}</td><td>{t.cancellations}</td><td>{t.noShows}</td><td />
              </tr>
            </tbody>
          </table>
          <div>
            <SegmentTable title="By room type" rows={data.byRoomType.map((r) => ({ ...r, key: r.code }))} />
            <SegmentTable title="By booking source" rows={data.bySource.map((r) => ({ ...r, key: r.source, name: label(r.source) }))} />
          </div>
          <h2>Cancellations</h2>
          <LostTable rows={data.cancellations} when="Cancelled" />
          <h2>No-shows</h2>
          <LostTable rows={data.noShows} when="Marked" />
          <ul className="ys-muted">{data.definitions.map((d) => <li key={d}>{d}</li>)}</ul>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Daily flash (RPT-07) and the group view (RPT-08)
// ---------------------------------------------------------------------------

interface Flash {
  code: string;
  name: string;
  dayClosed: boolean;
  rooms: Day;
  revenue: { rooms: string; posNetSales: string; posNetExTax: string; otherFolio: string; total: string };
  cash: { byTender: Array<{ tender: string; frontDesk: string; pos: string; refunds: string; total: string }>; total: string };
  cashiers: { shifts: number; openShifts: number; variance: string; unreviewed: number };
  exceptions: {
    openChecks: number; outletDaysOpen: number; voidedChecks: number; refunds: string; houseAccounts: string; posDifference: string;
    arrivalsNotCheckedIn: number; overdueDepartures: number; inHouseBalance: string; sapFailed: number;
  };
}

type Group = Record<string, string | number | boolean>;

const MEASURES: Array<[string, (f: Flash) => string | number, string | null, 'money' | 'number' | 'percent', ((f: Flash) => boolean)?]> = [
  ['Occupancy', (f) => f.rooms.occupancy, 'occupancy', 'percent'],
  ['Rooms occupied / available', (f) => `${f.rooms.occupiedRooms} / ${f.rooms.availableRooms}`, null, 'number'],
  ['ADR', (f) => f.rooms.adr, 'adr', 'money'],
  ['RevPAR', (f) => f.rooms.revpar, 'revpar', 'money'],
  ['Arrivals / departures', (f) => `${f.rooms.arrivals} / ${f.rooms.departures}`, null, 'number'],
  ['Cancellations / no-shows', (f) => `${f.rooms.cancellations} / ${f.rooms.noShows}`, null, 'number'],
  ['Room revenue (net)', (f) => f.revenue.rooms, 'roomRevenue', 'money'],
  ['F&B sales (POS, incl. tax)', (f) => f.revenue.posNetSales, 'posNetSales', 'money'],
  ['Other folio revenue (net)', (f) => f.revenue.otherFolio, 'otherFolio', 'money'],
  ['Total revenue (net of tax)', (f) => f.revenue.total, 'totalRevenue', 'money'],
  ['Money received', (f) => f.cash.total, 'cash', 'money'],
  ['Cashier variance', (f) => f.cashiers.variance, 'cashierVariance', 'money', (f) => Number(f.cashiers.variance) !== 0],
  ['Variances not reviewed', (f) => f.cashiers.unreviewed, null, 'number', (f) => f.cashiers.unreviewed > 0],
  ['Open checks', (f) => f.exceptions.openChecks, null, 'number', (f) => f.exceptions.openChecks > 0],
  ['Outlet days not closed', (f) => f.exceptions.outletDaysOpen, null, 'number', (f) => f.exceptions.outletDaysOpen > 0],
  ['Voided checks', (f) => f.exceptions.voidedChecks, null, 'number'],
  ['POS refunds', (f) => f.exceptions.refunds, null, 'money'],
  ['House accounts', (f) => f.exceptions.houseAccounts, null, 'money'],
  ['POS sales not settled', (f) => f.exceptions.posDifference, null, 'money', (f) => Number(f.exceptions.posDifference) !== 0],
  ['Arrivals not checked in (now)', (f) => f.exceptions.arrivalsNotCheckedIn, null, 'number', (f) => f.exceptions.arrivalsNotCheckedIn > 0],
  ['Overdue departures (now)', (f) => f.exceptions.overdueDepartures, null, 'number', (f) => f.exceptions.overdueDepartures > 0],
  ['In-house balances (now)', (f) => f.exceptions.inHouseBalance, null, 'money'],
  ['SAP postings failed', (f) => f.exceptions.sapFailed, null, 'number', (f) => f.exceptions.sapFailed > 0],
];

function show(v: string | number | boolean | undefined, kind: string): string {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'string' && v.includes('/')) return v;
  if (kind === 'money') return kes(String(v));
  if (kind === 'percent') return pct(String(v));
  return String(v);
}

export function FlashReportPage() {
  const { property, me } = useSession();
  const [date, setDate] = useState(addDays(property.currentBusinessDate, -1));
  const [group, setGroup] = useState(me.allProperties);
  const { data, error } = useLoad(
    () =>
      group
        ? api.get<{ properties: Flash[]; group: Group }>(`/reports/flash?date=${date}`)
        : api.get<Flash>(`${base(property.code)}/reports/flash?date=${date}`).then((f) => ({ properties: [f], group: null as Group | null })),
    [property.code, date, group],
  );
  const ps = data?.properties ?? [];
  const showGroup = group && ps.length > 1 && data?.group;
  const exportPath = group ? `/reports/flash/export?date=${date}` : `${base(property.code)}/reports/flash/export?date=${date}`;
  return (
    <>
      <div className="ys-page-head">
        <h1>Daily flash · {group ? 'all properties' : property.name}</h1>
        <span className="spacer" />
        {me.allProperties && (
          <div className="ys-segmented">
            <button aria-pressed={!group} onClick={() => setGroup(false)}>{property.name}</button>
            <button aria-pressed={group} onClick={() => setGroup(true)}>All properties</button>
          </div>
        )}
        <Field label="Business date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <DownloadButtons path={exportPath} disabled={!date} />
      </div>
      <p className="ys-muted">
        The day’s rooms, F&amp;B, money received, cashier variances and exceptions (RPT-07){group ? ', side by side with a group total (RPT-08)' : ''}. A day that is not closed yet is provisional.
      </p>
      <ErrorText error={error} />
      {ps.length > 0 && (
        <>
          <table className="ys-table compact">
            <thead>
              <tr>
                <th>Measure</th>
                {ps.map((p) => <th key={p.code}>{p.name}{p.dayClosed ? '' : ' (provisional)'}</th>)}
                {showGroup && <th>Group</th>}
              </tr>
            </thead>
            <tbody>
              {MEASURES.map(([name, f, g, kind, warn]) => (
                <tr key={name}>
                  <td>{name}</td>
                  {ps.map((p) => <td key={p.code} className={warn?.(p) ? 'ys-warn-text' : ''}>{show(f(p), kind)}</td>)}
                  {showGroup && <td><strong>{g ? show(data!.group![g], kind) : ''}</strong></td>}
                </tr>
              ))}
            </tbody>
          </table>
          <h2>Money received by method</h2>
          <table className="ys-table compact">
            <thead><tr><th>Property</th><th>Method</th><th>Front desk</th><th>POS</th><th>POS refunds</th><th>Total</th></tr></thead>
            <tbody>
              {ps.map((p) => [
                ...p.cash.byTender.map((t) => (
                  <tr key={`${p.code}-${t.tender}`}><td>{p.name}</td><td>{label(t.tender)}</td><td>{kes(t.frontDesk)}</td><td>{kes(t.pos)}</td><td>{kes(t.refunds)}</td><td>{kes(t.total)}</td></tr>
                )),
                <tr key={`${p.code}-total`}><td><strong>{p.name}</strong></td><td><strong>Total</strong></td><td /><td /><td /><td><strong>{kes(p.cash.total)}</strong></td></tr>,
              ])}
            </tbody>
          </table>
          <p className="ys-muted">Emailing or sending the flash by WhatsApp after each day close is not set up yet; download it here for now.</p>
        </>
      )}
    </>
  );
}
