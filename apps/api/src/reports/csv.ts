import { Cell, Column, Report } from './report';

/**
 * CSV for Excel (RPT-06). A UTF-8 byte-order mark makes Excel read accents and
 * the KES amounts correctly; amounts are plain decimals ("1234.50") with no
 * currency or thousands separators, so they stay numbers Excel can add up.
 * Text that Excel would run as a formula (=, +, -, @) is prefixed with a quote
 * (CSV injection); numeric columns are left alone so negative amounts work.
 */

const NUMERIC = new Set(['money', 'number', 'percent']);

function kindOf(col: Column, row: Record<string, Cell>): string {
  return (col.kind === 'auto' ? (typeof row._kind === 'string' ? row._kind : 'text') : col.kind) ?? 'text';
}

export function csvCell(value: Cell, kind = 'text'): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (!NUMERIC.has(kind) || !/^-?\d+(\.\d+)?$/.test(s)) {
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function line(cells: string[]): string {
  return `${cells.join(',')}\r\n`;
}

export function toCsv(report: Report): string {
  let out = '﻿';
  out += line([csvCell(report.title)]);
  out += line([csvCell(report.scope)]);
  out += line([csvCell(report.period)]);
  for (const f of report.filters ?? []) out += line([csvCell(f)]);
  out += line([csvCell(`Generated ${report.generatedAt}${report.generatedBy ? ` by ${report.generatedBy}` : ''}`)]);
  for (const s of report.sections) {
    out += '\r\n';
    out += line([csvCell(s.title)]);
    out += line(s.columns.map((c) => csvCell(c.label)));
    for (const row of s.rows) out += line(s.columns.map((c) => csvCell(row[c.key], kindOf(c, row))));
    if (s.totals) out += line(s.columns.map((c) => csvCell(s.totals![c.key], kindOf(c, s.totals!))));
    if (s.note) out += line([csvCell(s.note)]);
  }
  if (report.notes?.length) {
    out += '\r\n';
    for (const n of report.notes) out += line([csvCell(n)]);
  }
  return out;
}
