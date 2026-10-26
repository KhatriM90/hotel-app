/**
 * Forward-only SQL migration runner.
 *
 *   MIGRATION_DATABASE_URL=postgres://owner:...@host/db APP_DB_PASSWORD=... node dist/db/migrate.js
 *
 * - Runs as the schema owner. Creates the runtime role `hotel_app` (NOSUPERUSER,
 *   NOBYPASSRLS) if missing, so row-level security always applies to the API.
 * - Applies apps/api/migrations/*.sql in name order, each in its own transaction.
 * - Records a SHA-256 checksum; editing an applied migration is an error.
 *   Fix forward with a new migration instead.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

export const APP_ROLE = 'hotel_app';
const LOCK_ID = 7_402_118_001;

export interface MigrateOptions {
  connectionString: string;
  appRolePassword?: string;
  migrationsDir?: string;
  log?: (msg: string) => void;
}

export function defaultMigrationsDir(): string {
  // Works from src/db (ts-jest) and dist/db (compiled).
  return resolve(__dirname, '..', '..', 'migrations');
}

export async function runMigrations(opts: MigrateOptions): Promise<string[]> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const dir = opts.migrationsDir ?? defaultMigrationsDir();
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();

  const client = new Client({ connectionString: opts.connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await ensureAppRole(client, opts.appRolePassword, log);
    // Seed/reference inserts in migrations touch RLS-protected tables.
    await client.query(`SET app.all_properties = 'on'`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch). Add a new migration instead.`);
        }
        continue;
      }
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
    log(applied.length ? `applied ${applied.length} migration(s)` : 'database is up to date');
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
}

async function ensureAppRole(client: Client, password: string | undefined, log: (m: string) => void): Promise<void> {
  const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
  const pw = password ? client.escapeLiteral(password) : null;
  if (!rowCount) {
    log(`creating role ${APP_ROLE}`);
    await client.query(
      `CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE${pw ? ` PASSWORD ${pw}` : ''}`,
    );
  } else if (pw) {
    await client.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
  }
}

if (require.main === module) {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) {
    console.error('MIGRATION_DATABASE_URL is required');
    process.exit(1);
  }
  runMigrations({ connectionString, appRolePassword: process.env.APP_DB_PASSWORD })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
