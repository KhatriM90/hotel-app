/**
 * POS test data: a group menu, outlet price lists, stations, tables, liquor
 * hours, a happy-hour rule and house accounts. All of it is placeholder data
 * until the client sends their menus, prices and licence hours. Idempotent:
 * existing rows are left alone so edits made through the API survive a re-run.
 */
import { Client } from 'pg';

type Route = 'kitchen' | 'bar' | 'none';

interface SeedCategory {
  code: string;
  name: string;
  route: Route;
}

interface SeedItem {
  code: string;
  name: string;
  category: string;
  charge: 'FOOD' | 'BEVERAGE' | 'OTHER';
  alcohol?: boolean;
  /** Portion code, name and price (KES, VAT and levy inclusive). */
  portions: Array<[string, string, string]>;
  modifiers?: string[];
  favourite?: boolean;
}

export const POS_CATEGORIES: SeedCategory[] = [
  { code: 'BREAKFAST', name: 'Breakfast', route: 'kitchen' },
  { code: 'STARTERS', name: 'Starters & bitings', route: 'kitchen' },
  { code: 'MAINS', name: 'Mains', route: 'kitchen' },
  { code: 'GRILL', name: 'Nyama choma & grill', route: 'kitchen' },
  { code: 'DESSERTS', name: 'Desserts', route: 'kitchen' },
  { code: 'COFFEE', name: 'Coffee & tea', route: 'bar' },
  { code: 'SOFT', name: 'Soft drinks & water', route: 'bar' },
  { code: 'BEER', name: 'Beer & cider', route: 'bar' },
  { code: 'SPIRITS', name: 'Spirits', route: 'bar' },
  { code: 'WINE', name: 'Wine', route: 'bar' },
  { code: 'COCKTAILS', name: 'Cocktails', route: 'bar' },
  { code: 'SHOP', name: 'Shop', route: 'none' },
  { code: 'LEISURE', name: 'Games & leisure', route: 'none' },
  { code: 'SPA', name: 'Spa', route: 'none' },
];

export const POS_MODIFIERS = [
  { code: 'DONENESS', name: 'Cooking', min: 1, max: 1, options: [['RARE', 'Rare', '0'], ['MEDIUM', 'Medium', '0'], ['WELL', 'Well done', '0']] },
  { code: 'EXTRAS', name: 'Extras', min: 0, max: 3, options: [['CHEESE', 'Extra cheese', '150'], ['CHIPS', 'Extra chips', '200'], ['EGG', 'Extra egg', '80']] },
  { code: 'SIDE', name: 'Side', min: 0, max: 1, options: [['UGALI', 'Ugali', '0'], ['CHIPS', 'Chips', '0'], ['RICE', 'Rice', '0'], ['KACHUMBARI', 'Kachumbari', '0']] },
  { code: 'MIXER', name: 'Mixer', min: 0, max: 1, options: [['SODA', 'Soda water', '0'], ['TONIC', 'Tonic', '50'], ['COKE', 'Coke', '50']] },
  { code: 'ICE', name: 'Ice', min: 0, max: 1, options: [['NOICE', 'No ice', '0'], ['XICE', 'Extra ice', '0']] },
] as const;

export const POS_ITEMS: SeedItem[] = [
  { code: 'BF-FULL', name: 'Full English breakfast', category: 'BREAKFAST', charge: 'FOOD', portions: [['STD', '', '1200']], modifiers: ['EXTRAS'] },
  { code: 'BF-OMELETTE', name: 'Spanish omelette', category: 'BREAKFAST', charge: 'FOOD', portions: [['STD', '', '650']], modifiers: ['EXTRAS'] },
  { code: 'ST-SAMOSA', name: 'Beef samosas (3)', category: 'STARTERS', charge: 'FOOD', portions: [['STD', '', '350']], favourite: true },
  { code: 'ST-WINGS', name: 'Chicken wings', category: 'STARTERS', charge: 'FOOD', portions: [['HALF', 'Half', '600'], ['FULL', 'Full', '1000']] },
  { code: 'ST-CHIPS', name: 'Chips masala', category: 'STARTERS', charge: 'FOOD', portions: [['STD', '', '450']], favourite: true },
  { code: 'MN-BURGER', name: 'Klub beef burger', category: 'MAINS', charge: 'FOOD', portions: [['STD', '', '1100']], modifiers: ['DONENESS', 'EXTRAS'] },
  { code: 'MN-TILAPIA', name: 'Whole fried tilapia', category: 'MAINS', charge: 'FOOD', portions: [['STD', '', '1500']], modifiers: ['SIDE'] },
  { code: 'MN-CURRY', name: 'Chicken curry', category: 'MAINS', charge: 'FOOD', portions: [['STD', '', '1250']], modifiers: ['SIDE'] },
  { code: 'GR-GOAT', name: 'Goat nyama choma', category: 'GRILL', charge: 'FOOD', portions: [['HALFKG', '½ kg', '1300'], ['KG', '1 kg', '2400']], modifiers: ['SIDE'], favourite: true },
  { code: 'GR-STEAK', name: 'Sirloin steak', category: 'GRILL', charge: 'FOOD', portions: [['STD', '', '1800']], modifiers: ['DONENESS', 'SIDE'] },
  { code: 'DS-ICECREAM', name: 'Ice cream', category: 'DESSERTS', charge: 'FOOD', portions: [['STD', '', '400']] },
  { code: 'CF-AMERICANO', name: 'Americano', category: 'COFFEE', charge: 'BEVERAGE', portions: [['STD', '', '250']], favourite: true },
  { code: 'CF-LATTE', name: 'Café latte', category: 'COFFEE', charge: 'BEVERAGE', portions: [['STD', '', '320']] },
  { code: 'CF-CHAI', name: 'Kenyan chai', category: 'COFFEE', charge: 'BEVERAGE', portions: [['STD', '', '200']] },
  { code: 'SD-SODA', name: 'Soda 300 ml', category: 'SOFT', charge: 'BEVERAGE', portions: [['STD', '', '150']], favourite: true },
  { code: 'SD-WATER', name: 'Mineral water 500 ml', category: 'SOFT', charge: 'BEVERAGE', portions: [['STD', '', '120']] },
  { code: 'SD-JUICE', name: 'Fresh juice', category: 'SOFT', charge: 'BEVERAGE', portions: [['STD', '', '300']], modifiers: ['ICE'] },
  { code: 'BR-TUSKER', name: 'Tusker Lager 500 ml', category: 'BEER', charge: 'BEVERAGE', alcohol: true, portions: [['STD', '', '350']], favourite: true },
  { code: 'BR-GUINNESS', name: 'Guinness 500 ml', category: 'BEER', charge: 'BEVERAGE', alcohol: true, portions: [['STD', '', '380']] },
  { code: 'BR-WHITECAP', name: 'White Cap 500 ml', category: 'BEER', charge: 'BEVERAGE', alcohol: true, portions: [['STD', '', '350']] },
  { code: 'BR-CIDER', name: 'Savanna cider', category: 'BEER', charge: 'BEVERAGE', alcohol: true, portions: [['STD', '', '400']] },
  { code: 'SP-JW-BLACK', name: 'Johnnie Walker Black', category: 'SPIRITS', charge: 'BEVERAGE', alcohol: true, portions: [['TOT', 'Tot', '450'], ['DBL', 'Double', '850'], ['BTL', 'Bottle 750 ml', '7500']], modifiers: ['MIXER', 'ICE'] },
  { code: 'SP-GILBEYS', name: "Gilbey's gin", category: 'SPIRITS', charge: 'BEVERAGE', alcohol: true, portions: [['TOT', 'Tot', '250'], ['DBL', 'Double', '450'], ['BTL', 'Bottle 750 ml', '3200']], modifiers: ['MIXER', 'ICE'] },
  { code: 'SP-TANQUERAY', name: 'Tanqueray gin', category: 'SPIRITS', charge: 'BEVERAGE', alcohol: true, portions: [['TOT', 'Tot', '400'], ['DBL', 'Double', '750'], ['BTL', 'Bottle 750 ml', '6500']], modifiers: ['MIXER', 'ICE'] },
  { code: 'WN-HOUSE-RED', name: 'House red wine', category: 'WINE', charge: 'BEVERAGE', alcohol: true, portions: [['GLS', 'Glass', '500'], ['BTL', 'Bottle', '2800']] },
  { code: 'WN-HOUSE-WHITE', name: 'House white wine', category: 'WINE', charge: 'BEVERAGE', alcohol: true, portions: [['GLS', 'Glass', '500'], ['BTL', 'Bottle', '2800']] },
  { code: 'CK-DAWA', name: 'Dawa', category: 'COCKTAILS', charge: 'BEVERAGE', alcohol: true, portions: [['STD', '', '650']], favourite: true },
  { code: 'CK-MOJITO', name: 'Mojito', category: 'COCKTAILS', charge: 'BEVERAGE', alcohol: true, portions: [['STD', '', '700']] },
  { code: 'SH-WATER', name: 'Bottled water 1 L', category: 'SHOP', charge: 'OTHER', portions: [['STD', '', '150']] },
  { code: 'SH-TOOTHKIT', name: 'Toothbrush kit', category: 'SHOP', charge: 'OTHER', portions: [['STD', '', '250']] },
  { code: 'SH-SUNCREAM', name: 'Sun cream', category: 'SHOP', charge: 'OTHER', portions: [['STD', '', '900']] },
  { code: 'LS-POOL', name: 'Pool table (per game)', category: 'LEISURE', charge: 'OTHER', portions: [['STD', '', '100']] },
  { code: 'LS-SWIM', name: 'Swimming day pass', category: 'LEISURE', charge: 'OTHER', portions: [['ADULT', 'Adult', '500'], ['CHILD', 'Child', '300']] },
  { code: 'LS-FIVEASIDE', name: '5-a-side pitch (1 hour)', category: 'LEISURE', charge: 'OTHER', portions: [['STD', '', '3000']] },
  { code: 'SPA-MASSAGE', name: 'Full body massage 60 min', category: 'SPA', charge: 'OTHER', portions: [['STD', '', '3500']] },
  // Loyalty test dishes (docs/how-to-test-loyalty.md): prices are KES 1.18 × a round amount before VAT and
  // catering levy, so the addendum's worked examples (KES 5,000 eligible etc.) come out exactly.
  ...LOYALTY_TEST_ITEMS(),
];

function LOYALTY_TEST_ITEMS(): SeedItem[] {
  return [
    { code: 'LY-PLATTER', name: 'Sharing platter (5,000 + tax)', category: 'GRILL', charge: 'FOOD', portions: [['STD', '', '5900']] },
    { code: 'LY-GRILL', name: 'Mixed grill for two (3,000 + tax)', category: 'GRILL', charge: 'FOOD', portions: [['STD', '', '3540']] },
    { code: 'LY-CAKE', name: 'Celebration cake (2,000 + tax)', category: 'GRILL', charge: 'FOOD', portions: [['STD', '', '2360']] },
    { code: 'LY-FEAST', name: 'Banquet feast (10,000 + tax)', category: 'GRILL', charge: 'FOOD', portions: [['STD', '', '11800']] },
  ];
}

/** Which categories each kind of outlet sells. */
function categoriesFor(type: string, sellsAlcohol: boolean, code: string): string[] {
  const drinks = sellsAlcohol ? ['SOFT', 'BEER', 'SPIRITS', 'WINE', 'COCKTAILS'] : ['SOFT'];
  switch (type) {
    case 'bar':
      return ['STARTERS', 'GRILL', ...drinks];
    case 'restaurant':
    case 'kitchen':
      return code.endsWith('-STAFFKIT')
        ? ['MAINS', 'SOFT']
        : ['BREAKFAST', 'STARTERS', 'MAINS', 'GRILL', 'DESSERTS', 'COFFEE', ...drinks];
    case 'shop':
      return ['SHOP', 'SOFT'];
    case 'leisure':
      return ['LEISURE', 'SOFT'];
    case 'spa':
      return ['SPA'];
    default:
      return [];
  }
}

export async function seedPos(client: Client): Promise<void> {
  for (const [i, c] of POS_CATEGORIES.entries()) {
    await client.query(
      `INSERT INTO menu_categories (code, name, route, sort_order) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`,
      [c.code, c.name, c.route, i],
    );
  }
  for (const g of POS_MODIFIERS) {
    await client.query(
      `INSERT INTO modifier_groups (code, name, min_select, max_select) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`,
      [g.code, g.name, g.min, g.max],
    );
    for (const [i, [code, name, delta]] of g.options.entries()) {
      await client.query(
        `INSERT INTO modifier_options (group_id, code, name, price_delta, sort_order)
         SELECT id, $2, $3, $4, $5 FROM modifier_groups WHERE code = $1 ON CONFLICT (group_id, code) DO NOTHING`,
        [g.code, code, name, delta, i],
      );
    }
  }
  for (const item of POS_ITEMS) {
    await client.query(
      `INSERT INTO menu_items (code, name, category_id, charge_code, is_alcohol)
       SELECT $1, $2, id, $4, $5 FROM menu_categories WHERE code = $3 ON CONFLICT (code) DO NOTHING`,
      [item.code, item.name, item.category, item.charge, item.alcohol ?? false],
    );
    for (const [i, [code, name]] of item.portions.entries()) {
      await client.query(
        `INSERT INTO menu_item_portions (item_id, code, name, sort_order)
         SELECT id, $2, $3, $4 FROM menu_items WHERE code = $1 ON CONFLICT (item_id, code) DO NOTHING`,
        [item.code, code, name, i],
      );
    }
    for (const [i, group] of (item.modifiers ?? []).entries()) {
      await client.query(
        `INSERT INTO menu_item_modifier_groups (item_id, group_id, sort_order)
         SELECT mi.id, g.id, $3 FROM menu_items mi, modifier_groups g WHERE mi.code = $1 AND g.code = $2 ON CONFLICT DO NOTHING`,
        [item.code, group, i],
      );
    }
  }

  const { rows: properties } = await client.query<{ id: string; code: string }>('SELECT id, code FROM properties ORDER BY code');
  for (const p of properties) {
    // One kitchen per property; each bar outlet is its own bar station.
    await client.query(
      `INSERT INTO pos_stations (property_id, code, name, kind, printer_name) VALUES ($1, 'KITCHEN', 'Main kitchen', 'kitchen', $2)
       ON CONFLICT (property_id, code) DO NOTHING`,
      [p.id, `${p.code}-KITCHEN-PRN`],
    );
    await client.query(
      `INSERT INTO pos_stations (property_id, code, name, kind, printer_name) VALUES ($1, 'SERVICE-BAR', 'Service bar', 'bar', $2)
       ON CONFLICT (property_id, code) DO NOTHING`,
      [p.id, `${p.code}-BAR-PRN`],
    );
    await client.query(
      `INSERT INTO house_accounts (property_id, code, name, kind, monthly_limit, cost_centre) VALUES
         ($1, 'STAFF-MEALS', 'Staff meals', 'staff_meals', 150000, 'STAFF'),
         ($1, 'DIRECTORS', 'Directors', 'director', NULL, 'DIRECTORS'),
         ($1, 'ENTERTAIN', 'Management entertainment', 'entertainment', 50000, 'MARKETING')
       ON CONFLICT (property_id, code) DO NOTHING`,
      [p.id],
    );

    const { rows: outlets } = await client.query<{ id: string; code: string; name: string; type: string; sellsAlcohol: boolean }>(
      `SELECT id, code, name, type::text AS type, sells_alcohol AS "sellsAlcohol" FROM outlets WHERE property_id = $1 AND pos_enabled ORDER BY code`,
      [p.id],
    );
    for (const o of outlets) {
      const short = o.code.replace(/^[A-Z0-9]+-/, '').slice(0, 16);
      let barStation = 'SERVICE-BAR';
      if (o.type === 'bar') {
        barStation = short.length >= 2 ? short : `${short}-BAR`;
        await client.query(
          `INSERT INTO pos_stations (property_id, code, name, kind, printer_name) VALUES ($1, $2, $3, 'bar', $4)
           ON CONFLICT (property_id, code) DO NOTHING`,
          [p.id, barStation, o.name, `${o.code}-PRN`],
        );
      }
      for (const [route, station] of [['kitchen', 'KITCHEN'], ['bar', barStation]] as const) {
        await client.query(
          `INSERT INTO outlet_station_routes (outlet_id, property_id, route, station_id)
           SELECT $1, $2, $3, id FROM pos_stations WHERE property_id = $2 AND code = $4 ON CONFLICT DO NOTHING`,
          [o.id, p.id, route, station],
        );
      }

      const cats = categoriesFor(o.type, o.sellsAlcohol, o.code);
      const { rows: priced } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM outlet_menu_prices WHERE outlet_id = $1', [o.id]);
      if (!priced[0].n) {
        let sort = 0;
        for (const item of POS_ITEMS.filter((x) => cats.includes(x.category))) {
          for (const [code, , price] of item.portions) {
            await client.query(
              `INSERT INTO outlet_menu_prices (property_id, outlet_id, item_id, portion_id, price, is_favourite, sort_order)
               SELECT $1, $2, mi.id, mp.id, $5, $6, $7 FROM menu_items mi JOIN menu_item_portions mp ON mp.item_id = mi.id
                WHERE mi.code = $3 AND mp.code = $4
               ON CONFLICT (outlet_id, portion_id) DO NOTHING`,
              [p.id, o.id, item.code, code, price, item.favourite ?? false, sort++],
            );
          }
        }
      }

      // Loyalty test dishes also go on outlets that were priced before they existed.
      if (cats.includes('GRILL') && !o.code.endsWith('-STAFFKIT')) {
        let sort = 900;
        for (const item of POS_ITEMS.filter((x) => x.code.startsWith('LY-'))) {
          await client.query(
            `INSERT INTO outlet_menu_prices (property_id, outlet_id, item_id, portion_id, price, is_favourite, sort_order)
             SELECT $1, $2, mi.id, mp.id, $4, false, $5 FROM menu_items mi JOIN menu_item_portions mp ON mp.item_id = mi.id
              WHERE mi.code = $3 AND mp.code = 'STD'
             ON CONFLICT (outlet_id, portion_id) DO NOTHING`,
            [p.id, o.id, item.code, item.portions[0][2], sort++],
          );
        }
      }

      // Tables for sit-down outlets (POS-05).
      if (['bar', 'restaurant', 'kitchen'].includes(o.type) && !o.code.endsWith('-STAFFKIT')) {
        const count = o.type === 'bar' ? 8 : 12;
        for (let t = 1; t <= count; t++) {
          await client.query(
            `INSERT INTO pos_tables (property_id, outlet_id, code, area, seats, sort_order) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (outlet_id, code) DO NOTHING`,
            [p.id, o.id, `T${t}`, t <= count / 2 ? 'Inside' : 'Terrace', t % 3 === 0 ? 6 : 4, t],
          );
        }
      }

      // Placeholder licensed hours 10:00–02:00 every day until the client confirms
      // each outlet's licence (POS-17).
      if (o.sellsAlcohol) {
        const { rows: hours } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM outlet_liquor_hours WHERE outlet_id = $1', [o.id]);
        if (!hours[0].n) {
          for (let d = 1; d <= 7; d++) {
            await client.query(
              `INSERT INTO outlet_liquor_hours (outlet_id, property_id, weekday, opens_at, closes_at) VALUES ($1, $2, $3, '10:00', '02:00')`,
              [o.id, p.id, d],
            );
          }
        }
      }
    }
  }

  // Happy hour at K1's Shed Bar: 20% off beer, weekdays 17:00–19:00 (POS-03).
  await client.query(
    `INSERT INTO price_rules (property_id, outlet_id, name, category_id, weekdays, starts_at, ends_at, discount_percent, valid_from)
     SELECT o.property_id, o.id, 'Happy hour beer', c.id, '{1,2,3,4,5}', '17:00', '19:00', 20, '2026-01-01'
       FROM outlets o, menu_categories c
      WHERE o.code = 'K1-SHED' AND c.code = 'BEER'
        AND NOT EXISTS (SELECT 1 FROM price_rules r WHERE r.outlet_id = o.id AND r.name = 'Happy hour beer')`,
  );
}
