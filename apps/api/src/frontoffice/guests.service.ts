import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { hasPermission } from '@hotel/shared';
import { AuditService } from '../audit/audit.service';
import { DbService, Queryable } from '../db/db.service';
import { requestContext } from '../db/request-context';

export interface GuestInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  nationality?: string | null;
  dateOfBirth?: string | null;
  address?: string | null;
  companyId?: string | null;
  preferences?: string | null;
  notes?: string | null;
  marketingConsent?: boolean;
}

export interface IdentityInput {
  documentType: string;
  documentNumber: string;
  issuingCountry: string;
  expiryDate?: string | null;
}

const GUEST_COLUMNS = `
  g.id, g.first_name AS "firstName", g.last_name AS "lastName", g.email, g.phone, g.nationality,
  g.date_of_birth AS "dateOfBirth", g.address, g.company_id AS "companyId", c.name AS "companyName",
  g.preferences, g.notes, g.marketing_consent_at AS "marketingConsentAt", g.created_at AS "createdAt"`;

/** Masks all but the last 3 characters: enough to confirm at the desk, not to copy (FD-02, SEC-05). */
export function maskDocumentNumber(n: string): string {
  return n.length <= 3 ? '***' : `${'*'.repeat(n.length - 3)}${n.slice(-3)}`;
}

/**
 * Guest profiles shared across the group (CFG-05, FD-02). Identity documents
 * are only returned in full to roles with guest.identity, and every full read
 * is audited (SEC-04, AT-14).
 */
@Injectable()
export class GuestsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async search(term: string) {
    const t = term.trim();
    if (t.length < 2) throw new BadRequestException('Search needs at least 2 characters');
    const { rows } = await this.db.query(
      `SELECT ${GUEST_COLUMNS} FROM guests g LEFT JOIN companies c ON c.id = g.company_id
        WHERE g.first_name || ' ' || g.last_name ILIKE '%' || $1 || '%'
           OR g.last_name || ' ' || g.first_name ILIKE '%' || $1 || '%'
           OR g.phone LIKE '%' || $1 || '%' OR lower(g.email) = lower($1)
        ORDER BY g.last_name, g.first_name LIMIT 25`,
      [t],
    );
    return rows;
  }

  async create(q: Queryable, input: GuestInput): Promise<{ id: string }> {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO guests (first_name, last_name, email, phone, nationality, date_of_birth, address, company_id,
                           preferences, notes, marketing_consent_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $11 THEN now() END, $12) RETURNING id`,
      [
        input.firstName.trim(), input.lastName.trim(), input.email ?? null, input.phone ?? null,
        input.nationality?.toUpperCase() ?? null, input.dateOfBirth ?? null, input.address ?? null, input.companyId ?? null,
        input.preferences ?? null, input.notes ?? null, input.marketingConsent === true, requestContext.get()?.user?.id ?? null,
      ],
    );
    await this.audit.record({ action: 'guest.create', entityType: 'guest', entityId: rows[0].id, newValues: { firstName: input.firstName, lastName: input.lastName } });
    return rows[0];
  }

  createGuest(input: GuestInput) {
    return this.db.tx(async (q) => this.get((await this.create(q, input)).id));
  }

  async update(id: string, input: Partial<GuestInput>) {
    const map: Record<string, string> = {
      firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone', nationality: 'nationality',
      dateOfBirth: 'date_of_birth', address: 'address', companyId: 'company_id', preferences: 'preferences', notes: 'notes',
    };
    const entries = Object.entries(input).filter(([k, v]) => v !== undefined && map[k]);
    return this.db.tx(async (q) => {
      const before = await this.get(id);
      const sets = entries.map(([k], i) => `${map[k]} = $${i + 2}`);
      if (input.marketingConsent !== undefined) {
        sets.push(`marketing_consent_at = ${input.marketingConsent ? 'coalesce(marketing_consent_at, now())' : 'NULL'}`);
      }
      if (!sets.length) throw new BadRequestException('Nothing to update');
      await q.query(`UPDATE guests SET ${sets.join(', ')} WHERE id = $1`, [id, ...entries.map(([, v]) => v)]);
      const after = await this.get(id);
      const { stays: _a, identityDocuments: _b, ...prev } = before;
      const { stays: _c, identityDocuments: _d, ...next } = after;
      await this.audit.record({ action: 'guest.update', entityType: 'guest', entityId: id, previousValues: prev, newValues: next });
      return after;
    });
  }

  /**
   * Profile with stay history. History lists the stays the caller may see
   * (their properties; all three for group roles), so a Kahama receptionist
   * never sees K1 stay details (SEC-06, AT-18).
   */
  async get(id: string) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<Record<string, unknown>>(
        `SELECT ${GUEST_COLUMNS} FROM guests g LEFT JOIN companies c ON c.id = g.company_id WHERE g.id = $1`,
        [id],
      );
      if (!rows[0]) throw new NotFoundException('Guest not found');
      const { rows: stays } = await q.query(
        `SELECT s.id, s.number, p.code AS "propertyCode", s.status, s.arrival_date AS "arrivalDate",
                s.departure_date AS "departureDate", r.number AS "roomNumber", res.number AS "reservationNumber", s.reservation_id AS "reservationId"
           FROM stays s
           JOIN properties p ON p.id = s.property_id
           JOIN reservations res ON res.id = s.reservation_id
           LEFT JOIN rooms r ON r.id = s.room_id
          WHERE s.primary_guest_id = $1 OR EXISTS (SELECT 1 FROM stay_occupants o WHERE o.stay_id = s.id AND o.guest_id = $1)
          ORDER BY s.arrival_date DESC LIMIT 50`,
        [id],
      );
      const { rows: docs } = await q.query<{ documentNumber: string } & Record<string, unknown>>(
        `SELECT id, document_type AS "documentType", document_number AS "documentNumber", issuing_country AS "issuingCountry",
                expiry_date AS "expiryDate", verified_at AS "verifiedAt"
           FROM guest_identity_documents WHERE guest_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      return {
        ...rows[0],
        stays,
        // Always masked here; the full number needs guest.identity and is audited.
        identityDocuments: docs.map((d) => ({ ...d, documentNumber: maskDocumentNumber(d.documentNumber) })),
      };
    });
  }

  async identityDocuments(guestId: string) {
    return this.db.tx(async (q) => {
      const { rows } = await q.query(
        `SELECT d.id, d.document_type AS "documentType", d.document_number AS "documentNumber",
                d.issuing_country AS "issuingCountry", d.expiry_date AS "expiryDate", d.verified_at AS "verifiedAt",
                u.display_name AS "verifiedBy"
           FROM guest_identity_documents d LEFT JOIN users u ON u.id = d.verified_by
          WHERE d.guest_id = $1 ORDER BY d.created_at DESC`,
        [guestId],
      );
      await this.audit.record({ action: 'guest.identity_read', entityType: 'guest', entityId: guestId });
      return rows;
    });
  }

  /** Records (or re-verifies) an identity document. Needs guest.identity; checked by the caller. */
  async addIdentity(q: Queryable, guestId: string, input: IdentityInput, propertyId: string | null): Promise<string> {
    const user = requestContext.get()?.user;
    if (!user || !hasPermission(user.roles, 'guest.identity')) throw new BadRequestException('Not allowed to record identity documents');
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO guest_identity_documents (guest_id, document_type, document_number, issuing_country, expiry_date,
                                             verified_by, verified_at, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
       ON CONFLICT (guest_id, document_type, issuing_country, document_number)
       DO UPDATE SET verified_by = EXCLUDED.verified_by, verified_at = now(), expiry_date = EXCLUDED.expiry_date
       RETURNING id`,
      [guestId, input.documentType, input.documentNumber.trim().toUpperCase(), input.issuingCountry.toUpperCase(), input.expiryDate ?? null, user.id, propertyId],
    );
    await this.audit.record({
      action: 'guest.identity_recorded', entityType: 'guest', entityId: guestId, propertyId,
      newValues: { documentType: input.documentType, documentNumber: maskDocumentNumber(input.documentNumber), issuingCountry: input.issuingCountry },
    });
    return rows[0].id;
  }

  addIdentityDocument(guestId: string, input: IdentityInput) {
    return this.db.tx(async (q) => {
      await this.get(guestId);
      const id = await this.addIdentity(q, guestId, input, null);
      return { id };
    });
  }

  async hasValidIdentity(q: Queryable, guestId: string, onDate: string): Promise<boolean> {
    const { rowCount } = await q.query(
      `SELECT 1 FROM guest_identity_documents WHERE guest_id = $1 AND verified_at IS NOT NULL
          AND (expiry_date IS NULL OR expiry_date >= $2::date)`,
      [guestId, onDate],
    );
    return (rowCount ?? 0) > 0;
  }

  async companies(kind?: 'company' | 'agent') {
    const { rows } = await this.db.query(
      `SELECT id, kind, name, kra_pin AS "kraPin", contact_name AS "contactName", contact_email AS "contactEmail"
         FROM companies WHERE is_active AND ($1::text IS NULL OR kind = $1) ORDER BY name`,
      [kind ?? null],
    );
    return rows;
  }
}
