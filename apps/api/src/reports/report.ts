/**
 * A report as plain tables, so the same content can be shown on screen, saved
 * as CSV for Excel, or laid out as a PDF (RPT-06). Every value is already a
 * string or a number: amounts stay decimal strings ("1234.50") so nothing is
 * rounded through floating point on the way out (§9).
 */

export type Cell = string | number | null | undefined;

/** 'auto' takes the kind from the row's `_kind` field, for tables that mix amounts, counts and rates. */
export type ColumnKind = 'text' | 'money' | 'number' | 'percent' | 'date' | 'auto';

export interface Column {
  key: string;
  label: string;
  kind?: ColumnKind;
}

export interface Section {
  title: string;
  columns: Column[];
  rows: Array<Record<string, Cell>>;
  /** Optional total line, keyed like the rows. */
  totals?: Record<string, Cell>;
  /** Shown under the table, e.g. how a metric is defined. */
  note?: string;
}

export interface Report {
  /** Short name for the file, e.g. "pos-sales". */
  key: string;
  title: string;
  /** Property name, or "All properties" for a group report. */
  scope: string;
  /** Period or date the report covers, as shown under the title. */
  period: string;
  /** Short filter description, e.g. "Outlet: Pool Bar". */
  filters?: string[];
  generatedBy: string | null;
  generatedAt: string;
  sections: Section[];
  /** Lines printed at the end: definitions, caveats. */
  notes?: string[];
  /** Lay the PDF out sideways when the widest table needs it. */
  landscape?: boolean;
}

export type ExportFormat = 'csv' | 'pdf';

/** A label/value table, for summaries. */
export function keyValueSection(title: string, rows: Array<[string, Cell, ColumnKind?]>, note?: string): Section {
  return {
    title,
    columns: [
      { key: 'item', label: 'Item' },
      { key: 'value', label: 'Value', kind: 'auto' },
    ],
    rows: rows.map(([item, value, kind]) => ({ item, value, _kind: kind ?? 'money' })),
    note,
  };
}

/** Safe file name: property code, report key and period, e.g. K1-pos-sales-2026-11-01_2026-11-03.csv */
export function fileName(report: Report, prefix: string, format: ExportFormat): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${clean(prefix)}-${clean(report.key)}-${clean(report.period.replace(/ to /, '_'))}.${format}`;
}
