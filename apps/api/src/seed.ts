/**
 * Development/test seed. Idempotent; safe to re-run.
 *
 *   MIGRATION_DATABASE_URL=... SEED_PASSWORD='choose-a-dev-password' node dist/seed.js
 *
 * Creates demo users and test master data for reservations and front desk:
 * room types, rooms (K1 13, SW 42, KM 32), rate plans and prices, booking
 * policies, a corporate client, an agent and sample guests (seed-data.ts),
 * and POS menus, price lists, stations, tables and house accounts (seed-pos.ts).
 * Properties, SAP branch IDs, tax codes and the client's outlets come from
 * migrations (0002, 0007).
 */
import { Client } from 'pg';
import { hashPassword } from './auth/password';
import { seedPos } from './seed-pos';
import { registrationTerms, SEED_COMPANIES, SEED_GUESTS, SEED_PROPERTIES } from './seed-data';

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
  { username: 'k1.cashier', displayName: 'K1 cashier', roles: ['cashier'], properties: ['K1'] },
  { username: 'k1.bartender', displayName: 'K1 bartender', roles: ['bartender'], properties: ['K1'] },
  { username: 'k1.kitchen', displayName: 'K1 kitchen', roles: ['kitchen'], properties: ['K1'] },
  { username: 'sw.waiter', displayName: 'Small World waiter', roles: ['waiter'], properties: ['SW'] },
  { username: 'km.waiter', displayName: 'Kahama waiter', roles: ['waiter'], properties: ['KM'] },
  { username: 'sw.manager', displayName: 'Small World manager', roles: ['manager'], properties: ['SW'] },
  { username: 'km.manager', displayName: 'Kahama manager', roles: ['manager'], properties: ['KM'] },
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

    await seedMasterData(client, propertyId);
    await seedPos(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

/** Idempotent: existing rows are left alone, so re-running never overwrites live edits. */
async function seedMasterData(client: Client, propertyId: Map<string, string>): Promise<void> {
  const companyId = new Map<string, string>();
  for (const c of SEED_COMPANIES) {
    await client.query(
      `INSERT INTO companies (kind, name, contact_name, contact_email) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, lower(name)) DO NOTHING`,
      [c.kind, c.name, c.contactName, c.contactEmail],
    );
    const { rows } = await client.query<{ id: string }>('SELECT id FROM companies WHERE kind = $1 AND lower(name) = lower($2)', [c.kind, c.name]);
    companyId.set(c.name, rows[0].id);
  }

  for (const g of SEED_GUESTS) {
    await client.query(
      `INSERT INTO guests (first_name, last_name, phone, email, nationality, company_id)
       SELECT $1, $2, $3, $4, $5, $6
        WHERE NOT EXISTS (SELECT 1 FROM guests WHERE phone = $3)`,
      [g.firstName, g.lastName, g.phone, g.email, g.nationality, g.company ? companyId.get(g.company) : null],
    );
  }

  for (const p of SEED_PROPERTIES) {
    const pid = propertyId.get(p.code)!;
    const typeId = new Map<string, string>();
    for (const [i, rt] of p.roomTypes.entries()) {
      await client.query(
        `INSERT INTO room_types (property_id, code, name, description, base_occupancy, max_adults, max_occupancy, beds, amenities, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (property_id, code) DO NOTHING`,
        [pid, rt.code, rt.name, rt.description, rt.baseOccupancy, rt.maxAdults, rt.maxOccupancy, rt.beds, rt.amenities, i],
      );
      const { rows } = await client.query<{ id: string }>('SELECT id FROM room_types WHERE property_id = $1 AND code = $2', [pid, rt.code]);
      typeId.set(rt.code, rows[0].id);
      for (const room of rt.rooms) {
        await client.query(
          `INSERT INTO rooms (property_id, room_type_id, number, floor, building) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (property_id, number) DO NOTHING`,
          [pid, rows[0].id, room.number, room.floor, room.building],
        );
      }
    }

    for (const plan of p.ratePlans) {
      const negotiated = plan.negotiatedWith ? companyId.get(plan.negotiatedWith)! : null;
      await client.query(
        `INSERT INTO rate_plans (property_id, code, name, is_negotiated, company_id, effective_from)
         VALUES ($1, $2, $3, $4, $5, '2026-01-01')
         ON CONFLICT (property_id, code) DO NOTHING`,
        [pid, plan.code, plan.name, negotiated !== null, negotiated],
      );
      const { rows } = await client.query<{ id: string }>('SELECT id FROM rate_plans WHERE property_id = $1 AND code = $2', [pid, plan.code]);
      for (const price of plan.prices) {
        await client.query(
          `INSERT INTO rate_prices (property_id, rate_plan_id, room_type_id, season_name, valid_from, valid_to, priority,
                                    weekday_price, weekend_price, extra_adult_price, child_price)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
            WHERE NOT EXISTS (SELECT 1 FROM rate_prices WHERE rate_plan_id = $2 AND room_type_id = $3 AND season_name = $4 AND valid_from = $5)`,
          [pid, rows[0].id, typeId.get(price.roomType), price.season, price.from, price.to, price.priority,
           price.weekday, price.weekend, price.extraAdult, price.child],
        );
      }
    }

    const pol = p.policy;
    // Only fill in policies nobody has edited through the API yet.
    await client.query(
      `UPDATE booking_policies SET deposit_type = $2, deposit_value = $3, deposit_due_days = $4, default_hold_minutes = $5,
              free_cancellation_hours = $6, late_cancellation_nights = $7, no_show_nights = $8, refund_policy = $9,
              check_in_time = $10, check_out_time = $11, early_check_in_fee = $12, late_check_out_fee = $13, registration_terms = $14
        WHERE property_id = $1 AND updated_by IS NULL`,
      [pid, pol.depositType, pol.depositValue, pol.depositDueDays, pol.holdMinutes, pol.freeCancellationHours,
       pol.lateCancellationNights, pol.noShowNights, pol.refundPolicy, pol.checkInTime, pol.checkOutTime,
       pol.earlyCheckInFee, pol.lateCheckOutFee, registrationTerms(pol)],
    );
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
      console.log(`seeded ${SEED_USERS.length} users and test master data for ${SEED_PROPERTIES.length} properties`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
