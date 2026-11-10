import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { conflict } from '../frontoffice/common';
import { actorId } from './common';
import { escposCheck, escposTest, escposTicket } from './escpos';

/** Tries on one printer before the job fails (and moves to the backup printer, if any). */
export const PRINT_MAX_ATTEMPTS = 3;
/** The bridge must answer a claimed job within this time, or it counts as a failed try. */
export const PRINT_LEASE_SECONDS = 30;
/** A job nobody claimed for this long fails, because the bridge is not running. */
export const PRINT_UNCLAIMED_SECONDS = 60;
/** The bridge counts as online if it asked for work this recently. */
export const BRIDGE_ONLINE_SECONDS = 20;

export interface PrinterInput {
  code: string;
  name: string;
  connection: 'network' | 'windows';
  host?: string | null;
  port?: number;
  windowsName?: string | null;
  paperMm?: 58 | 80;
  backupPrinterId?: string | null;
  isActive?: boolean;
}

export interface PrintResult {
  outcome: 'printed' | 'failed';
  error?: string | null;
}

const PRINTER_COLUMNS = `p.id, p.code, p.name, p.connection, p.host, p.port, p.windows_name AS "windowsName", p.paper_mm AS "paperMm",
  p.backup_printer_id AS "backupPrinterId", b.name AS "backupPrinterName", p.is_active AS "isActive"`;

const JOB_COLUMNS = `j.id, j.kind, j.title, j.status, j.attempts, j.last_error AS "error", j.created_at AS "createdAt", j.printed_at AS "printedAt",
  j.failed_at AS "failedAt", j.ticket_id AS "ticketId", j.check_id AS "checkId", p.name AS "printer", p.code AS "printerCode",
  j.acknowledged_at AS "acknowledgedAt", au.display_name AS "acknowledgedBy", o.name AS outlet,
  r.id AS "replacedById", r.status AS "replacedByStatus", rp.name AS "replacedByPrinter"`;
const JOB_FROM = `print_jobs j JOIN pos_printers p ON p.id = j.printer_id
  LEFT JOIN users au ON au.id = j.acknowledged_by LEFT JOIN outlets o ON o.id = j.outlet_id
  LEFT JOIN print_jobs r ON r.id = j.replaced_by LEFT JOIN pos_printers rp ON rp.id = r.printer_id`;

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

/**
 * Printing through the POS bridge at each property (INT-04; Kahama meeting
 * item 2.4). Every ticket, bill and receipt sent to a printer is a job with a
 * status. A failed try is retried; after three tries the job fails, moves to
 * the printer's backup if it has one, and shows as an alert on the waiter's
 * tablet, the kitchen/bar screen and the back office until someone deals with it.
 */
@Injectable()
export class PosPrintingService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Printers and where things print
  // -------------------------------------------------------------------------

  async printers(propertyId: string) {
    return this.db.tx(async (q) => {
      const { rows: printers } = await q.query(
        `SELECT ${PRINTER_COLUMNS} FROM pos_printers p LEFT JOIN pos_printers b ON b.id = p.backup_printer_id
          WHERE p.property_id = $1 ORDER BY p.is_active DESC, p.name`,
        [propertyId],
      );
      const { rows: stations } = await q.query(
        `SELECT s.code, s.name, s.kind, s.printer_id AS "printerId", s.is_active AS "isActive" FROM pos_stations s WHERE s.property_id = $1 ORDER BY s.name`,
        [propertyId],
      );
      const { rows: outlets } = await q.query(
        `SELECT o.code, o.name, o.receipt_printer_id AS "printerId" FROM outlets o WHERE o.property_id = $1 AND o.pos_enabled AND o.is_active ORDER BY o.name`,
        [propertyId],
      );
      return { bridge: await this.bridgeView(q, propertyId), printers, stations, outlets };
    });
  }

  private async checkBackup(q: Queryable, propertyId: string, backupId: string | null | undefined, selfId?: string) {
    if (!backupId) return;
    if (backupId === selfId) throw conflict('A printer cannot be its own backup', 'invalid_backup');
    const { rows } = await q.query('SELECT 1 FROM pos_printers WHERE property_id = $1 AND id = $2 AND is_active', [propertyId, backupId]);
    if (!rows[0]) throw new NotFoundException('Backup printer not found at this property');
  }

  async createPrinter(propertyId: string, input: PrinterInput) {
    return this.db.tx(async (q) => {
      await this.checkBackup(q, propertyId, input.backupPrinterId);
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO pos_printers (property_id, code, name, connection, host, port, windows_name, paper_mm, backup_printer_id, is_active, updated_by)
         VALUES ($1, $2, $3, $4, $5, coalesce($6, 9100), $7, coalesce($8, 80), $9, coalesce($10, true), $11)
         ON CONFLICT (property_id, code) DO NOTHING RETURNING id`,
        [propertyId, input.code.toUpperCase(), input.name, input.connection, input.connection === 'network' ? input.host : null, input.port ?? null,
          input.connection === 'windows' ? input.windowsName : null, input.paperMm ?? null, input.backupPrinterId ?? null, input.isActive ?? null, actorId()],
      );
      if (!rows[0]) throw conflict(`A printer with code ${input.code.toUpperCase()} already exists`, 'duplicate_code');
      await this.audit.record({ action: 'pos.printer_created', entityType: 'pos_printer', entityId: rows[0].id, propertyId, newValues: input });
      return this.printer(q, propertyId, rows[0].id);
    });
  }

  async updatePrinter(propertyId: string, id: string, input: Partial<PrinterInput>) {
    return this.db.tx(async (q) => {
      const old = await this.printer(q, propertyId, id, true);
      await this.checkBackup(q, propertyId, input.backupPrinterId, id);
      const connection = input.connection ?? old.connection;
      await q.query(
        `UPDATE pos_printers SET name = coalesce($3, name), connection = $4,
                host = CASE WHEN $4 = 'network' THEN coalesce($5, host) END, port = coalesce($6, port),
                windows_name = CASE WHEN $4 = 'windows' THEN coalesce($7, windows_name) END, paper_mm = coalesce($8, paper_mm),
                backup_printer_id = CASE WHEN $9 THEN $10::uuid ELSE backup_printer_id END, is_active = coalesce($11, is_active), updated_by = $12
          WHERE property_id = $1 AND id = $2`,
        [propertyId, id, input.name ?? null, connection, input.host ?? null, input.port ?? null, input.windowsName ?? null, input.paperMm ?? null,
          input.backupPrinterId !== undefined, input.backupPrinterId ?? null, input.isActive ?? null, actorId()],
      );
      await this.audit.record({ action: 'pos.printer_updated', entityType: 'pos_printer', entityId: id, propertyId, previousValues: old, newValues: input });
      return this.printer(q, propertyId, id);
    });
  }

  private async printer(q: Queryable, propertyId: string, id: string, lock = false) {
    const { rows } = await q.query<{ id: string; code: string; name: string; connection: 'network' | 'windows'; paperMm: number; isActive: boolean }>(
      `SELECT ${PRINTER_COLUMNS} FROM pos_printers p LEFT JOIN pos_printers b ON b.id = p.backup_printer_id
        WHERE p.property_id = $1 AND p.id = $2 ${lock ? 'FOR UPDATE OF p' : ''}`,
      [propertyId, id],
    );
    if (!rows[0]) throw new NotFoundException('Printer not found at this property');
    return rows[0];
  }

  /** Kitchen/bar station → printer, or outlet → receipt printer. null stops printing there. */
  async assign(propertyId: string, target: { station?: string; outlet?: string }, printerId: string | null) {
    return this.db.tx(async (q) => {
      if (printerId) await this.printer(q, propertyId, printerId);
      const { rowCount } = target.station
        ? await q.query('UPDATE pos_stations SET printer_id = $3 WHERE property_id = $1 AND code = $2', [propertyId, target.station.toUpperCase(), printerId])
        : await q.query('UPDATE outlets SET receipt_printer_id = $3 WHERE property_id = $1 AND code = $2', [propertyId, String(target.outlet).toUpperCase(), printerId]);
      if (!rowCount) throw new NotFoundException(target.station ? `Station ${target.station} not found` : `Outlet ${target.outlet} not found`);
      await this.audit.record({ action: 'pos.printer_assigned', entityType: target.station ? 'pos_station' : 'outlet', entityId: null, propertyId, newValues: { ...target, printerId } });
      return { ...target, printerId };
    });
  }

  // -------------------------------------------------------------------------
  // The bridge
  // -------------------------------------------------------------------------

  private async bridgeView(q: Queryable, propertyId: string) {
    const { rows } = await q.query<{ paired: boolean; pairedAt: string | null; lastSeenAt: string | null; online: boolean; bridgeId: string | null; version: string | null; mode: string | null }>(
      `SELECT token_hash IS NOT NULL AS paired, paired_at AS "pairedAt", last_seen_at AS "lastSeenAt",
              coalesce(last_seen_at > now() - make_interval(secs => $2), false) AS online, bridge_id AS "bridgeId", version, mode
         FROM pos_bridges WHERE property_id = $1`,
      [propertyId, BRIDGE_ONLINE_SECONDS],
    );
    return rows[0] ?? { paired: false, pairedAt: null, lastSeenAt: null, online: false, bridgeId: null, version: null, mode: null };
  }

  /** A new token replaces any earlier one, which stops working at once. Shown once. */
  async pair(propertyId: string) {
    return this.db.tx(async (q) => {
      const token = randomBytes(32).toString('base64url');
      await q.query(
        `INSERT INTO pos_bridges (property_id, token_hash, paired_at, paired_by) VALUES ($1, $2, now(), $3)
         ON CONFLICT (property_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, paired_at = now(), paired_by = EXCLUDED.paired_by,
                last_seen_at = NULL, bridge_id = NULL, version = NULL, mode = NULL`,
        [propertyId, sha256(token), actorId()],
      );
      await this.audit.record({ action: 'pos.bridge_paired', entityType: 'pos_bridge', entityId: propertyId, propertyId });
      return { token, bridge: await this.bridgeView(q, propertyId) };
    });
  }

  async unpair(propertyId: string) {
    return this.db.tx(async (q) => {
      await q.query(
        `UPDATE pos_bridges SET token_hash = NULL, last_seen_at = NULL, bridge_id = NULL, version = NULL, mode = NULL WHERE property_id = $1`,
        [propertyId],
      );
      await this.audit.record({ action: 'pos.bridge_unpaired', entityType: 'pos_bridge', entityId: propertyId, propertyId });
      return this.bridgeView(q, propertyId);
    });
  }

  // -------------------------------------------------------------------------
  // Queuing jobs
  // -------------------------------------------------------------------------

  private async insertJob(
    q: Queryable,
    job: { propertyId: string; printerId: string; kind: string; title: string; payload: string; ticketId?: string | null; checkId?: string | null; outletId?: string | null },
  ) {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO print_jobs (property_id, printer_id, kind, title, payload, ticket_id, check_id, outlet_id, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [job.propertyId, job.printerId, job.kind, job.title, job.payload, job.ticketId ?? null, job.checkId ?? null, job.outletId ?? null, actorId()],
    );
    return rows[0].id;
  }

  /**
   * Queues a kitchen/bar ticket on its station's printer, inside the caller's
   * transaction. Returns null when the station has no printer (the ticket screen
   * still shows it).
   */
  async queueTicket(q: Queryable, propertyId: string, ticketId: string, printNo?: number): Promise<{ id: string; printer: string } | null> {
    const { rows } = await q.query<{
      id: string; number: string; kind: string; route: string; content: Record<string, unknown>; prints: number; checkId: string; outletId: string;
      printerId: string | null; printer: string | null; paperMm: number | null; tableCode: string | null;
    }>(
      `SELECT t.id, t.number, t.kind, t.route, t.content, (SELECT max(print_no) FROM pos_ticket_prints x WHERE x.ticket_id = t.id) AS prints,
              t.check_id AS "checkId", c.outlet_id AS "outletId", p.id AS "printerId", p.name AS printer, p.paper_mm AS "paperMm"
         FROM pos_tickets t JOIN pos_checks c ON c.id = t.check_id
         LEFT JOIN pos_stations s ON s.id = t.station_id LEFT JOIN pos_printers p ON p.id = s.printer_id AND p.is_active
        WHERE t.property_id = $1 AND t.id = $2`,
      [propertyId, ticketId],
    );
    const t = rows[0];
    if (!t?.printerId) return null;
    const ticket = { ...t, printNo: printNo ?? t.prints };
    const c = t.content as { table?: string | null; room?: string | null; tab?: string | null };
    const where = c.table ? `Table ${c.table}` : c.room ? `Room ${c.room}` : c.tab ?? '';
    const id = await this.insertJob(q, {
      propertyId, printerId: t.printerId, kind: 'ticket', ticketId: t.id, checkId: t.checkId, outletId: t.outletId,
      title: `${t.kind === 'cancellation' ? 'Cancel ticket' : 'Ticket'} ${t.number}${where ? ` · ${where}` : ''}${ticket.printNo > 1 ? ` · reprint ${ticket.printNo}` : ''}`,
      payload: escposTicket(ticket, t.paperMm ?? 80).toBase64(),
    });
    return { id, printer: t.printer! };
  }

  /** Queues a guest bill or receipt on the outlet's receipt printer; null if the outlet has none. */
  async queueCheck(
    q: Queryable,
    propertyId: string,
    view: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    header: Record<string, unknown>,
    print: { kind: 'bill' | 'receipt'; printNo: number; changed: boolean },
  ): Promise<{ id: string; printer: string } | null> {
    const { rows } = await q.query<{ outletId: string; printerId: string | null; printer: string | null; paperMm: number | null }>(
      `SELECT o.id AS "outletId", p.id AS "printerId", p.name AS printer, p.paper_mm AS "paperMm"
         FROM pos_checks c JOIN outlets o ON o.id = c.outlet_id LEFT JOIN pos_printers p ON p.id = o.receipt_printer_id AND p.is_active
        WHERE c.property_id = $1 AND c.id = $2`,
      [propertyId, view.id],
    );
    const r = rows[0];
    if (!r?.printerId) return null;
    const id = await this.insertJob(q, {
      propertyId, printerId: r.printerId, kind: print.kind, checkId: String(view.id), outletId: r.outletId,
      title: `${print.kind === 'bill' ? 'Bill' : 'Receipt'} ${view.number}${view.tableCode ? ` · Table ${view.tableCode}` : ''}${print.printNo > 1 ? ` · print ${print.printNo}` : ''}`,
      payload: escposCheck(view, header, r.paperMm ?? 80, print).toBase64(),
    });
    return { id, printer: r.printer! };
  }

  async testPrint(propertyId: string, printerId: string) {
    return this.db.tx(async (q) => {
      const printer = await this.printer(q, propertyId, printerId);
      const { rows: [prop] } = await q.query<{ name: string; local: string }>(
        `SELECT name, to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD HH24:MI:SS') AS local FROM properties WHERE id = $1`,
        [propertyId],
      );
      const id = await this.insertJob(q, {
        propertyId, printerId, kind: 'test', title: `Test print · ${printer.name}`, payload: escposTest(printer, prop.name, prop.local).toBase64(),
      });
      return this.job(q, propertyId, id);
    });
  }

  // -------------------------------------------------------------------------
  // Failures: retry, backup printer, alerts
  // -------------------------------------------------------------------------

  /**
   * A try failed. Under three tries, wait a little and try again. Then the job
   * fails, and moves to the printer's backup if it has one.
   */
  private async failTry(q: Queryable, propertyId: string, jobId: string, error: string, retry = true): Promise<void> {
    const { rows: [j] } = await q.query<{ attempts: number; printerId: string; backupId: string | null; backupName: string | null; replacesOther: boolean }>(
      `SELECT j.attempts, j.printer_id AS "printerId", b.id AS "backupId", b.name AS "backupName",
              EXISTS (SELECT 1 FROM print_jobs o WHERE o.replaced_by = j.id) AS "replacesOther"
         FROM print_jobs j JOIN pos_printers p ON p.id = j.printer_id LEFT JOIN pos_printers b ON b.id = p.backup_printer_id AND b.is_active
        WHERE j.id = $1`,
      [jobId],
    );
    const msg = error.slice(0, 500);
    if (retry && j.attempts < PRINT_MAX_ATTEMPTS) {
      await q.query(
        `UPDATE print_jobs SET status = 'queued', claimed_by = NULL, claim_expires_at = NULL, last_error = $2,
                next_attempt_at = now() + make_interval(secs => 5 * attempts) WHERE id = $1`,
        [jobId, msg],
      );
      return;
    }
    let note = msg;
    let replacedBy: string | null = null;
    // A job already moved once goes no further, so two printers cannot pass it back and forth.
    if (retry && j.backupId && !j.replacesOther) {
      const { rows: [copy] } = await q.query<{ id: string }>(
        `INSERT INTO print_jobs (property_id, printer_id, kind, title, payload, ticket_id, check_id, outlet_id, requested_by)
         SELECT property_id, $2, kind, title || ' (backup printer)', payload, ticket_id, check_id, outlet_id, requested_by FROM print_jobs WHERE id = $1
         RETURNING id`,
        [jobId, j.backupId],
      );
      replacedBy = copy.id;
      note = `${msg} Sent to ${j.backupName} instead.`;
    }
    await q.query(
      `UPDATE print_jobs SET status = 'failed', failed_at = now(), claimed_by = NULL, claim_expires_at = NULL, last_error = $2, replaced_by = $3 WHERE id = $1`,
      [jobId, note.slice(0, 1000), replacedBy],
    );
    await this.audit.record({ action: 'pos.print_failed', entityType: 'print_job', entityId: jobId, propertyId, newValues: { error: note } });
  }

  /** Claims nobody answered count as failed tries; jobs nobody claimed fail when the bridge is not running. */
  async expireStale(q: Queryable, propertyId: string): Promise<void> {
    const { rows: lapsed } = await q.query<{ id: string }>(
      `SELECT id FROM print_jobs WHERE property_id = $1 AND status = 'printing' AND claim_expires_at < now() FOR UPDATE SKIP LOCKED`,
      [propertyId],
    );
    for (const j of lapsed) await this.failTry(q, propertyId, j.id, 'The POS bridge did not report back from the printer.');
    const { rows: orphans } = await q.query<{ id: string }>(
      `SELECT j.id FROM print_jobs j LEFT JOIN pos_bridges b ON b.property_id = j.property_id
        WHERE j.property_id = $1 AND j.status = 'queued' AND j.attempts = 0 AND j.created_at < now() - make_interval(secs => $2)
          AND (b.last_seen_at IS NULL OR b.last_seen_at < now() - make_interval(secs => $3))
        FOR UPDATE OF j SKIP LOCKED`,
      [propertyId, PRINT_UNCLAIMED_SECONDS, BRIDGE_ONLINE_SECONDS],
    );
    for (const j of orphans) {
      await this.failTry(q, propertyId, j.id, 'Not printed: the POS bridge at this property is not running. Check the bridge PC, then reprint.', false);
    }
  }

  /** Failed prints nobody has dealt with yet, newest first; for one outlet, or for one station's tickets. */
  async alerts(propertyId: string, filter: { outlet?: string; station?: string } = {}) {
    return this.db.tx(async (q) => {
      await this.expireStale(q, propertyId);
      const { rows } = await q.query(
        `SELECT ${JOB_COLUMNS} FROM ${JOB_FROM}
          LEFT JOIN pos_tickets t ON t.id = j.ticket_id LEFT JOIN pos_stations st ON st.id = t.station_id
          WHERE j.property_id = $1 AND j.status = 'failed' AND j.acknowledged_at IS NULL AND j.kind <> 'test'
            AND j.failed_at > now() - interval '12 hours'
            AND ($2::text IS NULL OR o.code = $2) AND ($3::text IS NULL OR st.code = $3)
          ORDER BY j.failed_at DESC LIMIT 50`,
        [propertyId, filter.outlet?.toUpperCase() ?? null, filter.station?.toUpperCase() ?? null],
      );
      return rows;
    });
  }

  /** Recent jobs for the back office (all, or only failed). */
  async jobs(propertyId: string, onlyFailed = false) {
    return this.db.tx(async (q) => {
      await this.expireStale(q, propertyId);
      const { rows } = await q.query(
        `SELECT ${JOB_COLUMNS} FROM ${JOB_FROM}
          WHERE j.property_id = $1 AND ($2 = false OR j.status = 'failed') AND j.created_at > now() - interval '2 days'
          ORDER BY j.created_at DESC LIMIT 200`,
        [propertyId, onlyFailed],
      );
      return rows;
    });
  }

  private async job(q: Queryable, propertyId: string, id: string) {
    const { rows } = await q.query(`SELECT ${JOB_COLUMNS} FROM ${JOB_FROM} WHERE j.property_id = $1 AND j.id = $2`, [propertyId, id]);
    if (!rows[0]) throw new NotFoundException('Print job not found at this property');
    return rows[0];
  }

  getJob(propertyId: string, id: string) {
    return this.db.tx(async (q) => {
      await this.expireStale(q, propertyId);
      return this.job(q, propertyId, id);
    });
  }

  /** Staff saw the alert and dealt with it (for example, read the order to the kitchen). */
  async acknowledge(propertyId: string, id: string) {
    return this.db.tx(async (q) => {
      const { rowCount } = await q.query(
        `UPDATE print_jobs SET acknowledged_at = now(), acknowledged_by = $3 WHERE property_id = $1 AND id = $2 AND status = 'failed' AND acknowledged_at IS NULL`,
        [propertyId, id, actorId()],
      );
      if (!rowCount) throw conflict('This print job is not a failure waiting for attention', 'not_failed');
      return this.job(q, propertyId, id);
    });
  }

  /** Prints a failed job again, on the same printer or another one; the alert is closed. */
  async retry(propertyId: string, id: string, printerId?: string) {
    return this.db.tx(async (q) => {
      const { rows: [old] } = await q.query<{ printerId: string; status: string }>(
        `SELECT printer_id AS "printerId", status FROM print_jobs WHERE property_id = $1 AND id = $2 FOR UPDATE`,
        [propertyId, id],
      );
      if (!old) throw new NotFoundException('Print job not found at this property');
      if (old.status !== 'failed') throw conflict('Only a failed print can be sent again', 'not_failed');
      const target = printerId ?? old.printerId;
      const printer = await this.printer(q, propertyId, target);
      if (!printer.isActive) throw conflict(`${printer.name} is switched off in YeaStay`, 'printer_inactive');
      const { rows: [copy] } = await q.query<{ id: string }>(
        `INSERT INTO print_jobs (property_id, printer_id, kind, title, payload, ticket_id, check_id, outlet_id, requested_by)
         SELECT property_id, $3, kind, title, payload, ticket_id, check_id, outlet_id, $4 FROM print_jobs WHERE property_id = $1 AND id = $2
         RETURNING id`,
        [propertyId, id, target, actorId()],
      );
      await q.query(
        `UPDATE print_jobs SET replaced_by = coalesce(replaced_by, $3), acknowledged_at = coalesce(acknowledged_at, now()), acknowledged_by = coalesce(acknowledged_by, $4)
          WHERE property_id = $1 AND id = $2`,
        [propertyId, id, copy.id, actorId()],
      );
      return this.job(q, propertyId, copy.id);
    });
  }

  // -------------------------------------------------------------------------
  // Bridge side
  // -------------------------------------------------------------------------

  /** The oldest due job for this property, with its printer; also the bridge's heartbeat. */
  async claim(propertyId: string, hello: { bridgeId: string; version: string; mode: 'live' | 'mock' }) {
    return this.db.tx(async (q) => {
      await q.query(`UPDATE pos_bridges SET last_seen_at = now(), bridge_id = $2, version = $3, mode = $4 WHERE property_id = $1`, [
        propertyId, hello.bridgeId, hello.version, hello.mode,
      ]);
      await this.expireStale(q, propertyId);
      const { rows } = await q.query<{
        id: string; title: string; payload: string; attempts: number; connection: string; host: string | null; port: number; windowsName: string | null; printer: string;
      }>(
        `UPDATE print_jobs j SET status = 'printing', attempts = j.attempts + 1, claimed_by = $2, claim_expires_at = now() + make_interval(secs => $3)
           FROM pos_printers p
          WHERE j.id = (SELECT id FROM print_jobs WHERE property_id = $1 AND status = 'queued' AND next_attempt_at <= now()
                         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
            AND p.id = j.printer_id
          RETURNING j.id, j.title, j.payload, j.attempts, p.connection, p.host, p.port, p.windows_name AS "windowsName", p.name AS printer`,
        [propertyId, hello.bridgeId, PRINT_LEASE_SECONDS],
      );
      const j = rows[0];
      if (!j) return { job: null };
      return {
        job: {
          id: j.id, title: j.title, attempt: j.attempts, payloadBase64: j.payload,
          printer: { name: j.printer, connection: j.connection, host: j.host, port: j.port, windowsName: j.windowsName },
        },
      };
    });
  }

  async complete(propertyId: string, id: string, bridgeId: string, result: PrintResult) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `SELECT id FROM print_jobs WHERE property_id = $1 AND id = $2 AND status = 'printing' AND claimed_by = $3 FOR UPDATE`,
        [propertyId, id, bridgeId],
      );
      if (!rows[0]) throw conflict('This job is not being printed by this bridge (it timed out or was already reported)', 'not_claimed');
      if (result.outcome === 'printed') {
        await q.query(
          `UPDATE print_jobs SET status = 'printed', printed_at = now(), claimed_by = NULL, claim_expires_at = NULL WHERE id = $1`,
          [id],
        );
      } else {
        await this.failTry(q, propertyId, id, result.error || 'The printer did not take the job.');
      }
      const { rows: [s] } = await q.query<{ status: string }>('SELECT status FROM print_jobs WHERE id = $1', [id]);
      return { id, status: s.status };
    });
  }
}
