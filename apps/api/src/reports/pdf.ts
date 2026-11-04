import PDFDocument from 'pdfkit';
import { Money } from '@hotel/shared';
import { Cell, Column, Report, Section } from './report';

/**
 * PDF layout for reports (RPT-06): A4, the property's name first, YeaStay as a
 * small footer, tables that repeat their header on every page and page numbers.
 * Uses the built-in Helvetica so no font files are needed on the server.
 */

const TEAL = '#0E4D52';
const NIGHT = '#0B2E31';
const MUTED = '#5B6B6D';
const RULE = '#C9D3D4';
const ZEBRA = '#F3F6F6';
const MARGIN = 36;
const FONT = 8;
const PAD = 3;

// The standard PDF fonts only cover Windows-1252; swap the few symbols we use.
const SWAPS: Record<string, string> = { '−': '-', '×': 'x', '→': '->', '←': '<-', '✓': 'Yes', '…': '...', '≥': '>=', '≤': '<=' };
const WIN1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split(''));
export function pdfSafe(s: string): string {
  return Array.from(s)
    .map((ch) => SWAPS[ch] ?? (ch.charCodeAt(0) <= 0xff || WIN1252_EXTRA.has(ch) ? ch : '?'))
    .join('');
}

function kindOf(col: Column, row: Record<string, Cell>): string {
  return (col.kind === 'auto' ? (typeof row._kind === 'string' ? row._kind : 'text') : col.kind) ?? 'text';
}

export function formatCell(value: Cell, kind: string): string {
  if (value === null || value === undefined || value === '') return '';
  const s = String(value);
  if (kind === 'money' && /^-?\d+(\.\d+)?$/.test(s)) {
    const abs = Money.of(s.replace(/^-/, ''));
    return `${s.startsWith('-') && !abs.isZero() ? '-' : ''}${abs.format().replace(/^KES\s*/, '')}`;
  }
  if (kind === 'percent' && /^-?\d+(\.\d+)?$/.test(s)) return `${Number(s).toFixed(1)}%`;
  if (kind === 'number' && /^-?\d+(\.\d+)?$/.test(s)) return Number(s).toLocaleString('en-KE', { maximumFractionDigits: 3 });
  return pdfSafe(s);
}

const right = (kind: string) => kind === 'money' || kind === 'number' || kind === 'percent';

export function toPdf(report: Report): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    layout: report.landscape ? 'landscape' : 'portrait',
    margins: { top: MARGIN, bottom: MARGIN + 14, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: { Title: pdfSafe(`${report.title} - ${report.scope}`), Author: 'YeaStay', Creator: 'YeaStay' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - MARGIN * 2;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  // Title block
  doc.fillColor(NIGHT).font('Helvetica-Bold').fontSize(15).text(pdfSafe(report.scope), MARGIN, MARGIN, { width });
  doc.fillColor(TEAL).font('Helvetica-Bold').fontSize(12).text(pdfSafe(report.title), { width });
  doc.fillColor(NIGHT).font('Helvetica').fontSize(9).text(pdfSafe(report.period), { width });
  for (const f of report.filters ?? []) doc.text(pdfSafe(f), { width });
  doc.fillColor(MUTED).fontSize(7.5).text(pdfSafe(`Generated ${report.generatedAt}${report.generatedBy ? ` by ${report.generatedBy}` : ''}`), { width });
  doc.moveDown(0.6);

  for (const section of report.sections) drawSection(doc, section, width, bottom, report.sections.length > 1 || section.title !== report.title);

  if (report.notes?.length) {
    if (doc.y + 30 > bottom()) doc.addPage();
    doc.moveDown(0.4).fillColor(MUTED).font('Helvetica').fontSize(7.5);
    for (const n of report.notes) doc.text(pdfSafe(n), MARGIN, doc.y, { width });
  }

  // Footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - MARGIN;
    doc.fillColor(MUTED).font('Helvetica').fontSize(7);
    doc.text(pdfSafe(`${report.scope} · ${report.title} · ${report.period}`), MARGIN, y, { width: width - 120, lineBreak: false, height: 10 });
    doc.text(`Page ${i - range.start + 1} of ${range.count} · Powered by YeaStay`, MARGIN + width - 160, y, { width: 160, align: 'right', lineBreak: false, height: 10 });
  }
  doc.end();
  return done;
}

function drawSection(doc: PDFKit.PDFDocument, s: Section, width: number, bottom: () => number, heading = true): void {
  doc.font('Helvetica').fontSize(FONT);
  const all = [...s.rows, ...(s.totals ? [s.totals] : [])];
  const text = (row: Record<string, Cell>, c: Column) => formatCell(row[c.key], kindOf(c, row));

  // Natural widths, then squeeze text columns (which can wrap) to fit the page.
  doc.font('Helvetica-Bold');
  const natural = s.columns.map((c) => {
    let w = doc.widthOfString(pdfSafe(c.label));
    doc.font('Helvetica');
    for (const r of all) w = Math.max(w, doc.widthOfString(text(r, c)));
    doc.font('Helvetica-Bold');
    return Math.min(w, 260) + PAD * 2 + 1;
  });
  doc.font('Helvetica');
  let widths = natural;
  const total = natural.reduce((a, b) => a + b, 0);
  if (total > width) {
    const fixed = s.columns.map((c, i) => (c.kind && c.kind !== 'text' && i > 0 ? natural[i] : 0));
    const fixedSum = fixed.reduce((a, b) => a + b, 0);
    const flexSum = total - fixedSum;
    const room = Math.max(width - fixedSum, s.columns.length * 30);
    widths = natural.map((w, i) => (fixed[i] ? w : Math.max(30, (w / flexSum) * room)));
    const sum = widths.reduce((a, b) => a + b, 0);
    if (sum > width) widths = widths.map((w) => (w / sum) * width);
  } else if (s.columns.length > 1) {
    // Stretch the first column so short tables still read as a table.
    widths = [...natural];
    widths[0] += Math.min(width - total, 160);
  }

  const rowHeight = (row: Record<string, Cell>, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT);
    return Math.max(...s.columns.map((c, i) => doc.heightOfString(text(row, c) || ' ', { width: widths[i] - PAD * 2 }))) + PAD * 2;
  };
  const headerHeight = () => {
    doc.font('Helvetica-Bold').fontSize(FONT);
    return Math.max(...s.columns.map((c, i) => doc.heightOfString(pdfSafe(c.label), { width: widths[i] - PAD * 2 }))) + PAD * 2;
  };

  const drawHeader = () => {
    const h = headerHeight();
    let x = MARGIN;
    doc.rect(MARGIN, doc.y, widths.reduce((a, b) => a + b, 0), h).fill(TEAL);
    const y = doc.y;
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(FONT);
    s.columns.forEach((c, i) => {
      doc.text(pdfSafe(c.label), x + PAD, y + PAD, { width: widths[i] - PAD * 2, align: right(c.kind ?? 'text') || c.kind === 'auto' ? 'right' : 'left' });
      x += widths[i];
    });
    doc.y = y + h;
  };

  const drawRow = (row: Record<string, Cell>, index: number, isTotal: boolean) => {
    const h = rowHeight(row, isTotal);
    if (doc.y + h > bottom()) {
      doc.addPage();
      doc.y = MARGIN;
      drawHeader();
    }
    const y = doc.y;
    const tableWidth = widths.reduce((a, b) => a + b, 0);
    if (isTotal) doc.rect(MARGIN, y, tableWidth, h).fill('#E4ECEC');
    else if (index % 2 === 1) doc.rect(MARGIN, y, tableWidth, h).fill(ZEBRA);
    doc.fillColor(NIGHT).font(isTotal ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT);
    let x = MARGIN;
    s.columns.forEach((c, i) => {
      doc.text(text(row, c), x + PAD, y + PAD, { width: widths[i] - PAD * 2, align: right(kindOf(c, row)) || c.kind === 'auto' ? 'right' : 'left' });
      x += widths[i];
    });
    doc.moveTo(MARGIN, y + h).lineTo(MARGIN + tableWidth, y + h).lineWidth(0.4).strokeColor(RULE).stroke();
    doc.y = y + h;
  };

  // Keep a section title with its header and first row.
  const first = s.rows[0] ? rowHeight(s.rows[0]) : 14;
  if (doc.y + 16 + headerHeight() + first > bottom()) doc.addPage();
  doc.x = MARGIN;
  if (heading) {
    doc.fillColor(TEAL).font('Helvetica-Bold').fontSize(10).text(pdfSafe(s.title), MARGIN, doc.y, { width });
    doc.moveDown(0.2);
  }
  drawHeader();
  if (!s.rows.length) {
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(FONT).text('Nothing in this period.', MARGIN + PAD, doc.y + PAD, { width });
  }
  s.rows.forEach((r, i) => drawRow(r, i, false));
  if (s.totals) drawRow(s.totals, 0, true);
  if (s.note) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(7).text(pdfSafe(s.note), MARGIN, doc.y + 3, { width });
  }
  doc.font('Helvetica').fontSize(FONT);
  doc.y += 12;
}
