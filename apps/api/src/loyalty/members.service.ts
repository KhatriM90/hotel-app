import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { hasPermission, isMemberNumber, maskPhone, parseMemberQr, pointsValue } from '@hotel/shared';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import Decimal from 'decimal.js';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { requestContext, SYSTEM_SCOPE } from '../db/request-context';
import { ApprovalsService } from '../frontoffice/approvals.service';
import { ApprovalInputT, conflict } from '../frontoffice/common';
import { actorId } from '../pos/common';
import { LoyaltyLedgerService, MEMBER_COLUMNS, MemberRow } from './ledger.service';
import { LoyaltyProgrammeService } from './programme.service';

export interface EnrolInput {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string | null;
  guestId?: string | null;
  companyId?: string | null;
  kind?: 'individual' | 'corporate';
  adultConfirmed: boolean;
  programmeAccepted: boolean;
  marketingConsent?: boolean;
  channel: 'reception' | 'pos' | 'self' | 'import';
  outletCode?: string | null;
  confirmNotDuplicate?: boolean;
}

const LOOKUPS_PER_MINUTE = 30;

function token(): string {
  return randomBytes(18).toString('base64url');
}

function hashCode(id: string, code: string): string {
  return createHash('sha256').update(`${id}:${code}`).digest('hex');
}

/**
 * Members (LOY11, LOY15, LOY23, LOY24, LOY28): enrolment, lookup by number,
 * card QR or phone, verification before redemption, corrections, merges and
 * anonymisation. POS staff see a masked summary; reception and managers see
 * the full profile.
 */
@Injectable()
export class LoyaltyMembersService {
  private readonly lookups = new Map<string, number[]>();

  constructor(
    private readonly db: DbService,
    private readonly ledger: LoyaltyLedgerService,
    private readonly programme: LoyaltyProgrammeService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  private roles(): string[] {
    return requestContext.get()?.user?.roles ?? [];
  }

  private fullAccess(): boolean {
    return hasPermission(this.roles(), 'loyalty.read');
  }

  /** LOY15: lookups and verification attempts are rate limited per user. */
  private throttle(kind: string): void {
    const key = `${kind}:${actorId() ?? 'anon'}`;
    const now = Date.now();
    const recent = (this.lookups.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= LOOKUPS_PER_MINUTE) {
      throw new HttpException({ statusCode: 429, error: 'rate_limited', message: 'Too many member lookups; wait a minute and try again' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.lookups.set(key, recent);
  }

  // -------------------------------------------------------------------------
  // Enrolment (LOY11, LOY28)
  // -------------------------------------------------------------------------

  async enrol(propertyId: string, input: EnrolInput) {
    if (!input.programmeAccepted) throw new BadRequestException('The guest must accept the programme terms to join');
    if (!input.adultConfirmed) throw new BadRequestException('Members must be 18 or over (LOY24)');
    return this.db.tx(async (q) => {
      const digits = input.phone.replace(/\D/g, '');
      if (!input.confirmNotDuplicate) {
        const { rows: dupes } = await q.query<{ number: string; displayName: string }>(
          `SELECT number, display_name AS "displayName" FROM loyalty_members
            WHERE status IN ('active', 'suspended') AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = right($1, 9) LIMIT 5`,
          [digits],
        );
        if (dupes.length) {
          throw conflict(`A member already uses this phone: ${dupes.map((d) => d.number).join(', ')}. Look them up, or confirm this is a different person.`, 'possible_duplicate', {
            members: this.fullAccess() ? dupes : dupes.map((d) => ({ number: d.number })),
          });
        }
      }
      let outletId: string | null = null;
      if (input.outletCode) {
        const { rows } = await q.query<{ id: string }>('SELECT id FROM outlets WHERE property_id = $1 AND code = $2', [propertyId, input.outletCode.toUpperCase()]);
        outletId = rows[0]?.id ?? null;
      }
      let guestId = input.guestId ?? null;
      if (guestId) {
        const { rows } = await q.query<{ number: string }>(
          `SELECT number FROM loyalty_members WHERE guest_id = $1 AND status NOT IN ('merged', 'anonymised')`,
          [guestId],
        );
        if (rows[0]) throw conflict(`This guest is already member ${rows[0].number}`, 'already_member', { number: rows[0].number });
      } else {
        // Walk-in customers get a guest profile too, so one person has one record (LOY11).
        const { rows: [g] } = await q.query<{ id: string }>(
          `INSERT INTO guests (first_name, last_name, phone, email, company_id, marketing_consent_at, created_by)
           VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END, $7) RETURNING id`,
          [input.firstName.trim(), input.lastName.trim(), input.phone.trim(), input.email?.trim() || null, input.companyId ?? null, !!input.marketingConsent, actorId()],
        );
        guestId = g.id;
      }
      const { rows: [seq] } = await q.query<{ n: string }>(`SELECT nextval('loyalty_member_seq')::text AS n`);
      const number = `YS${seq.n}`;
      const kind = input.kind ?? 'individual';
      const { rows: [m] } = await q.query<{ id: string }>(
        `INSERT INTO loyalty_members (number, kind, guest_id, company_id, display_name, phone, email, qr_token, self_token, programme_accepted_at,
                                      marketing_consent_at, adult_confirmed, enrolled_property_id, enrolled_outlet_id, enrolment_channel, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), CASE WHEN $10 THEN now() END, true, $11, $12, $13, $14) RETURNING id`,
        [number, kind, guestId, input.companyId ?? null, `${input.firstName.trim()} ${input.lastName.trim()}`, input.phone.trim(),
         input.email?.trim() || null, token(), token(), !!input.marketingConsent, propertyId, outletId, input.channel, actorId()],
      );
      await this.audit.record({
        action: 'loyalty.member_enrolled', entityType: 'loyalty_member', entityId: m.id, propertyId,
        newValues: { number, channel: input.channel, kind, marketingConsent: !!input.marketingConsent },
      });
      return this.view(q, m.id);
    });
  }

  // -------------------------------------------------------------------------
  // Lookup and profile (LOY11, LOY15)
  // -------------------------------------------------------------------------

  /** By member number, card QR, phone, or (reception and managers) name. */
  async lookup(query: string) {
    this.throttle('lookup');
    const term = query.trim();
    if (term.length < 3) throw new BadRequestException('Type a member number, scan the card, or enter at least 3 characters');
    return this.db.tx(async (q) => {
      const qr = parseMemberQr(term);
      let rows: MemberRow[];
      if (qr) {
        rows = (await q.query<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM loyalty_members WHERE number = $1 AND qr_token = $2`, [qr.number, qr.token])).rows;
      } else if (isMemberNumber(term)) {
        rows = (await q.query<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM loyalty_members WHERE number = $1`, [term.toUpperCase()])).rows;
      } else if (/^\+?[\d ]{7,}$/.test(term)) {
        const digits = term.replace(/\D/g, '');
        rows = (
          await q.query<MemberRow>(
            `SELECT ${MEMBER_COLUMNS} FROM loyalty_members WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = right($1, 9) ORDER BY number LIMIT 10`,
            [digits],
          )
        ).rows;
      } else if (this.fullAccess()) {
        rows = (
          await q.query<MemberRow>(
            `SELECT ${MEMBER_COLUMNS} FROM loyalty_members WHERE lower(display_name) LIKE $1 ORDER BY display_name LIMIT 20`,
            [`%${term.toLowerCase().replace(/[%_\\]/g, '')}%`],
          )
        ).rows;
      } else {
        throw new BadRequestException('Search by member number, card or phone number');
      }
      const out = [];
      for (const r of rows.filter((x) => x.status !== 'merged' || !qr)) out.push(await this.summary(q, r, !!qr));
      return out;
    });
  }

  /** What the POS needs: identity hidden to a first name and initial, balances and club benefit (LOY15). */
  async summary(q: Queryable, m: MemberRow, cardScanned = false) {
    const full = this.fullAccess();
    const [first, ...rest] = m.displayName.split(' ');
    const balances = await this.ledger.balances(q, m.id);
    const { settings } = await this.programme.current(q);
    const club = await this.programme.clubRates(q, m.id, new Date().toISOString(), settings);
    return {
      id: m.id,
      number: m.number,
      kind: m.kind,
      name: full ? m.displayName : `${first}${rest.length ? ` ${rest[rest.length - 1][0]}.` : ''}`,
      phone: full ? m.phone : maskPhone(m.phone),
      status: m.status,
      mergedInto: m.mergedIntoId,
      staffFlagged: m.staffFlagged,
      cardScanned,
      points: {
        available: balances.points.available,
        value: pointsValue(Math.max(0, Number(balances.points.available)), settings.points.pointValue),
        reserved: balances.points.reserved,
        pendingEligible: balances.points.pendingEligible,
        expiring: balances.points.expiring[0] ?? null,
        deficit: balances.points.deficit,
      },
      wallet: {
        available: balances.wallet.available,
        reserved: balances.wallet.reserved,
        pendingCashback: balances.wallet.pendingCashback,
        expiring: balances.wallet.expiring[0] ?? null,
        deficit: balances.wallet.deficit,
      },
      club: club ? { tier: club.tierCode, discountPercent: club.discountPercent, cashbackPercent: club.cashbackPercent } : null,
    };
  }

  async get(memberId: string) {
    return this.db.tx((q) => this.view(q, memberId));
  }

  async view(q: Queryable, memberId: string) {
    await this.ledger.expireDue(q, memberId);
    const m = await this.ledger.member(q, memberId);
    const summary = await this.summary(q, m);
    if (!this.fullAccess()) return summary;
    const { rows: [p] } = await q.query(
      `SELECT m.email, m.phone_verified_at AS "phoneVerifiedAt", m.programme_accepted_at AS "programmeAcceptedAt",
              m.marketing_consent_at AS "marketingConsentAt", m.enrolment_channel AS "enrolmentChannel", m.created_at AS "enrolledAt",
              p.name AS "enrolledAt_property", c.name AS company, m.company_id AS "companyId", m.guest_id AS "guestId", su.username AS "staffUsername",
              m.qr_token AS "qrToken", m.self_token AS "selfToken", m.anonymised_at AS "anonymisedAt"
         FROM loyalty_members m LEFT JOIN properties p ON p.id = m.enrolled_property_id LEFT JOIN companies c ON c.id = m.company_id
         LEFT JOIN users su ON su.id = m.staff_user_id WHERE m.id = $1`,
      [memberId],
    );
    const balances = await this.ledger.balances(q, memberId);
    const { rows: [club] } = await q.query(
      `SELECT cm.tier_code AS "tierCode", t.name AS "tierName", cm.status, cm.starts_on AS "startsOn", cm.ends_on AS "endsOn"
         FROM club_memberships cm JOIN club_tiers t ON t.code = cm.tier_code WHERE cm.member_id = $1`,
      [memberId],
    );
    const { rows: overrides } = await q.query(
      `SELECT o.discount_percent::text AS "discountPercent", o.cashback_percent::text AS "cashbackPercent", o.effective_from AS "effectiveFrom",
              o.effective_to AS "effectiveTo", o.reason, u.display_name AS "approvedBy"
         FROM club_rate_overrides o JOIN approvals a ON a.id = o.approval_id LEFT JOIN users u ON u.id = a.approved_by
        WHERE o.member_id = $1 ORDER BY o.created_at DESC`,
      [memberId],
    );
    const { rows: merged } = await q.query(`SELECT number, display_name AS "displayName" FROM loyalty_members WHERE merged_into_id = $1`, [memberId]);
    const { qrToken, selfToken, ...profile } = p;
    return {
      ...summary,
      profile,
      balances,
      clubMembership: club ?? null,
      overrides,
      mergedFrom: merged,
      card: { qr: `YS:${m.number}:${qrToken}` },
      selfServicePath: `/api/loyalty/m/${selfToken}`,
    };
  }

  /**
   * Member history (LOY17). Group roles see every property; others see the
   * events at their own properties, while the balance stays group-wide (LAT12).
   */
  async history(memberId: string, unit?: string) {
    // Property codes for every event, including those at properties the caller cannot open.
    const { rows: props } = await this.db.tx((q) => q.query<{ id: string; code: string }>('SELECT id, code FROM properties'), SYSTEM_SCOPE);
    const code = (id: string | null) => props.find((p) => p.id === id)?.code ?? null;
    return this.db.tx(async (q) => {
      const ctx = requestContext.get();
      const all = ctx?.user?.allProperties ?? false;
      const ids = [...(ctx?.user?.propertyIds ?? [])];
      const { rows } = await q.query(
        `SELECT e.id::text, e.created_at AS "at", e.unit, e.type, e.amount::text, e.value::text, e.property_id AS "propertyId", o.name AS outlet,
                e.business_date AS "businessDate", c.number AS "checkNumber", f.number AS "folioNumber", r.number AS "returnNumber",
                e.reason, u.display_name AS actor, v.version AS "programmeVersion", e.details,
                ($3 OR e.property_id IS NULL OR e.property_id = ANY($4::uuid[])) AS visible
           FROM loyalty_events e LEFT JOIN outlets o ON o.id = e.outlet_id
           LEFT JOIN pos_checks c ON c.id = e.check_id LEFT JOIN folios f ON f.id = e.folio_id LEFT JOIN pos_returns r ON r.id = e.return_id
           LEFT JOIN users u ON u.id = e.actor LEFT JOIN loyalty_programme_versions v ON v.id = e.programme_version_id
          WHERE (e.member_id = $1 OR e.member_id IN (SELECT id FROM loyalty_members WHERE merged_into_id = $1))
            AND ($2::text IS NULL OR e.unit = $2)
          ORDER BY e.id DESC LIMIT 500`,
        [memberId, unit ?? null, all, ids],
      );
      const { rows: pending } = await q.query(
        `SELECT lp.id, lp.source, lp.status, lp.eligible_amount::text AS "eligibleAmount", lp.cashback_percent::text AS "cashbackPercent", lp.sale_date AS "saleDate",
                lp.property_id AS "propertyId", c.number AS "checkNumber", f.number AS "folioNumber"
           FROM loyalty_pending lp LEFT JOIN pos_checks c ON c.id = lp.check_id
           LEFT JOIN folios f ON f.id = lp.folio_id
          WHERE lp.member_id = $1 ORDER BY lp.created_at DESC LIMIT 100`,
        [memberId],
      );
      const { rows: accruals } = await q.query(
        `SELECT a.id::text, a.kind, a.sale_date AS "saleDate", a.settlement_month AS "settlementMonth", a.eligible_amount::text AS "eligibleAmount",
                a.rate_percent::text AS "ratePercent", a.rate_source AS "rateSource", a.property_id AS "propertyId", c.number AS "checkNumber", f.number AS "folioNumber"
           FROM cashback_accruals a LEFT JOIN pos_checks c ON c.id = a.check_id LEFT JOIN folios f ON f.id = a.folio_id
          WHERE a.member_id = $1 ORDER BY a.id DESC LIMIT 200`,
        [memberId],
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const withCode = ({ propertyId, ...r }: Record<string, any>): Record<string, any> => ({ ...r, property: code(propertyId) });
      return {
        events: rows.map(withCode).map((r) => (r.visible ? r : { id: r.id, at: r.at, unit: r.unit, type: r.type, amount: r.amount, property: r.property, visible: false })),
        pending: pending.map(withCode),
        cashback: accruals.map(withCode),
      };
    });
  }

  async update(propertyId: string, memberId: string, input: { phone?: string; email?: string | null; marketingConsent?: boolean; status?: 'active' | 'suspended' | 'closed' }) {
    return this.db.tx(async (q) => {
      const before = await this.ledger.lockMember(q, memberId);
      if (['merged', 'anonymised'].includes(before.status)) throw conflict(`Member ${before.number} is ${before.status}`, 'member_final');
      await q.query(
        `UPDATE loyalty_members SET phone = coalesce($2, phone), phone_verified_at = CASE WHEN $2 IS NOT NULL AND $2 <> coalesce(phone, '') THEN NULL ELSE phone_verified_at END,
                email = CASE WHEN $3 THEN $4 ELSE email END,
                marketing_consent_at = CASE WHEN $5::boolean IS NULL THEN marketing_consent_at WHEN $5 THEN coalesce(marketing_consent_at, now()) ELSE NULL END,
                status = coalesce($6, status)
          WHERE id = $1`,
        [memberId, input.phone ?? null, input.email !== undefined, input.email ?? null, input.marketingConsent ?? null, input.status ?? null],
      );
      await this.audit.record({ action: 'loyalty.member_updated', entityType: 'loyalty_member', entityId: memberId, propertyId, previousValues: { phone: before.phone, status: before.status }, newValues: input });
      return this.view(q, memberId);
    });
  }

  // -------------------------------------------------------------------------
  // Verification before redemption (LOY13, LOY22)
  // -------------------------------------------------------------------------

  async requestOtp(propertyId: string, memberId: string, input: { purpose: 'redeem' | 'enrol'; checkId?: string | null }) {
    this.throttle('otp');
    return this.db.tx(async (q) => {
      const m = await this.ledger.member(q, memberId);
      if (m.status !== 'active') throw conflict(`Member ${m.number} is ${m.status}`, 'member_inactive');
      if (!m.phone) throw conflict('The member has no registered phone; scan the member card instead', 'no_phone');
      const { settings } = await this.programme.current(q);
      if (settings.verification.otpDelivery === 'sms') {
        throw new ServiceUnavailableException({ statusCode: 503, error: 'sms_not_configured', message: 'No SMS gateway is set up yet; scan the member card instead' });
      }
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const { rows: [v] } = await q.query<{ id: string; expiresAt: string }>(
        `INSERT INTO loyalty_verifications (member_id, method, code_hash, expires_at, property_id, check_id, purpose, created_by)
         VALUES ($1, 'otp', 'pending', now() + make_interval(mins => $2), $3, $4, $5, $6) RETURNING id, expires_at AS "expiresAt"`,
        [memberId, settings.verification.otpMinutes, propertyId, input.checkId ?? null, input.purpose, actorId()],
      );
      await q.query('UPDATE loyalty_verifications SET code_hash = $2 WHERE id = $1', [v.id, hashCode(v.id, code)]);
      return {
        verificationId: v.id,
        expiresAt: v.expiresAt,
        sentTo: maskPhone(m.phone),
        // Demo only: no SMS gateway yet, so the code is shown to staff and marked as such.
        demoCode: settings.verification.otpDelivery === 'screen' ? code : undefined,
      };
    });
  }

  async verifyOtp(verificationId: string, code: string) {
    this.throttle('verify');
    return this.db.tx(async (q) => {
      const { rows: [v] } = await q.query<{ id: string; memberId: string; codeHash: string; attempts: number; expired: boolean; verifiedAt: string | null; purpose: string }>(
        `SELECT id, member_id AS "memberId", code_hash AS "codeHash", attempts, expires_at < now() AS expired, verified_at AS "verifiedAt", purpose
           FROM loyalty_verifications WHERE id = $1 AND method = 'otp' FOR UPDATE`,
        [verificationId],
      );
      if (!v) throw new NotFoundException('Verification not found');
      if (v.verifiedAt) return { verificationId: v.id, verified: true };
      const { settings } = await this.programme.current(q);
      if (v.expired) throw conflict('The code has expired; send a new one', 'otp_expired');
      if (v.attempts >= settings.verification.maxAttempts) throw conflict('Too many wrong codes; send a new one', 'otp_locked');
      const good = timingSafeEqual(Buffer.from(hashCode(v.id, code.trim())), Buffer.from(v.codeHash));
      if (!good) {
        await q.query('UPDATE loyalty_verifications SET attempts = attempts + 1 WHERE id = $1', [v.id]);
        // Commit the attempt count even though the answer is a refusal.
        return { verificationId: v.id, verified: false, attemptsLeft: settings.verification.maxAttempts - v.attempts - 1 };
      }
      await q.query('UPDATE loyalty_verifications SET verified_at = now() WHERE id = $1', [v.id]);
      await q.query('UPDATE loyalty_members SET phone_verified_at = coalesce(phone_verified_at, now()) WHERE id = $1', [v.memberId]);
      return { verificationId: v.id, verified: true };
    });
  }

  /** Scanning the member card's QR code verifies the member in one step (LOY22, LOY28). */
  async verifyQr(propertyId: string, memberId: string, qrPayload: string, checkId?: string | null) {
    this.throttle('verify');
    return this.db.tx(async (q) => {
      const qr = parseMemberQr(qrPayload);
      const { rows } = await q.query<{ id: string }>(`SELECT id FROM loyalty_members WHERE id = $1 AND number = $2 AND qr_token = $3`, [
        memberId,
        qr?.number ?? '',
        qr?.token ?? '',
      ]);
      if (!rows[0]) throw new ForbiddenException({ statusCode: 403, error: 'qr_mismatch', message: 'That card does not belong to this member' });
      const { rows: [v] } = await q.query<{ id: string }>(
        `INSERT INTO loyalty_verifications (member_id, method, expires_at, verified_at, property_id, check_id, purpose, created_by)
         VALUES ($1, 'qr', now() + interval '10 minutes', now(), $2, $3, 'redeem', $4) RETURNING id`,
        [memberId, propertyId, checkId ?? null, actorId()],
      );
      return { verificationId: v.id, verified: true };
    });
  }

  // -------------------------------------------------------------------------
  // Corrections, merges, staff flag and data protection (S23, LOY22, LOY24)
  // -------------------------------------------------------------------------

  async adjust(propertyId: string, memberId: string, input: { unit: 'points' | 'wallet'; amount: string; reason: string; approval?: ApprovalInputT }) {
    return this.db.tx(async (q) => {
      const m = await this.ledger.lockMember(q, memberId);
      if (m.status === 'merged' || m.status === 'anonymised') throw conflict(`Member ${m.number} is ${m.status}`, 'member_final');
      const amount = new Decimal(input.amount);
      if (amount.isZero()) throw new BadRequestException('Enter a non-zero amount');
      if (input.unit === 'points' && !amount.isInteger()) throw new BadRequestException('Points are whole numbers');
      const v = await this.programme.current(q);
      const approvalId = await this.approvals.approve({
        permission: 'approve.loyalty_adjustment', propertyId, action: 'loyalty.adjustment', entityType: 'loyalty_member', entityId: memberId,
        reason: input.reason, approval: input.approval, details: { member: m.number, unit: input.unit, amount: amount.toFixed(input.unit === 'points' ? 0 : 2) },
      });
      const value = input.unit === 'points' ? amount.times(v.settings.points.pointValue).toFixed(2) : amount.toFixed(2);
      const months = input.unit === 'points' ? v.settings.points.expiryMonths : v.settings.club.walletExpiryMonths;
      const { eventId } = await this.ledger.post(q, {
        key: `adjust:${approvalId}`, memberId, unit: input.unit, type: 'adjust', amount: amount.toFixed(2), value, propertyId,
        programmeVersionId: v.id, reason: input.reason, approvalId, lotKind: 'adjustment', expiresAt: this.ledger.expiry(months), allowDeficit: true,
      });
      await this.audit.record({ action: 'loyalty.adjustment', entityType: 'loyalty_member', entityId: memberId, propertyId, reason: input.reason, newValues: { eventId, unit: input.unit, amount: input.amount } });
      return this.view(q, memberId);
    });
  }

  /**
   * Merges a confirmed duplicate into the surviving member (S23, LAT10). Each
   * lot moves with its own expiry and the totals are unchanged; the duplicate
   * keeps its history and points to the survivor.
   */
  async merge(propertyId: string, intoId: string, input: { fromMemberId: string; reason: string; approval?: ApprovalInputT }) {
    if (intoId === input.fromMemberId) throw new BadRequestException('Choose a different member to merge');
    return this.db.tx(async (q) => {
      const [a, b] = [intoId, input.fromMemberId].sort();
      await this.ledger.lockMember(q, a);
      await this.ledger.lockMember(q, b);
      const into = await this.ledger.member(q, intoId);
      const from = await this.ledger.member(q, input.fromMemberId);
      for (const m of [into, from]) if (m.status === 'merged' || m.status === 'anonymised') throw conflict(`Member ${m.number} is ${m.status}`, 'member_final');
      const { rows: active } = await q.query(`SELECT 1 FROM loyalty_reservations WHERE member_id = $1 AND status = 'active' AND expires_at > now()`, [from.id]);
      if (active.length) throw conflict(`${from.number} has points or credit held on an open bill`, 'reserved');
      const { rows: club } = await q.query<{ memberId: string }>(`SELECT member_id AS "memberId" FROM club_memberships WHERE member_id = ANY($1)`, [[from.id, into.id]]);
      if (club.length === 2) throw conflict('Both members are in the club; end one club membership first', 'both_club');
      const approvalId = await this.approvals.approve({
        permission: 'approve.loyalty_merge', propertyId, action: 'loyalty.merge', entityType: 'loyalty_member', entityId: into.id, reason: input.reason,
        approval: input.approval, details: { into: into.number, from: from.number },
      });
      const { rows: lots } = await q.query<{ id: string; unit: 'points' | 'wallet'; kind: string; remaining: string; expiresAt: string | null; propertyId: string | null }>(
        `SELECT id, unit, kind, remaining::text, expires_at AS "expiresAt", property_id AS "propertyId" FROM loyalty_lots
          WHERE member_id = $1 AND remaining <> 0 AND (expires_at IS NULL OR expires_at > now()) ORDER BY expires_at NULLS LAST FOR UPDATE`,
        [from.id],
      );
      const v = await this.programme.current(q);
      for (const [i, lot] of lots.entries()) {
        const amt = new Decimal(lot.remaining);
        const value = lot.unit === 'points' ? amt.times(v.settings.points.pointValue).toFixed(2) : amt.toFixed(2);
        // Out of the duplicate's lot and into a lot with the same expiry on the survivor.
        const out = await this.ledger.post(q, {
          key: `merge:${from.id}:${lot.id}:out`, memberId: from.id, unit: lot.unit, type: 'merge_out', amount: amt.negated().toFixed(2),
          value: new Decimal(value).negated().toFixed(2), propertyId, reason: `Merged into ${into.number}: ${input.reason}`, approvalId,
          // A deficit moves as a pair: paid off here, carried over there.
          details: { lot: i, into: into.number },
        });
        await this.ledger.post(q, {
          key: `merge:${from.id}:${lot.id}:in`, memberId: into.id, unit: lot.unit, type: 'merge_in', amount: amt.toFixed(2), value, propertyId,
          reason: `Merged from ${from.number}: ${input.reason}`, approvalId, lotKind: 'merged', expiresAt: lot.expiresAt, allowDeficit: true,
          originalEventId: out.eventId, details: { from: from.number },
        });
      }
      if (club.length === 1 && club[0].memberId === from.id) await q.query('UPDATE club_memberships SET member_id = $2 WHERE member_id = $1', [from.id, into.id]);
      await q.query(`UPDATE loyalty_members SET status = 'merged', merged_into_id = $2 WHERE id = $1`, [from.id, into.id]);
      await q.query(`UPDATE pos_checks SET loyalty_member_id = $2 WHERE loyalty_member_id = $1 AND status = 'open'`, [from.id, into.id]);
      await this.audit.record({ action: 'loyalty.merge', entityType: 'loyalty_member', entityId: into.id, propertyId, reason: input.reason, newValues: { from: from.number, lots: lots.length } });
      return this.view(q, into.id);
    });
  }

  /** LOY22: link a member account to a staff user, so it never earns on that person's own bills. */
  async flagStaff(propertyId: string, memberId: string, input: { username: string | null; reason: string }) {
    return this.db.tx(async (q) => {
      await this.ledger.lockMember(q, memberId);
      let userId: string | null = null;
      if (input.username) {
        const { rows } = await q.query<{ id: string }>('SELECT id FROM users WHERE lower(username) = lower($1)', [input.username]);
        if (!rows[0]) throw new NotFoundException(`No staff user ${input.username}`);
        userId = rows[0].id;
      }
      await q.query('UPDATE loyalty_members SET staff_user_id = $2, staff_flagged = $3 WHERE id = $1', [memberId, userId, userId !== null]);
      await this.audit.record({ action: 'loyalty.staff_flag', entityType: 'loyalty_member', entityId: memberId, propertyId, reason: input.reason, newValues: { username: input.username } });
      return this.view(q, memberId);
    });
  }

  /** LOY24: on a deletion request the profile is anonymised; the ledger stays for audit and tax. */
  async anonymise(propertyId: string, memberId: string, input: { reason: string; approval?: ApprovalInputT }) {
    return this.db.tx(async (q) => {
      const m = await this.ledger.lockMember(q, memberId);
      if (m.status === 'anonymised') return this.view(q, memberId);
      const approvalId = await this.approvals.approve({
        permission: 'approve.loyalty_adjustment', propertyId, action: 'loyalty.anonymise', entityType: 'loyalty_member', entityId: memberId,
        reason: input.reason, approval: input.approval, details: { member: m.number },
      });
      await q.query(
        `UPDATE loyalty_members SET display_name = 'Anonymised member', phone = NULL, email = NULL, phone_verified_at = NULL, marketing_consent_at = NULL,
                guest_id = NULL, status = 'anonymised', anonymised_at = now(), qr_token = $2, self_token = $3 WHERE id = $1`,
        [memberId, token(), token()],
      );
      await q.query(`UPDATE loyalty_reservations SET status = 'released', resolved_at = now(), release_reason = 'Member anonymised' WHERE member_id = $1 AND status = 'active'`, [memberId]);
      await this.audit.record({ action: 'loyalty.anonymise', entityType: 'loyalty_member', entityId: memberId, propertyId, reason: input.reason, newValues: { approvalId } });
      return { id: memberId, number: m.number, status: 'anonymised' };
    });
  }

  // -------------------------------------------------------------------------
  // Club membership (CLUB01)
  // -------------------------------------------------------------------------

  async setClub(propertyId: string, memberId: string, input: { tierCode: string; status: 'active' | 'suspended' | 'expired'; startsOn: string; endsOn?: string | null; reason: string }) {
    return this.db.tx(async (q) => {
      const m = await this.ledger.lockMember(q, memberId);
      if (m.status !== 'active') throw conflict(`Member ${m.number} is ${m.status}`, 'member_inactive');
      const { rowCount } = await q.query('SELECT 1 FROM club_tiers WHERE code = $1 AND is_active', [input.tierCode]);
      if (!rowCount) throw new NotFoundException(`Club tier ${input.tierCode} not found`);
      const { rows: [before] } = await q.query('SELECT tier_code AS "tierCode", status, starts_on AS "startsOn", ends_on AS "endsOn" FROM club_memberships WHERE member_id = $1', [memberId]);
      await q.query(
        `INSERT INTO club_memberships (member_id, tier_code, status, starts_on, ends_on, created_by) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (member_id) DO UPDATE SET tier_code = EXCLUDED.tier_code, status = EXCLUDED.status, starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on`,
        [memberId, input.tierCode, input.status, input.startsOn, input.endsOn ?? null, actorId()],
      );
      await this.audit.record({ action: 'loyalty.club_membership', entityType: 'loyalty_member', entityId: memberId, propertyId, reason: input.reason, previousValues: before ?? null, newValues: input });
      return this.view(q, memberId);
    });
  }

  /** An approved individual rate for a period; it beats the tier only while in effect (CAT04). */
  async addOverride(propertyId: string, memberId: string, input: { discountPercent: string | null; cashbackPercent: string | null; effectiveFrom: string; effectiveTo?: string | null; reason: string; approval?: ApprovalInputT }) {
    if (input.discountPercent == null && input.cashbackPercent == null) throw new BadRequestException('Set a discount or a cashback rate');
    return this.db.tx(async (q) => {
      const m = await this.ledger.lockMember(q, memberId);
      const approvalId = await this.approvals.approve({
        permission: 'approve.club_override', propertyId, action: 'loyalty.club_override', entityType: 'loyalty_member', entityId: memberId, reason: input.reason,
        approval: input.approval, details: { member: m.number, discountPercent: input.discountPercent, cashbackPercent: input.cashbackPercent, from: input.effectiveFrom, to: input.effectiveTo ?? null },
      });
      await q.query(
        `INSERT INTO club_rate_overrides (member_id, discount_percent, cashback_percent, effective_from, effective_to, reason, approval_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [memberId, input.discountPercent, input.cashbackPercent, input.effectiveFrom, input.effectiveTo ?? null, input.reason, approvalId, actorId()],
      );
      return this.view(q, memberId);
    });
  }

  // -------------------------------------------------------------------------
  // Card and self-service (LOY23, LOY28)
  // -------------------------------------------------------------------------

  async cardData(memberId: string) {
    return this.db.tx(async (q) => {
      const { rows: [m] } = await q.query<{ number: string; displayName: string; qrToken: string; status: string; tier: string | null }>(
        `SELECT m.number, m.display_name AS "displayName", m.qr_token AS "qrToken", m.status, t.name AS tier
           FROM loyalty_members m LEFT JOIN club_memberships cm ON cm.member_id = m.id AND cm.status = 'active' LEFT JOIN club_tiers t ON t.code = cm.tier_code
          WHERE m.id = $1`,
        [memberId],
      );
      if (!m) throw new NotFoundException('Member not found');
      if (m.status !== 'active') throw conflict(`Member ${m.number} is ${m.status}`, 'member_inactive');
      return { number: m.number, name: m.displayName, tier: m.tier, qr: `YS:${m.number}:${m.qrToken}` };
    });
  }

  /** Public member page reached by the secure link (LOY23): balance, expiring points, wallet and statement. */
  async selfService(selfToken: string) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(selfToken)) throw new NotFoundException();
    return this.db.tx(async (q) => {
      const { rows: [m] } = await q.query<{ id: string; number: string; displayName: string; status: string }>(
        `SELECT id, number, display_name AS "displayName", status FROM loyalty_members WHERE self_token = $1`,
        [selfToken],
      );
      if (!m || ['merged', 'anonymised', 'closed'].includes(m.status)) throw new NotFoundException();
      await this.ledger.expireDue(q, m.id);
      const balances = await this.ledger.balances(q, m.id);
      const { settings } = await this.programme.current(q);
      const club = await this.programme.clubRates(q, m.id, new Date().toISOString(), settings);
      const { rows: events } = await q.query(
        `SELECT e.created_at AS at, e.unit, e.type, e.amount::text, p.name AS property, o.name AS outlet
           FROM loyalty_events e LEFT JOIN properties p ON p.id = e.property_id LEFT JOIN outlets o ON o.id = e.outlet_id
          WHERE e.member_id = $1 OR e.member_id IN (SELECT id FROM loyalty_members WHERE merged_into_id = $1) ORDER BY e.id DESC LIMIT 100`,
        [m.id],
      );
      return { number: m.number, firstName: m.displayName.split(' ')[0], balances, club, events, pointValue: settings.points.pointValue };
    }, { all: true, propertyIds: [] });
  }
}
