import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Money } from '@hotel/shared';
import { createTransport, Transporter } from 'nodemailer';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService, Queryable } from '../db/db.service';
import { requestContext, SYSTEM_SCOPE } from '../db/request-context';
import { toPdf } from '../reports/pdf';
import { documentReport } from './document-pdf';
import { esc } from './render';
import { RatesService } from './rates.service';
import { ReservationsService } from './reservations.service';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MAX_ATTEMPTS = 8;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Guest emails (client request, 5 Nov 2026). A booking confirmation carries
 * the reservation details, the hotel's policies, the pro forma and any
 * receipts as PDF attachments.
 *
 * Messages go through a durable outbox: the row is written in the same
 * transaction as the action that caused it, each message has an idempotency
 * key so it is never queued twice (§9), and a background sender delivers it
 * over SMTP with retries and backoff. Without SMTP_URL nothing is sent and
 * the reservation screen shows the message as waiting.
 */
@Injectable()
export class EmailService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Email');
  private timer: NodeJS.Timeout | null = null;
  private transport: Transporter | null = null;
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly reservations: ReservationsService,
    private readonly rates: RatesService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get configured(): boolean {
    return !!this.config.SMTP_URL;
  }

  onModuleInit(): void {
    if (this.config.SMTP_URL) this.transport = createTransport(this.config.SMTP_URL);
    if (this.transport && this.config.EMAIL_SENDER_ENABLED) {
      this.timer = setInterval(() => void this.sendDue().catch((err) => this.log.error(`Email sender: ${(err as Error).message}`)), 15_000);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Lets tests (and a future admin tool) use another transport, e.g. nodemailer's stream transport. */
  useTransport(transport: Transporter | null): void {
    this.transport = transport;
  }

  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------

  /**
   * Queues the booking confirmation. `key` makes it idempotent: the automatic
   * confirmation uses one fixed key per reservation, a resend uses the
   * request's Idempotency-Key. Returns the outbox row, or null when the guest
   * has no email address and none was given.
   */
  async queueBookingConfirmation(propertyId: string, reservationId: string, key: string, to?: string | null) {
    return this.db.tx(async (q) => {
      const r = (await this.reservations.detail(q, propertyId, reservationId)) as Json;
      const address = (to ?? r.booker?.email ?? '').trim();
      if (!address) return null;
      if (!EMAIL_RE.test(address)) throw new BadRequestException(`${address} is not a valid email address`);
      const live = (r.stays as Json[]).filter((s) => !['cancelled', 'no_show'].includes(s.status));
      if (!live.length) throw new BadRequestException('Every stay on this booking is cancelled; there is nothing to confirm');

      const existing = await q.query('SELECT id FROM email_outbox WHERE idempotency_key = $1', [key]);
      if (existing.rows[0]) return this.message(q, existing.rows[0].id);

      const proforma = await this.currentProforma(q, propertyId, reservationId, r.total);
      const { rows: receipts } = await q.query<{ id: string; number: string; total: string }>(
        `SELECT d.id, d.number, d.total::text AS total FROM documents d
          WHERE d.document_type = 'RECEIPT' AND d.folio_id IN (SELECT id FROM folios WHERE reservation_id = $1)
          ORDER BY d.issued_at`,
        [reservationId],
      );
      const policy = await this.rates.policy(q, propertyId);
      const { rows: [property] } = await q.query<Json>(
        `SELECT name, location, address, contact_phone AS phone, contact_email AS email FROM properties WHERE id = $1`,
        [propertyId],
      );
      const html = bookingConfirmationHtml({
        property, reservation: r, policy: { ...(r.policy ?? {}), hotelPolicies: r.policy?.hotelPolicies || policy.hotelPolicies },
        proformaNumber: proforma.number, receipts,
      });
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO email_outbox (property_id, idempotency_key, kind, reservation_id, to_address, subject, html, attachments, created_by)
         VALUES ($1, $2, 'booking_confirmation', $3, $4, $5, $6, $7, $8)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [
          propertyId, key, reservationId, address, `Booking confirmation ${r.number} · ${property.name}`, html,
          [proforma.id, ...receipts.map((d) => d.id)], requestContext.get()?.user?.id ?? null,
        ],
      );
      const id = rows[0]?.id ?? (await q.query('SELECT id FROM email_outbox WHERE idempotency_key = $1', [key])).rows[0].id;
      await this.audit.record({
        action: 'email.queued', entityType: 'reservation', entityId: reservationId, propertyId,
        newValues: { to: address, kind: 'booking_confirmation', proforma: proforma.number, receipts: receipts.map((d) => d.number) },
      });
      return this.message(q, id);
    });
  }

  /** The latest pro forma if it still matches the booking total; otherwise a new one. */
  private async currentProforma(q: Queryable, propertyId: string, reservationId: string, total: string) {
    const { rows } = await q.query<{ id: string; number: string; total: string }>(
      `SELECT id, number, total::text AS total FROM documents
        WHERE document_type = 'PROFORMA' AND reservation_id = $1 ORDER BY issued_at DESC LIMIT 1`,
      [reservationId],
    );
    if (rows[0] && Money.of(rows[0].total).equals(total)) return rows[0];
    return this.reservations.proforma(propertyId, reservationId);
  }

  private async message(q: Queryable, id: string) {
    const { rows } = await q.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [id]);
    return rows[0];
  }

  async list(propertyId: string, reservationId: string) {
    const { rows } = await this.db.query(`${MESSAGE_SELECT} WHERE m.property_id = $1 AND m.reservation_id = $2 ORDER BY m.created_at DESC`, [
      propertyId, reservationId,
    ]);
    return { configured: this.configured, messages: rows };
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  /** Sends what is due. Each message is claimed with SKIP LOCKED so two API instances never send the same one. */
  async sendDue(limit = 10): Promise<{ sent: number; failed: number }> {
    if (!this.transport || this.running) return { sent: 0, failed: 0 };
    this.running = true;
    let sent = 0;
    let failed = 0;
    try {
      for (let i = 0; i < limit; i++) {
        const msg: Json | null = await this.db.tx(async (q): Promise<Json | null> => {
          const { rows } = await q.query<Json>(
            `UPDATE email_outbox SET status = 'sending', attempts = attempts + 1
              WHERE id = (SELECT id FROM email_outbox
                           WHERE (status IN ('pending', 'failed') AND next_attempt_at <= now())
                              OR (status = 'sending' AND updated_at < now() - interval '10 minutes')
                           ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1)
              RETURNING id, to_address AS "to", subject, html, attachments, attempts, idempotency_key AS "key"`,
          );
          if (!rows[0]) return null;
          const { rows: docs } = await q.query<Json>(
            `SELECT id, document_type AS "documentType", number, content FROM documents WHERE id = ANY($1::uuid[])`,
            [rows[0].attachments],
          );
          return { ...rows[0], docs };
        }, SYSTEM_SCOPE);
        if (!msg) break;
        try {
          const attachments = [];
          for (const d of msg.docs as Json[]) {
            attachments.push({ filename: `${d.number}.pdf`, content: await toPdf(documentReport(d as never)), contentType: 'application/pdf' });
          }
          await this.transport.sendMail({
            from: this.config.MAIL_FROM,
            to: msg.to,
            subject: msg.subject,
            html: msg.html,
            attachments,
            headers: { 'X-YeaStay-Message': msg.key },
          });
          await this.db.tx((q) => q.query(`UPDATE email_outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`, [msg.id]), SYSTEM_SCOPE);
          sent++;
        } catch (err) {
          const dead = msg.attempts >= MAX_ATTEMPTS;
          await this.db.tx(
            (q) =>
              q.query(
                `UPDATE email_outbox SET status = $2, last_error = $3,
                        next_attempt_at = now() + make_interval(mins => $4) WHERE id = $1`,
                [msg.id, dead ? 'dead' : 'failed', String((err as Error).message).slice(0, 500), Math.min(2 ** msg.attempts, 240)],
              ),
            SYSTEM_SCOPE,
          );
          this.log.warn(`Email ${msg.id} to ${msg.to} failed (attempt ${msg.attempts}): ${(err as Error).message}`);
          failed++;
        }
      }
    } finally {
      this.running = false;
    }
    return { sent, failed };
  }
}

const MESSAGE_SELECT = `
  SELECT m.id, m.kind, m.to_address AS "to", m.subject, m.status, m.attempts, m.last_error AS "lastError",
         m.sent_at AS "sentAt", m.created_at AS "createdAt", u.display_name AS "createdBy",
         (SELECT coalesce(array_agg(d.number ORDER BY d.issued_at), '{}') FROM documents d WHERE d.id = ANY(m.attachments)) AS attachments
    FROM email_outbox m LEFT JOIN users u ON u.id = m.created_by`;

const money = (v: unknown) => Money.of(String(v ?? '0')).format();

/** The confirmation body: plain inline-styled HTML that mail clients render consistently. */
export function bookingConfirmationHtml(d: { property: Json; reservation: Json; policy: Json; proformaNumber: string; receipts: Array<{ number: string; total: string }> }): string {
  const r = d.reservation;
  const p = d.policy;
  const stays = (r.stays as Json[]).filter((s) => !['cancelled', 'no_show'].includes(s.status));
  const td = 'padding:6px 8px;border-bottom:1px solid #d5e1e2;text-align:left;vertical-align:top';
  const th = `${td};font-size:11px;text-transform:uppercase;color:#4f6264`;
  const rows = stays
    .map(
      (s) => `<tr><td style="${td}">${esc(s.roomTypeName)}${s.roomNumber ? `, room ${esc(s.roomNumber)}` : ''}</td><td style="${td}">${esc(s.arrivalDate)}</td><td style="${td}">${esc(s.departureDate)}</td><td style="${td}">${(s.nights as Json[]).length}</td><td style="${td}">${esc(s.adults)}${Number(s.children) ? ` + ${esc(s.children)}` : ''}</td><td style="${td};text-align:right">${money(s.total)}</td></tr>`,
    )
    .join('');
  const block = (title: string, text: unknown) =>
    text ? `<h3 style="margin:18px 0 6px;color:#0e4d52;font-size:15px">${esc(title)}</h3><div style="white-space:pre-line;font-size:13px">${esc(text)}</div>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f3f6f6">
<div style="max-width:640px;margin:0 auto;background:#fff;font:14px/1.5 Outfit,Segoe UI,Arial,sans-serif;color:#0b2e31">
<div style="background:#0e4d52;color:#fff;padding:18px 24px"><div style="font-size:20px;font-weight:600">${esc(d.property.name)}</div><div style="opacity:.85">${esc(d.property.address || d.property.location || '')}</div></div>
<div style="padding:20px 24px">
<p>Dear ${esc(r.booker?.name ?? 'guest')},</p>
<p>Thank you for booking with ${esc(d.property.name)}. Your booking reference is <strong>${esc(r.number)}</strong>.</p>
<table style="width:100%;border-collapse:collapse;margin:12px 0"><thead><tr><th style="${th}">Room</th><th style="${th}">Arrival</th><th style="${th}">Departure</th><th style="${th}">Nights</th><th style="${th}">Guests</th><th style="${th};text-align:right">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<table style="margin-left:auto;border-collapse:collapse">
<tr><td style="padding:3px 8px">Total</td><td style="padding:3px 8px;text-align:right;font-weight:600">${money(r.total)}</td></tr>
<tr><td style="padding:3px 8px">Deposit required</td><td style="padding:3px 8px;text-align:right">${money(r.deposit?.required)}${r.deposit?.dueDate ? ` by ${esc(r.deposit.dueDate)}` : ''}</td></tr>
<tr><td style="padding:3px 8px">Deposit received</td><td style="padding:3px 8px;text-align:right">${money(r.deposit?.received)}</td></tr>
</table>
<p style="font-size:13px">Check-in from ${esc(p.checkInTime ?? '')}, check-out by ${esc(p.checkOutTime ?? '')}. Prices include VAT and catering levy.</p>
<p style="font-size:13px">Attached: pro forma invoice ${esc(d.proformaNumber)}${d.receipts.length ? ` and receipt${d.receipts.length > 1 ? 's' : ''} ${d.receipts.map((x) => esc(x.number)).join(', ')}` : ''}.</p>
${block('Cancellation and refunds', [p.freeCancellationHours !== undefined ? `Free cancellation up to ${p.freeCancellationHours} hours before arrival.` : '', p.refundPolicy].filter(Boolean).join('\n'))}
${block('Hotel policies', p.hotelPolicies)}
<p style="margin-top:20px">We look forward to welcoming you.${d.property.phone || d.property.email ? ` For any changes, contact us on ${esc([d.property.phone, d.property.email].filter(Boolean).join(' or '))}.` : ''}</p>
</div>
<div style="padding:10px 24px;font-size:11px;color:#4f6264;text-align:center">Powered by YeaStay</div>
</div></body></html>`;
}
