import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService, Queryable } from '../db/db.service';
import { conflict, isPgError, withSavepoint } from '../frontoffice/common';
import { PosChecksService } from './checks.service';
import { actorId, event } from './common';

export interface PosCustomer {
  id: string;
  name: string;
  kraPin: string | null;
  phone: string | null;
  lastUsedAt: string | null;
}

/** Customer on a check: a saved customer, details typed for this bill only (optionally saved), or none. */
export type CheckCustomerInput =
  | { customerId: string }
  | { name: string; kraPin?: string | null; phone?: string | null; save?: boolean }
  | { clear: true };

const COLUMNS = `pc.id, pc.name, pc.kra_pin AS "kraPin", pc.phone,
  (SELECT max(c.opened_at) FROM pos_checks c WHERE c.customer_id = pc.id) AS "lastUsedAt"`;

export function normalisePhone(phone: string | null | undefined): string | null {
  const v = (phone ?? '').replace(/[\s()-]/g, '');
  if (!v) return null;
  // Kenyan numbers typed locally (0712 …) are kept in international form.
  return /^0[17][0-9]{8}$/.test(v) ? `+254${v.slice(1)}` : v;
}

/**
 * Customer KRA PIN on POS bills and saved repeat customers (POS demo, 25 Nov
 * 2026, points 15 to 17). The fiscal receipt with the buyer's PIN comes with
 * the TIMS integration (INT-02); until then the PIN prints on the bill.
 */
@Injectable()
export class PosCustomersService {
  constructor(
    private readonly db: DbService,
    private readonly checks: PosChecksService,
  ) {}

  /** Saved customers matching a name, phone or KRA PIN; recently used first. */
  async search(text: string): Promise<PosCustomer[]> {
    const t = text.trim();
    if (t.length < 2) return [];
    const digits = t.replace(/[^0-9]/g, '');
    const phone = normalisePhone(t);
    const { rows } = await this.db.query<PosCustomer>(
      `SELECT ${COLUMNS} FROM pos_customers pc
        WHERE pc.is_active AND (
              lower(pc.name) LIKE '%' || lower($1) || '%'
           OR pc.kra_pin LIKE upper($1) || '%'
           OR (length($2) >= 4 AND (pc.phone LIKE '%' || $2 || '%' OR pc.phone = $3)))
        ORDER BY "lastUsedAt" DESC NULLS LAST, pc.name
        LIMIT 20`,
      [t.replace(/[%_\\]/g, ''), digits, phone],
    );
    return rows;
  }

  /** Correct a saved customer's details (from the tablet or the back office). */
  async update(id: string, input: { name?: string; kraPin?: string | null; phone?: string | null; isActive?: boolean }): Promise<PosCustomer> {
    return this.db.tx(async (q) => {
      const { rowCount } = await q.query('SELECT 1 FROM pos_customers WHERE id = $1 FOR UPDATE', [id]);
      if (!rowCount) throw new NotFoundException('Customer not found');
      try {
        await withSavepoint(q, 'customer_update', () =>
          q.query(
            `UPDATE pos_customers SET name = coalesce($2, name),
                    kra_pin = CASE WHEN $3 THEN $4 ELSE kra_pin END, phone = CASE WHEN $5 THEN $6 ELSE phone END,
                    is_active = coalesce($7, is_active), updated_by = $8
              WHERE id = $1`,
            [id, input.name?.trim() ?? null, input.kraPin !== undefined, input.kraPin?.trim().toUpperCase() || null,
              input.phone !== undefined, normalisePhone(input.phone), input.isActive ?? null, actorId()],
          ),
        );
      } catch (e) {
        throw this.duplicatePin(e, input.kraPin);
      }
      return this.byId(q, id);
    });
  }

  /** Put the customer's name and KRA PIN on an open check before the bill prints. */
  async setOnCheck(propertyId: string, checkId: string, input: CheckCustomerInput) {
    return this.db.tx(async (q) => {
      const check = await this.checks.lock(q, propertyId, checkId);
      let customer: { id: string | null; name: string | null; kraPin: string | null; phone: string | null };
      if ('clear' in input) {
        customer = { id: null, name: null, kraPin: null, phone: null };
      } else if ('customerId' in input) {
        const saved = await this.byId(q, input.customerId);
        customer = { id: saved.id, name: saved.name, kraPin: saved.kraPin, phone: saved.phone };
      } else {
        const name = input.name.trim();
        const kraPin = input.kraPin?.trim().toUpperCase() || null;
        const phone = normalisePhone(input.phone);
        if (!name) throw new BadRequestException('Give the customer’s name');
        let id: string | null = null;
        if (input.save) id = await this.save(q, propertyId, { name, kraPin, phone });
        customer = { id, name, kraPin, phone };
      }
      await q.query(
        `UPDATE pos_checks SET customer_id = $2, customer_name = $3, customer_kra_pin = $4, customer_phone = $5 WHERE id = $1`,
        [check.id, customer.id, customer.name, customer.kraPin, customer.phone],
      );
      await event(q, propertyId, check.id, customer.name ? 'customer_set' : 'customer_cleared', customer.name
        ? { name: customer.name, kraPin: customer.kraPin, saved: !!customer.id }
        : null);
      return this.checks.view(q, propertyId, check.id);
    });
  }

  /** A typed customer saved for next time; a known KRA PIN updates that customer instead of adding a second one. */
  private async save(q: Queryable, propertyId: string, c: { name: string; kraPin: string | null; phone: string | null }): Promise<string> {
    if (c.kraPin) {
      const { rows } = await q.query<{ id: string }>(
        `UPDATE pos_customers SET name = $2, phone = coalesce($3, phone), is_active = true, updated_by = $4
          WHERE kra_pin = $1 RETURNING id`,
        [c.kraPin, c.name, c.phone, actorId()],
      );
      if (rows[0]) return rows[0].id;
    }
    try {
      const { rows } = await withSavepoint(q, 'customer_save', () =>
        q.query<{ id: string }>(
          `INSERT INTO pos_customers (name, kra_pin, phone, created_property_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [c.name, c.kraPin, c.phone, propertyId, actorId()],
        ),
      );
      return rows[0].id;
    } catch (e) {
      throw this.duplicatePin(e, c.kraPin);
    }
  }

  private async byId(q: Queryable, id: string): Promise<PosCustomer> {
    const { rows } = await q.query<PosCustomer>(`SELECT ${COLUMNS} FROM pos_customers pc WHERE pc.id = $1 AND pc.is_active`, [id]);
    if (!rows[0]) throw new NotFoundException('Customer not found');
    return rows[0];
  }

  private duplicatePin(e: unknown, kraPin: string | null | undefined): unknown {
    if (isPgError(e, '23505')) return conflict(`A saved customer already has KRA PIN ${kraPin?.toUpperCase()}`, 'customer_pin_taken');
    return e;
  }
}
