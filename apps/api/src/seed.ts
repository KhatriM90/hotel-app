/**
 * Development/test seed. Idempotent; safe to re-run.
 *
 *   MIGRATION_DATABASE_URL=... SEED_PASSWORD='choose-a-dev-password' node dist/seed.js
 *
 * Creates demo users and placeholder outlets. Real outlet names, types and
 * warehouse codes for all 21 outlets are still TBC with the client
 * (brief §11, §15C); placeholders are clearly labelled.
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

const PLACEHOLDER_OUTLETS: Array<[string, string, string, string, string, string, boolean]> = [
  // property, code, name, type, revenue centre, issuing warehouse, sells alcohol
  ['K1', 'K1-REST', 'K1 Restaurant (name TBC)', 'restaurant', 'REST', 'K1-KIT', false],
  ['K1', 'K1-BAR1', 'K1 Bar 1 (name TBC)', 'bar', 'BAR', 'K1-BAR1', true],
  ['K1', 'K1-RSVC', 'K1 Room service', 'room_service', 'RSVC', 'K1-KIT', true],
  ['SW', 'SW-REST', 'Small World Restaurant (name TBC)', 'restaurant', 'REST', 'SW-KIT', false],
  ['SW', 'SW-BAR1', 'Small World Bar 1 (name TBC)', 'bar', 'BAR', 'SW-BAR1', true],
  ['KM', 'KM-REST', 'Kahama Restaurant (name TBC)', 'restaurant', 'REST', 'KM-KIT', false],
  ['KM', 'KM-BAR1', 'Kahama Bar 1 (name TBC)', 'bar', 'BAR', 'KM-BAR1', true],
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

    for (const [prop, code, name, type, rc, wh, alcohol] of PLACEHOLDER_OUTLETS) {
      await client.query(
        `INSERT INTO outlets (property_id, code, name, type, revenue_centre, issuing_warehouse_code, sells_alcohol)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (property_id, code) DO NOTHING`,
        [propertyId.get(prop), code, name, type, rc, wh, alcohol],
      );
    }
    // Placeholder SAP branch IDs for the Service Layer mock only. Real BPLIds are TBC (SAP-13, §15A);
    // never run this seed against production.
    await client.query(
      `UPDATE properties p SET sap_branch_id = v.bpl
         FROM (VALUES ('K1', 1), ('SW', 2), ('KM', 3)) AS v(code, bpl)
        WHERE p.code = v.code AND p.sap_branch_id IS NULL`,
    );
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
      console.log(`seeded ${SEED_USERS.length} users and ${PLACEHOLDER_OUTLETS.length} placeholder outlets`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
