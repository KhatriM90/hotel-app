import { Client, DatabaseError } from 'pg';
import { runMigrations } from '../src/db/migrate';
import { appClient, ownerClient } from './helpers';

async function pgError(p: Promise<unknown>): Promise<DatabaseError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DatabaseError) return err;
    throw err;
  }
  throw new Error('expected a database error');
}

async function scoped(c: Client, propertyIds: string[], all = false): Promise<void> {
  await c.query(`SELECT set_config('app.all_properties', $1, false), set_config('app.property_ids', $2, false)`, [
    all ? 'on' : 'off',
    `{${propertyIds.join(',')}}`,
  ]);
}

describe('database foundation', () => {
  let owner: Client;
  let ids: Record<string, string>;

  beforeAll(async () => {
    owner = await ownerClient();
    const { rows } = await owner.query<{ code: string; id: string }>('SELECT code, id FROM properties');
    ids = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  });

  afterAll(async () => {
    await owner.end();
  });

  describe('migrations', () => {
    it('re-running is a no-op', async () => {
      const applied = await runMigrations({ connectionString: process.env.TEST_DATABASE_OWNER_URL!, log: () => undefined });
      expect(applied).toEqual([]);
    });

    it('seeds the three properties with K1 as head office (CFG-04)', async () => {
      const { rows } = await owner.query('SELECT code, name, is_head_office FROM properties ORDER BY code');
      expect(rows).toEqual([
        { code: 'K1', name: 'K1 Klubhouse', is_head_office: true },
        { code: 'KM', name: 'Kahama Mombasa', is_head_office: false },
        { code: 'SW', name: 'Small World Country Club', is_head_office: false },
      ]);
    });

    it('runtime role cannot bypass row-level security', async () => {
      const { rows } = await owner.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'hotel_app'`);
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });
  });

  describe('decimal money domains (§9)', () => {
    it('rejects NaN and rounds to cents', async () => {
      const { rows } = await owner.query(`SELECT '1.005'::money_amount::text AS a, '0.1'::money_amount + '0.2'::money_amount AS b`);
      expect(rows[0]).toEqual({ a: '1.01', b: '0.30' });
      const err = await pgError(owner.query(`SELECT 'NaN'::money_amount`));
      expect(err.code).toBe('23514');
    });

    it('rejects negative rates', async () => {
      const err = await pgError(owner.query(`SELECT '-0.16'::rate`));
      expect(err.code).toBe('23514');
    });
  });

  describe('property scope via RLS (SEC-06, AT-18)', () => {
    let app: Client;
    beforeEach(async () => {
      app = await appClient();
    });
    afterEach(async () => {
      await app.end();
    });

    it('fails closed when no scope is set', async () => {
      const { rows } = await app.query('SELECT code FROM properties');
      expect(rows).toEqual([]);
    });

    it('shows only assigned properties', async () => {
      await scoped(app, [ids.KM]);
      const props = await app.query('SELECT code FROM properties');
      expect(props.rows.map((r) => r.code)).toEqual(['KM']);
      const outlets = await app.query('SELECT DISTINCT property_id FROM outlets');
      expect(outlets.rows.map((r) => r.property_id)).toEqual([ids.KM]);
    });

    it('group scope sees everything', async () => {
      await scoped(app, [], true);
      const { rows } = await app.query('SELECT code FROM properties ORDER BY code');
      expect(rows.map((r) => r.code)).toEqual(['K1', 'KM', 'SW']);
    });

    it('cannot write rows for another property', async () => {
      await scoped(app, [ids.KM]);
      const err = await pgError(
        app.query(`INSERT INTO outlets (property_id, code, name, type, revenue_centre) VALUES ($1, 'K1-HACK', 'x', 'bar', 'BAR')`, [
          ids.K1,
        ]),
      );
      expect(err.code).toBe('42501');
    });
  });

  describe('document numbering (CFG-04, BIL-09)', () => {
    it('issues property-prefixed sequential numbers', async () => {
      await owner.query('BEGIN');
      const a = await owner.query(`SELECT next_document_number($1, 'FOLIO') AS n`, [ids.SW]);
      const b = await owner.query(`SELECT next_document_number($1, 'FOLIO') AS n`, [ids.SW]);
      await owner.query('COMMIT');
      expect(a.rows[0].n).toMatch(/^SW-FO-\d{6}$/);
      const seqA = Number(a.rows[0].n.slice(-6));
      expect(b.rows[0].n).toBe(`SW-FO-${String(seqA + 1).padStart(6, '0')}`);
    });

    it('is gapless: a rolled-back transaction does not consume a number', async () => {
      await owner.query('BEGIN');
      const burned = await owner.query(`SELECT next_document_number($1, 'RECEIPT') AS n`, [ids.KM]);
      await owner.query('ROLLBACK');
      const next = await owner.query(`SELECT next_document_number($1, 'RECEIPT') AS n`, [ids.KM]);
      expect(next.rows[0].n).toBe(burned.rows[0].n);
    });

    it('does not truncate numbers wider than the padding', async () => {
      await owner.query(`UPDATE number_sequences SET next_value = 1234567 WHERE property_id = $1 AND document_type = 'PROFORMA'`, [
        ids.K1,
      ]);
      const { rows } = await owner.query(`SELECT next_document_number($1, 'PROFORMA') AS n`, [ids.K1]);
      expect(rows[0].n).toBe('K1-PF-1234567');
    });

    it('stays unique and contiguous under concurrency', async () => {
      const clients = await Promise.all(Array.from({ length: 8 }, () => appClient()));
      try {
        const numbers = await Promise.all(
          clients.map(async (c) => {
            await scoped(c, [ids.K1]);
            const out: string[] = [];
            for (let i = 0; i < 5; i++) {
              const { rows } = await c.query(`SELECT next_document_number($1, 'POS_CHECK') AS n`, [ids.K1]);
              out.push(rows[0].n);
            }
            return out;
          }),
        );
        const flat = numbers.flat();
        expect(new Set(flat).size).toBe(40);
        const seqs = flat.map((n) => Number(n.split('-')[2])).sort((x, y) => x - y);
        expect(seqs[seqs.length - 1] - seqs[0]).toBe(39);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    });

    it('refuses to number documents for a property outside scope', async () => {
      const app = await appClient();
      try {
        await scoped(app, [ids.KM]);
        const err = await pgError(app.query(`SELECT next_document_number($1, 'INVOICE')`, [ids.K1]));
        expect(err.code).toBe('HT003');
      } finally {
        await app.end();
      }
    });

    it('keeps the allocation log append-only', async () => {
      const err = await pgError(owner.query(`DELETE FROM number_allocations WHERE property_id = $1`, [ids.SW]));
      expect(err.code).toBe('HT001');
      const app = await appClient();
      try {
        await scoped(app, [], true);
        const denied = await pgError(app.query(`UPDATE number_allocations SET seq_value = 0`));
        expect(denied.code).toBe('42501'); // runtime role has no UPDATE privilege at all
      } finally {
        await app.end();
      }
    });
  });

  describe('append-only audit log (SEC-04)', () => {
    it('blocks update, delete and truncate', async () => {
      await owner.query(`INSERT INTO audit_events (action) VALUES ('test.event')`);
      expect((await pgError(owner.query(`UPDATE audit_events SET action = 'x'`))).code).toBe('HT001');
      expect((await pgError(owner.query(`DELETE FROM audit_events`))).code).toBe('HT001');
      expect((await pgError(owner.query(`TRUNCATE audit_events`))).code).toBe('HT001');
    });
  });

  describe('finalised-record guard (§9, BIL-07)', () => {
    beforeAll(async () => {
      await owner.query(`
        CREATE TABLE test_fin_doc (
          id serial PRIMARY KEY,
          amount money_amount NOT NULL,
          note text,
          sync_status text,
          finalised_at timestamptz
        );
        CREATE TRIGGER test_fin_doc_guard BEFORE UPDATE OR DELETE ON test_fin_doc
          FOR EACH ROW EXECUTE FUNCTION app_guard_finalised('sync_status');`);
    });
    afterAll(async () => {
      await owner.query('DROP TABLE test_fin_doc');
    });

    it('allows edits and deletes while draft', async () => {
      const { rows } = await owner.query(`INSERT INTO test_fin_doc (amount) VALUES ('10.00') RETURNING id`);
      await owner.query(`UPDATE test_fin_doc SET amount = '12.50' WHERE id = $1`, [rows[0].id]);
      await owner.query(`DELETE FROM test_fin_doc WHERE id = $1`, [rows[0].id]);
    });

    it('freezes a finalised record except whitelisted columns', async () => {
      const { rows } = await owner.query(`INSERT INTO test_fin_doc (amount) VALUES ('99.00') RETURNING id`);
      const id = rows[0].id;
      await owner.query(`UPDATE test_fin_doc SET finalised_at = now() WHERE id = $1`, [id]);

      expect((await pgError(owner.query(`UPDATE test_fin_doc SET amount = '1.00' WHERE id = $1`, [id]))).code).toBe('HT002');
      expect((await pgError(owner.query(`UPDATE test_fin_doc SET finalised_at = NULL WHERE id = $1`, [id]))).code).toBe('HT002');
      expect((await pgError(owner.query(`DELETE FROM test_fin_doc WHERE id = $1`, [id]))).code).toBe('HT002');

      await owner.query(`UPDATE test_fin_doc SET sync_status = 'posted' WHERE id = $1`, [id]);
      const after = await owner.query(`SELECT amount, sync_status FROM test_fin_doc WHERE id = $1`, [id]);
      expect(after.rows[0]).toEqual({ amount: '99.00', sync_status: 'posted' });
    });
  });

  describe('integration outbox guards (SAP-11, SAP-AT06)', () => {
    it('never rewrites or deletes the source event, and posted is final', async () => {
      const { rows } = await owner.query(
        `INSERT INTO integration_outbox (property_id, target, event_type, external_ref, payload)
         VALUES ($1, 'SAP', 'AR_INVOICE', 'SCHEMA-TEST-0001', '{"a":1}') RETURNING id`,
        [ids.K1],
      );
      const id = rows[0].id;
      expect((await pgError(owner.query(`UPDATE integration_outbox SET payload = '{"a":2}' WHERE id = $1`, [id]))).code).toBe(
        'HT001',
      );
      expect((await pgError(owner.query(`DELETE FROM integration_outbox WHERE id = $1`, [id]))).code).toBe('HT001');

      const missingDoc = await pgError(owner.query(`UPDATE integration_outbox SET status = 'posted' WHERE id = $1`, [id]));
      expect(missingDoc.code).toBe('23514');

      await owner.query(`UPDATE integration_outbox SET status = 'posted', sap_doc_entry = 1 WHERE id = $1`, [id]);
      expect((await pgError(owner.query(`UPDATE integration_outbox SET status = 'pending' WHERE id = $1`, [id]))).code).toBe(
        'HT002',
      );
    });
  });
});
