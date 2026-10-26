/**
 * Maps cloud outbox events to Service Layer documents (SAP-04, SAP-05, SAP-13,
 * SAP-15, SAP-20). Values marked TBC in brief §15 (branch codes, tax codes,
 * item codes) come from the signed mapping workbook, not from code.
 */

export interface ClaimedJob {
  id: string;
  eventType: string;
  externalRef: string;
  payload: Record<string, unknown>;
  attempts: number;
  property: { code: string; sapBranchId: number | null; sapDimension1: string };
}

export class MappingError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'MappingError';
  }
}

export interface MappedDocument {
  entity: 'Invoices' | 'CreditNotes' | 'IncomingPayments';
  body: Record<string, unknown>;
}

interface InvoiceLine {
  itemCode: string;
  description?: string;
  quantity: string;
  unitPriceInclTax: string;
  taxCode?: string;
  warehouseCode?: string;
  revenueCentre: string;
  /** Outlet's SAP Dimension 2 code (max 8 chars); falls back to the revenue centre. */
  dimension2Code?: string | null;
}

interface InvoicePayload {
  documentNumber: string;
  cardCode: string;
  docDate: string;
  folioNumber?: string | null;
  lines: InvoiceLine[];
}

/** Decimal strings become JSON numbers for SAP. Amounts are 2dp/4dp, well inside exact double range. */
function num(value: string, field: string): number {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new MappingError(`${field} is not a decimal string: ${value}`);
  return Number(value);
}

function traceability(job: ClaimedJob, folioNumber?: string | null): Record<string, unknown> {
  return {
    U_HTL_ExtRef: job.externalRef,
    U_HTL_Property: job.property.code,
    ...(folioNumber ? { U_HTL_FolioNo: folioNumber } : {}),
  };
}

function branch(job: ClaimedJob): number {
  if (job.property.sapBranchId == null) {
    throw new MappingError(`Property ${job.property.code} has no SAP branch (BPLId) configured (SAP-13)`);
  }
  return job.property.sapBranchId;
}

function mapInvoice(job: ClaimedJob, entity: 'Invoices' | 'CreditNotes'): MappedDocument {
  const p = job.payload as unknown as InvoicePayload;
  if (!p.cardCode || !p.docDate || !Array.isArray(p.lines) || p.lines.length === 0) {
    throw new MappingError(`${job.eventType} ${job.externalRef} payload is incomplete`);
  }
  return {
    entity,
    body: {
      CardCode: p.cardCode,
      DocDate: p.docDate,
      DocDueDate: p.docDate,
      TaxDate: p.docDate,
      BPL_IDAssignedToInvoice: branch(job),
      NumAtCard: p.documentNumber,
      Comments: `Hotel app ${p.documentNumber}`,
      ...traceability(job, p.folioNumber),
      DocumentLines: p.lines.map((l, i) => ({
        ItemCode: l.itemCode,
        ...(l.description ? { ItemDescription: l.description.slice(0, 100) } : {}),
        Quantity: num(l.quantity, `lines[${i}].quantity`),
        PriceAfterVAT: num(l.unitPriceInclTax, `lines[${i}].unitPriceInclTax`),
        ...(l.taxCode && l.taxCode !== 'TBC' ? { TaxCode: l.taxCode } : {}),
        ...(l.warehouseCode ? { WarehouseCode: l.warehouseCode } : {}),
        CostingCode: job.property.sapDimension1, // Dimension 1 = property (SAP-15)
        CostingCode2: l.dimension2Code ?? l.revenueCentre, // Dimension 2 = outlet (SAP-15)
      })),
    },
  };
}

interface PaymentPayload {
  receiptNumber: string;
  cardCode: string;
  docDate: string;
  folioNumber?: string | null;
  cashAccount?: string;
  cashSum?: string;
  transferAccount?: string;
  transferSum?: string;
  transferReference?: string;
}

function mapPayment(job: ClaimedJob): MappedDocument {
  const p = job.payload as unknown as PaymentPayload;
  if (!p.cardCode || !p.docDate) throw new MappingError(`INCOMING_PAYMENT ${job.externalRef} payload is incomplete`);
  return {
    entity: 'IncomingPayments',
    body: {
      CardCode: p.cardCode,
      DocDate: p.docDate,
      BPLID: branch(job),
      CounterReference: p.receiptNumber,
      ...traceability(job, p.folioNumber),
      ...(p.cashSum ? { CashAccount: p.cashAccount, CashSum: num(p.cashSum, 'cashSum') } : {}),
      ...(p.transferSum
        ? {
            TransferAccount: p.transferAccount,
            TransferSum: num(p.transferSum, 'transferSum'),
            TransferReference: p.transferReference,
          }
        : {}),
      // Invoice allocation (PaymentInvoices) and on-account deposits (SAP-05/06/19) arrive with billing.
    },
  };
}

export function mapJob(job: ClaimedJob): MappedDocument {
  switch (job.eventType) {
    case 'AR_INVOICE':
      return mapInvoice(job, 'Invoices');
    case 'AR_CREDIT_NOTE':
      return mapInvoice(job, 'CreditNotes');
    case 'INCOMING_PAYMENT':
      return mapPayment(job);
    default:
      throw new MappingError(`No SAP mapping for event type ${job.eventType}`);
  }
}
