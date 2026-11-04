import ExcelJS from 'exceljs';
import { LOGO_PNG_BASE64 } from './logo';
import { Cell, Column, Report } from './report';

/**
 * Excel workbook for a report (RPT-06): the property and report title, the
 * period and filters, the YeaStay logo, then each table with a coloured header
 * row, number formats Excel can add up, a frozen header when there is one
 * table, and the definitions underneath. Laid out to print on A4 landscape.
 */

const TEAL = 'FF0E4D52';
const NIGHT = 'FF0B2E31';
const AMBER = 'FFE8A33D';
const MUTED = 'FF5B6B6D';
const TOTAL = 'FFE4ECEC';
const thin = { style: 'thin' as const, color: { argb: 'FFC9D3D4' } };
const border = { top: thin, left: thin, bottom: thin, right: thin };

const FORMATS: Record<string, string> = { money: '#,##0.00', number: '#,##0.###', percent: '0.0%', date: 'yyyy-mm-dd' };

function kindOf(col: Column, row: Record<string, Cell>): string {
  return (col.kind === 'auto' ? (typeof row._kind === 'string' ? row._kind : 'text') : col.kind) ?? 'text';
}

function value(v: Cell, kind: string): ExcelJS.CellValue {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  const numeric = /^-?\d+(\.\d+)?$/.test(s);
  if (kind === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : s;
  }
  if (kind === 'percent' && numeric) return Number(s) / 100; // our percentages are 0–100
  if ((kind === 'money' || kind === 'number') && numeric) return Number(s);
  return s;
}

function width(text: string): number {
  return Math.min(Math.max(text.length + 2, 8), 48);
}

export async function toXlsx(report: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'YeaStay';
  wb.created = new Date();
  const ws = wb.addWorksheet(report.title.replace(/[*?:\\/[\]]/g, '-').slice(0, 31), {
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
    headerFooter: { oddFooter: `&L${report.scope} · ${report.title}&RPage &P of &N · YeaStay` },
    views: [{ showGridLines: false }],
  });

  // Column widths: the widest label or value in each column position.
  const ncols = Math.max(2, ...report.sections.map((s) => s.columns.length));
  const widths = Array.from({ length: ncols }, () => 10);
  for (const s of report.sections) {
    s.columns.forEach((c, i) => {
      widths[i] = Math.max(widths[i], width(c.label) + 2); // bold header text runs wider
      for (const r of [...s.rows, ...(s.totals ? [s.totals] : [])]) widths[i] = Math.max(widths[i], width(String(r[c.key] ?? '')));
    });
  }
  widths[0] = Math.max(widths[0], 18);
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  ws.getCell('A1').value = report.scope;
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: NIGHT } };
  ws.getRow(1).height = 24;
  ws.getCell('A2').value = report.title;
  ws.getCell('A2').font = { bold: true, size: 13, color: { argb: TEAL } };
  ws.getCell('A3').value = report.period;
  ws.getCell('A3').font = { size: 11, color: { argb: NIGHT } };
  ws.getCell('A4').value = `YeaStay  |  Generated ${report.generatedAt}${report.generatedBy ? ` by ${report.generatedBy}` : ''}`;
  ws.getCell('A4').font = { size: 9, color: { argb: MUTED } };

  // Logo in the top-right corner (about 136 x 48 px).
  let startCol = ncols;
  for (let px = 0; startCol > 1 && px < 140; ) px += widths[--startCol] * 7;
  const logo = wb.addImage({ base64: `data:image/png;base64,${LOGO_PNG_BASE64}`, extension: 'png' });
  ws.addImage(logo, { tl: { col: Math.max(startCol, 1), row: 0 }, ext: { width: 136, height: 48 } });

  let row = 6;
  if (report.filters?.length) {
    ws.getCell(row, 1).value = 'Filters';
    ws.getCell(row, 1).font = { bold: true, size: 10 };
    ws.getCell(row, 2).value = report.filters.join('  ·  ');
    ws.getCell(row, 2).font = { size: 10 };
    row += 2;
  }

  for (const s of report.sections) {
    if (report.sections.length > 1 || s.title !== report.title) {
      ws.getCell(row, 1).value = s.title;
      ws.getCell(row, 1).font = { bold: true, size: 12, color: { argb: TEAL } };
      row++;
    }
    const head = ws.getRow(row);
    s.columns.forEach((c, i) => {
      const cell = head.getCell(i + 1);
      cell.value = c.label;
      cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } };
      cell.alignment = { vertical: 'middle', wrapText: true, horizontal: c.kind && c.kind !== 'text' && c.kind !== 'date' ? 'right' : 'left' };
      cell.border = border;
    });
    head.height = 20;
    if (report.sections.length === 1) {
      ws.views = [{ state: 'frozen', ySplit: row, showGridLines: false }];
      ws.autoFilter = { from: { row, column: 1 }, to: { row, column: s.columns.length } };
    }
    row++;
    if (!s.rows.length) {
      ws.getCell(row, 1).value = 'Nothing in this period.';
      ws.getCell(row, 1).font = { italic: true, size: 10, color: { argb: MUTED } };
      row++;
    }
    const lines = s.totals ? [...s.rows, s.totals] : s.rows;
    lines.forEach((data, n) => {
      const total = !!s.totals && n === lines.length - 1;
      s.columns.forEach((c, i) => {
        const kind = kindOf(c, data);
        const cell = ws.getCell(row, i + 1);
        cell.value = value(data[c.key], kind);
        cell.font = { size: 10, bold: total || undefined, color: { argb: NIGHT } };
        cell.border = border;
        if (FORMATS[kind] && typeof cell.value !== 'string') cell.numFmt = FORMATS[kind];
        if (total) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL } };
        if (kind === 'text') cell.alignment = { wrapText: true, vertical: 'top' };
      });
      row++;
    });
    if (s.note) {
      ws.getCell(row, 1).value = s.note;
      ws.getCell(row, 1).font = { size: 9, color: { argb: MUTED } };
      row++;
    }
    row++;
  }

  for (const n of report.notes ?? []) {
    ws.getCell(row, 1).value = n;
    ws.getCell(row, 1).font = { size: 9, color: { argb: MUTED } };
    row++;
  }
  ws.getCell(row + 1, 1).value = 'Powered by YeaStay';
  ws.getCell(row + 1, 1).font = { size: 8, color: { argb: AMBER } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
