import { useState } from 'react';
import { addDays, hasPermission } from '@hotel/shared';
import { api, ApiError } from '../api';
import { base, ErrorText, saveDownload, useLoad, useSession } from '../ui';

/**
 * Reports (RPT-06): one card per focused report, grouped by area. Each card
 * has its own dates (and outlet, where it applies) and downloads an Excel
 * workbook, or a PDF. The last downloads are listed underneath, from the
 * audit log, so the same file can be fetched again.
 */

type DateMode = 'range' | 'day' | 'none';
interface Entry {
  name: string;
  title: string;
  blurb: string;
  area: 'hotel' | 'pos' | 'money' | 'group';
  dates: DateMode;
  outlet?: boolean;
  pack?: boolean;
}
interface Recent {
  at: string;
  report: string;
  format: 'xlsx' | 'pdf' | 'csv';
  file: string;
  filters: Record<string, string | null>;
}
interface Outlet {
  code: string;
  name: string;
}

const AREAS: Array<[Entry['area'], string, string]> = [
  ['hotel', 'Rooms and front office', 'Occupancy, room revenue, ADR and RevPAR, by day and by segment, and the daily flash.'],
  ['pos', 'Restaurants and bars', 'Sales by outlet, product and waiter, discounts, voids, refunds and cash shifts.'],
  ['money', 'Money and guest ledger', 'Money taken, what guests owe and deposits held.'],
  ['group', 'Group', 'All properties together, with a group total.'],
];

/** The group flash lives on the group route, not under a property. */
const GROUP_FLASH: Entry = {
  name: 'group-flash',
  title: 'Daily flash, all properties',
  blurb: 'Each property side by side for one business day, with a group total column.',
  area: 'group',
  dates: 'day',
};

const FORMAT_LABEL = { xlsx: 'Excel', pdf: 'PDF', csv: 'CSV' } as const;

function exportPath(code: string, e: Entry, q: { from: string; to: string; outlet: string }, format: 'xlsx' | 'pdf' | 'csv'): string {
  if (e.name === GROUP_FLASH.name) return `/reports/flash/export?date=${q.to}&format=${format}`;
  const params = new URLSearchParams({ format });
  if (e.dates === 'range') params.set('from', q.from);
  if (e.dates !== 'none') params.set('to', q.to);
  if (e.dates === 'day') params.set('from', q.to);
  if (e.outlet && q.outlet) params.set('outlet', q.outlet);
  return `${base(code)}/reports/catalog/${e.name}/export?${params.toString()}`;
}

export function ReportsPage() {
  const { me, property } = useSession();
  const catalog = useLoad(() => api.get<Entry[]>(`${base(property.code)}/reports/catalog`), [property.code]);
  const recent = useLoad(() => api.get<Recent[]>(`${base(property.code)}/reports/recent`), [property.code]);
  const canPos = hasPermission(me.roles, 'pos.report');
  const outlets = useLoad(() => (canPos ? api.get<Outlet[]>(`${base(property.code)}/pos/outlets`) : Promise.resolve([])), [property.code, canPos]);
  const entries = [...(catalog.data ?? []), ...(me.allProperties && catalog.data ? [GROUP_FLASH] : [])];
  const byName = new Map(entries.map((e) => [e.name, e]));
  const lastClosed = addDays(property.currentBusinessDate, -1);
  const monthStart = `${lastClosed.slice(0, 8)}01`;

  return (
    <>
      <div className="ys-page-head">
        <h1>Reports · {property.name}</h1>
      </div>
      <p className="ys-muted">
        Pick the dates on a report and download it as Excel, or as a PDF to print or send. Business dates run 08:00 to 08:00; a day still open is provisional.
      </p>
      <ErrorText error={catalog.error} />
      {AREAS.map(([area, title, blurb]) => {
        const cards = entries.filter((e) => e.area === area).sort((a, b) => Number(!!a.pack) - Number(!!b.pack));
        if (!cards.length) return null;
        return (
          <section key={area} className="ys-section" aria-labelledby={`area-${area}`}>
            <h2 id={`area-${area}`}>{title}</h2>
            <p className="ys-muted ys-area-blurb">{blurb}</p>
            <div className="ys-report-cards">
              {cards.map((e) => (
                <ReportCard
                  key={e.name}
                  entry={e}
                  code={property.code}
                  defaultFrom={monthStart}
                  defaultTo={lastClosed}
                  businessDate={property.currentBusinessDate}
                  outlets={outlets.data ?? []}
                  onDone={recent.reload}
                />
              ))}
            </div>
          </section>
        );
      })}
      <section className="ys-card ys-section" aria-labelledby="recent-downloads">
        <h2 id="recent-downloads">Your recent downloads</h2>
        <ErrorText error={recent.error} />
        <table className="ys-table compact">
          <tbody>
            {(recent.data ?? []).map((r, i) => (
              <RecentRow key={`${r.at}-${i}`} r={r} entry={byName.get(r.report === 'flash' && r.file.startsWith('GROUP-') ? GROUP_FLASH.name : r.report)} code={property.code} />
            ))}
            {recent.data && !recent.data.length && (
              <tr>
                <td className="ys-muted">Nothing downloaded yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}

function ReportCard(props: {
  entry: Entry;
  code: string;
  defaultFrom: string;
  defaultTo: string;
  businessDate: string;
  outlets: Outlet[];
  onDone: () => void;
}) {
  const { entry: e } = props;
  const [from, setFrom] = useState(props.defaultFrom);
  const [to, setTo] = useState(props.defaultTo);
  const [outlet, setOutlet] = useState('');
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = e.dates === 'none' || (e.dates === 'day' ? !!to : !!from && !!to && from <= to);

  async function run(format: 'xlsx' | 'pdf') {
    setBusy(format);
    setError(null);
    try {
      await saveDownload(exportPath(props.code, e, { from, to, outlet }, format));
      props.onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Download failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className={`ys-report-card${e.pack ? ' pack' : ''}`} aria-labelledby={`rc-${e.name}`}>
      <h3 id={`rc-${e.name}`}>{e.title}</h3>
      <p>{e.blurb}</p>
      <div className="ys-report-filters">
        {e.dates === 'range' && (
          <span className="ys-range">
            <input type="date" aria-label={`${e.title} from`} value={from} max={to || undefined} onChange={(x) => setFrom(x.target.value)} />
            <span aria-hidden="true">to</span>
            <input type="date" aria-label={`${e.title} to`} value={to} min={from || undefined} onChange={(x) => setTo(x.target.value)} />
          </span>
        )}
        {e.dates === 'day' && (
          <span className="ys-range">
            <input type="date" aria-label={`${e.title} business date`} value={to} onChange={(x) => setTo(x.target.value)} />
          </span>
        )}
        {e.dates === 'none' && <span className="ys-muted">As at now (business date {props.businessDate})</span>}
        {e.outlet && props.outlets.length > 0 && (
          <select aria-label={`${e.title} outlet`} value={outlet} onChange={(x) => setOutlet(x.target.value)}>
            <option value="">All outlets</option>
            {props.outlets.map((o) => (
              <option key={o.code} value={o.code}>{o.name}</option>
            ))}
          </select>
        )}
      </div>
      <div className="ys-report-actions">
        <button type="button" className="ys-btn" disabled={!valid || busy !== null} onClick={() => run('xlsx')}>
          {busy === 'xlsx' ? 'Preparing…' : 'Download Excel'}
        </button>
        <button type="button" className="ys-link" disabled={!valid || busy !== null} onClick={() => run('pdf')}>
          {busy === 'pdf' ? 'Preparing…' : 'Also PDF'}
        </button>
      </div>
      {error && <p className="ys-error" role="alert">{error}</p>}
    </article>
  );
}

function RecentRow({ r, entry, code }: { r: Recent; entry?: Entry; code: string }) {
  const [error, setError] = useState<string | null>(null);
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(r.at));
  const f = r.filters ?? {};
  const again = () =>
    entry &&
    saveDownload(
      exportPath(code, entry, { from: f.from ?? f.date ?? '', to: f.to ?? f.date ?? f.asAt ?? '', outlet: f.outlet ?? '' }, r.format),
    ).catch((e: Error) => setError(e.message));
  return (
    <tr>
      <td>{r.file}</td>
      <td className="ys-nowrap ys-muted">{FORMAT_LABEL[r.format] ?? r.format}</td>
      <td className="ys-nowrap ys-muted">{when}</td>
      <td className="ys-actions-cell">
        {entry && entry.dates !== 'none' && (
          <button type="button" className="ys-link" onClick={again}>Download again</button>
        )}
        {error && <span className="ys-error" role="alert">{error}</span>}
      </td>
    </tr>
  );
}
