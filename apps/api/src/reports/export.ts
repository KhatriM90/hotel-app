import { BadRequestException, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { requestContext } from '../db/request-context';
import { toCsv } from './csv';
import { toPdf } from './pdf';
import { ExportFormat, fileName, Report } from './report';
import { toXlsx } from './xlsx';

const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function parseFormat(value: unknown): ExportFormat {
  if (value === 'csv' || value === 'pdf' || value === 'xlsx') return value;
  throw new BadRequestException('format must be xlsx, pdf or csv');
}

/** Nairobi time stamp for "Generated ..." lines. */
export function generatedAt(timezone = 'Africa/Nairobi'): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date()) + ' (EAT)';
}

export function generatedBy(): string | null {
  return requestContext.get()?.user?.displayName ?? null;
}

/**
 * Sends a report as an Excel, PDF or CSV download (RPT-06) and records who exported what, when
 * and with which filters in the audit log (SEC-04). Permissions and property
 * scope were already enforced by the guard and row-level security.
 */
@Injectable()
export class ReportExporter {
  constructor(private readonly audit: AuditService) {}

  async send(res: Response, report: Report, format: ExportFormat, prefix: string, filters: Record<string, unknown>): Promise<void> {
    const name = fileName(report, prefix, format);
    const body = format === 'csv' ? Buffer.from(toCsv(report), 'utf8') : format === 'xlsx' ? await toXlsx(report) : await toPdf(report);
    await this.audit.record({ action: 'report.export', entityType: 'report', newValues: { report: report.key, format, file: name, ...filters } });
    res.setHeader('content-type', CONTENT_TYPES[format]);
    res.setHeader('content-disposition', `attachment; filename="${name}"`);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('access-control-expose-headers', 'content-disposition');
    res.send(body);
  }
}
