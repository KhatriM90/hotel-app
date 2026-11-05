import { Report, Section } from '../reports/report';

/**
 * Guest documents as PDF attachments for email (pro forma and receipts), laid
 * out with the report PDF engine. Content comes from the frozen document
 * snapshot, so the attachment matches the printed copy (BIL-09).
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function documentReport(doc: { documentType: string; number: string; content: Json }): Report {
  const c = doc.content;
  const issuedAt = String(c.issuedAt ?? new Date().toISOString());
  const base = {
    scope: String(c.property?.name ?? ''),
    generatedBy: (c.issuedBy as string | null) ?? null,
    generatedAt: issuedAt,
  };
  const header: Array<[string, string]> = [
    ['Document', doc.number],
    ...(c.property?.legalName ? [['Issued by', `${c.property.legalName}${c.property.kraPin ? ` · KRA PIN ${c.property.kraPin}` : ''}`] as [string, string]] : []),
  ];
  const kv = (title: string, rows: Array<[string, unknown]>): Section => ({
    title,
    columns: [
      { key: 'item', label: 'Item' },
      { key: 'value', label: 'Value' },
    ],
    rows: rows.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([item, value]) => ({ item, value: String(value) })),
  });

  if (doc.documentType === 'RECEIPT') {
    return {
      ...base,
      key: 'receipt',
      title: 'Receipt',
      period: doc.number,
      sections: [
        kv('Receipt', [
          ...header,
          ['Received from', c.guest],
          ['Booking', c.reservationNumber],
          ['Folio / stay', `${c.folioNumber} · ${c.stayNumber}`],
          ['Business date', c.businessDate],
          ['Tender', `${String(c.tender).replace(/_/g, ' ')}${c.reference ? ` · ${c.reference}` : ''}`],
        ]),
        {
          title: 'Amount',
          columns: [
            { key: 'item', label: 'Item' },
            { key: 'amount', label: 'Amount (KES)', kind: 'money' },
          ],
          rows: [{ item: c.isDeposit ? 'Deposit received' : 'Amount received', amount: String(c.amount) }],
        },
      ],
      notes: ['This receipt is not a tax invoice.'],
    };
  }

  // PROFORMA
  const stays = (c.stays as Json[]) ?? [];
  const sections: Section[] = [
    kv('Booking', [
      ...header,
      ['Prepared for', c.booker?.name],
      ['Company', c.company?.name],
      ['Travel agent', c.agent?.name],
      ['Booking reference', c.reservationNumber],
    ]),
    ...stays.map((s) => ({
      title: `${s.roomType}, ${s.arrival} to ${s.departure} (${s.ratePlan}, ${s.adults} adult(s)${Number(s.children) ? `, ${s.children} child(ren)` : ''})`,
      columns: [
        { key: 'date', label: 'Night', kind: 'date' as const },
        { key: 'season', label: 'Season' },
        { key: 'amount', label: 'Amount (KES)', kind: 'money' as const },
      ],
      rows: ((s.nights as Json[]) ?? []).map((n) => ({ date: n.date, season: n.seasonName ?? '', amount: String(n.amount) })),
      totals: { date: 'Total', amount: String(s.total) },
    })),
    {
      title: 'Totals',
      columns: [
        { key: 'item', label: 'Item' },
        { key: 'value', label: 'Value', kind: 'auto' as const },
      ],
      rows: [
        { item: 'Total accommodation', value: String(c.total), _kind: 'money' },
        { item: 'Deposit required', value: String(c.deposit?.required ?? '0'), _kind: 'money' },
        { item: 'Deposit due by', value: String(c.deposit?.dueDate ?? ''), _kind: 'text' },
      ],
    },
  ];
  const notes = ['This pro forma is a quotation, not a tax invoice. Prices include VAT and catering levy.'];
  if (c.policy?.refundPolicy) notes.push(`Cancellation and refunds: ${c.policy.refundPolicy}`);
  if (c.policy?.hotelPolicies) notes.push(`Hotel policies: ${c.policy.hotelPolicies}`);
  return { ...base, key: 'proforma', title: 'Pro forma invoice', period: doc.number, sections, notes };
}
