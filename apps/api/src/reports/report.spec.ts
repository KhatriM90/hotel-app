import { csvCell, toCsv } from './csv';
import { formatCell, pdfSafe, toPdf } from './pdf';
import { fileName, keyValueSection, Report } from './report';

const report: Report = {
  key: 'pos-sales',
  title: 'POS sales',
  scope: 'K1 Klubhouse',
  period: '2026-11-01 to 2026-11-02',
  filters: ['Outlet: All outlets'],
  generatedBy: 'K1 manager',
  generatedAt: '3 Nov 2026, 09:00 (EAT)',
  sections: [
    keyValueSection('Summary', [['Checks closed', 12, 'number'], ['Net sales', '1234.50'], ['Refunds', '-200.00']]),
    {
      title: 'By product',
      columns: [
        { key: 'name', label: 'Product' },
        { key: 'amount', label: 'Net sales', kind: 'money' },
      ],
      rows: [{ name: 'Tusker, "cold"', amount: '450.00' }, { name: '=HYPERLINK("x")', amount: '-50.00' }],
      totals: { name: 'Total', amount: '400.00' },
    },
  ],
  notes: ['Amounts in KES.'],
};

describe('report CSV (RPT-06)', () => {
  it('starts with a byte-order mark for Excel and keeps amounts as plain decimals', () => {
    const csv = toCsv(report);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Net sales,1234.50\r\n');
    expect(csv).toContain('Refunds,-200.00\r\n');
    expect(csv).toContain('Checks closed,12\r\n');
    expect(csv).toContain('Total,400.00\r\n');
  });

  it('quotes commas and quotes, and defuses formulas in text (CSV injection)', () => {
    expect(csvCell('Tusker, "cold"')).toBe('"Tusker, ""cold"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-50.00', 'money')).toBe('-50.00');
    expect(csvCell('-cmd', 'money')).toBe("'-cmd");
    expect(csvCell(null)).toBe('');
  });
});

describe('report PDF (RPT-06)', () => {
  it('formats money with separators and a plain minus', () => {
    expect(formatCell('1234567.5', 'money')).toBe('1,234,567.50');
    expect(formatCell('-314.00', 'money')).toBe('-314.00');
    expect(formatCell('0.00', 'money')).toBe('0.00');
    expect(formatCell('38.4615', 'percent')).toBe('38.5%');
  });

  it('replaces characters the built-in fonts cannot draw', () => {
    expect(pdfSafe('−5 × 2 → ok · Café')).toBe('-5 x 2 -> ok · Café');
    expect(pdfSafe('Room 🛏')).toBe('Room ?');
  });

  it('produces a PDF over several pages when a table is long', async () => {
    const long: Report = { ...report, sections: [{ ...report.sections[1], rows: Array.from({ length: 200 }, (_, i) => ({ name: `Item ${i}`, amount: `${i}.00` })) }] };
    const pdf = await toPdf(long);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(2);
  });
});

describe('file names', () => {
  it('carries the property, report and period', () => {
    expect(fileName(report, 'K1', 'csv')).toBe('K1-pos-sales-2026-11-01_2026-11-02.csv');
  });
});
