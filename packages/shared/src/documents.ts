/**
 * Property-scoped document numbering (CFG-04, BIL-09).
 * Numbers look like "K1-INV-000123": the property prefix makes them unique group-wide.
 * Allocation happens in Postgres (next_document_number) inside the business transaction,
 * so a rolled-back transaction never burns a number.
 */
export const DOCUMENT_TYPES = {
  BOOKING: 'BK',
  STAY: 'ST',
  FOLIO: 'FO',
  POS_CHECK: 'CHK',
  INVOICE: 'INV',
  RECEIPT: 'RCT',
  CREDIT_NOTE: 'CN',
  REFUND: 'RF',
  PROFORMA: 'PF',
  POS_TICKET: 'KOT',
  CASH_SHIFT: 'SFT',
} as const;

export type DocumentType = keyof typeof DOCUMENT_TYPES;

export function formatDocumentNumber(propertyCode: string, type: DocumentType, seq: bigint | number, padding = 6): string {
  const n = seq.toString();
  return `${propertyCode}-${DOCUMENT_TYPES[type]}-${n.length >= padding ? n : n.padStart(padding, '0')}`;
}

const NUMBER_RE = /^([A-Z0-9]{2,4})-([A-Z]{2,4})-(\d{6,})$/;

export function parseDocumentNumber(value: string): { propertyCode: string; prefix: string; seq: bigint } | null {
  const m = NUMBER_RE.exec(value);
  if (!m) return null;
  return { propertyCode: m[1], prefix: m[2], seq: BigInt(m[3]) };
}
