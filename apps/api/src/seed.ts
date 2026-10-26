/**
 * Development/test seed. Idempotent; safe to re-run.
 *
 *   MIGRATION_DATABASE_URL=... SEED_PASSWORD='choose-a-dev-password' node dist/seed.js
 *
 * Creates demo users only. Properties, SAP branch IDs, tax codes and the
 * client's outlets come from migrations (0002, 0007).
 */
import { Client } from 'pg';
import { hashPassword } from './auth/password';

interface SeedUser {
  username: string;
  displayName: string;
  roles: string[];
  properties: string[] | 'all';
}

export const SEED_USERS: SeedUser[] = [
  { username: 'admin', displayName: 'System admin', roles: ['admin'], properties: 'all' },
  { username: 'owner', displayName: 'Group owner', roles: ['owner'], properties: 'all' },
  { username: 'group.accounts', displayName: 'Group accounts', roles: ['group_accounts'], properties: 'all' },
  { username: 'k1.manager', displayName: 'K1 manager', roles: ['manager'], properties: ['K1'] },
  { username: 'k1.reception', displayName: 'K1 receptionist', roles: ['receptionist'], properties: ['K1'] },
  { username: 'sw.reception', displayName: 'Small World receptionist', roles: ['receptionist'], properties: ['SW'] },
  { username: 'km.reception', displayName: 'Kahama receptionist', roles: ['receptionist'], properties: ['KM'] },
  { username: 'k1.waiter', displayName: 'K1 waiter', roles: ['waiter'], properties: ['K1'] },
];

export async function seed(connectionString: string, password: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.all_properties = 'on'`);
    const { rows: props } = await client.query<{ id: string; code: string }>('SELECT id, code FROM properties');
    const propertyId = new Map(props.map((p) => [p.code, p.id]));
    const hash = await hashPassword(password);

    for (const u of SEED_USERS) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, all_properties)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ((lower(username))) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [u.username, u.displayName, hash, u.properties === 'all'],
      );
      const userId = rows[0].id;
      for (const role of u.roles) {
        await client.query('INSERT INTO user_roles VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, role]);
      }
      if (u.properties !== 'all') {
        for (const code of u.properties) {
          await client.query('INSERT INTO user_property_access VALUES ($1, $2) ON CONFLICT DO NOTHING', [
            userId,
            propertyId.get(code),
          ]);
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.MIGRATION_DATABASE_URL;
  const password = process.env.SEED_PASSWORD;
  if (!url || !password) {
    console.error('MIGRATION_DATABASE_URL and SEED_PASSWORD are required');
    process.exit(1);
  }
  seed(url, password)
    .then(() => {
      console.log(`seeded ${SEED_USERS.length} users`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
