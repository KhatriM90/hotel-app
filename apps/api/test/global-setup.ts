import { Client } from 'pg';
import { runMigrations } from '../src/db/migrate';
import { seed } from '../src/seed';
import './env';

/** Fresh database per test run: drop, create, migrate, seed. */
export default async function globalSetup(): Promise<void> {
  const admin = new Client({
    connectionString: process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
  });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS hotel_api_test WITH (FORCE)');
  await admin.query('CREATE DATABASE hotel_api_test');
  await admin.end();

  const owner = process.env.TEST_DATABASE_OWNER_URL!;
  await runMigrations({ connectionString: owner, appRolePassword: 'hotel_app_test_pw', log: () => undefined });
  await seed(owner, process.env.SEED_PASSWORD!);
}
