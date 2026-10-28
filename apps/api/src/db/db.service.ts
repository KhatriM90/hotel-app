import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, PoolClient, QueryResult, QueryResultRow, types } from 'pg';
import { APP_CONFIG, AppConfig } from '../config';
import { NO_SCOPE, PropertyScope, requestContext } from './request-context';

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

// Business dates are calendar dates with no time zone (§9): keep Postgres `date`
// values as 'YYYY-MM-DD' strings instead of converting them to JS Dates at local midnight.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Postgres access. Every transaction runs with a property scope applied via
 * SET LOCAL, which row-level security policies read (SEC-06, AT-18).
 * Nested tx() calls join the outer transaction.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;
  private readonly current = new AsyncLocalStorage<PoolClient>();

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /** Runs `fn` in a transaction. Scope defaults to the current request's scope, else none. */
  async tx<T>(fn: (q: Queryable) => Promise<T>, scope?: PropertyScope): Promise<T> {
    const existing = this.current.getStore();
    if (existing) return fn(existing);

    const effective = scope ?? requestContext.get()?.scope ?? NO_SCOPE;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await applyScope(client, effective);
      const result = await this.current.run(client, () => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Query in the current transaction if there is one, otherwise a scoped single-statement transaction. */
  async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    const existing = this.current.getStore();
    if (existing) return existing.query<R>(text, values);
    return this.tx((q) => q.query<R>(text, values));
  }
}

export async function applyScope(client: Queryable, scope: PropertyScope): Promise<void> {
  for (const id of scope.propertyIds) {
    if (!UUID_RE.test(id)) throw new Error(`Invalid property id in scope: ${id}`);
  }
  await client.query(
    `SELECT set_config('app.all_properties', $1, true), set_config('app.property_ids', $2, true)`,
    [scope.all ? 'on' : 'off', `{${scope.propertyIds.join(',')}}`],
  );
}
