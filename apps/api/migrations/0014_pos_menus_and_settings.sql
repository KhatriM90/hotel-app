-- 0014 POS master data and outlet settings.
--
--  * Business-day cut-off per property (CFG-01) with an optional per-outlet
--    override, used to date each outlet's trading day (§9 business date).
--    Closing a day stays a manual action (Manish Khatri, 28 Oct 2026).
--  * Outlet POS settings: service types (POS-04), liquor-licence hours and
--    policy (POS-17), stock policy (POS-12), stations and kitchen/bar routing
--    (CFG-03, POS-07, POS-19).
--  * Group menu (CFG-05, POS-02): categories, items, portions (bottle/glass),
--    modifier groups; outlet price lists with availability (POS-03, POS-12).
--  * Scheduled price rules such as happy hour (POS-03), tables (POS-05) and
--    house accounts (POS-18).
--
-- Menus, prices, tables, hours and house accounts are loaded by the seed
-- script as test data until the client sends theirs.

-- ---------------------------------------------------------------------------
-- Property and outlet settings
-- ---------------------------------------------------------------------------
-- Discounts up to this percentage need no manager approval (POS-03, SEC-02).
ALTER TABLE properties
  ADD COLUMN pos_discount_free_percent numeric(5, 2) NOT NULL DEFAULT 0
    CHECK (pos_discount_free_percent BETWEEN 0 AND 100);

ALTER TABLE outlets
  ADD COLUMN pos_enabled boolean NOT NULL DEFAULT false,
  -- NULL = use the property's cut-off. A restaurant that serves breakfast before
  -- 08:00 can start its trading day earlier than the bars.
  ADD COLUMN business_day_cutoff time,
  ADD COLUMN service_types text[] NOT NULL DEFAULT '{table,counter,takeaway}'
    CHECK (cardinality(service_types) > 0 AND service_types <@ ARRAY['table', 'counter', 'takeaway', 'room_service']),
  ADD COLUMN liquor_policy text NOT NULL DEFAULT 'block' CHECK (liquor_policy IN ('block', 'warn')),
  ADD COLUMN stock_policy text NOT NULL DEFAULT 'warn' CHECK (stock_policy IN ('block', 'warn'));

-- Outlets that ring up sales on the POS. Accommodation, housekeeping, laundry,
-- stores and the complimentary outlet post through the front desk or stock instead.
UPDATE outlets SET pos_enabled = true WHERE type IN ('bar', 'restaurant', 'kitchen', 'shop', 'leisure', 'spa');
UPDATE outlets SET service_types = '{table,counter,takeaway,room_service}' WHERE type IN ('restaurant', 'kitchen');
UPDATE outlets SET service_types = '{counter}' WHERE type IN ('shop', 'leisure', 'spa');

-- Licensed alcohol sale hours per outlet and ISO weekday (1 = Monday … 7 = Sunday).
-- closes_at at or before opens_at means the window runs past midnight.
-- No row for a weekday = no alcohol sales that day (POS-17).
CREATE TABLE outlet_liquor_hours (
  outlet_id   uuid NOT NULL,
  property_id uuid NOT NULL,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  opens_at    time NOT NULL,
  closes_at   time NOT NULL,
  PRIMARY KEY (outlet_id, weekday),
  FOREIGN KEY (outlet_id, property_id) REFERENCES outlets (id, property_id)
);

-- ---------------------------------------------------------------------------
-- Stations: where tickets print (CFG-03, POS-07). The printer name is the
-- destination the property's print bridge will use (INT-04).
-- ---------------------------------------------------------------------------
CREATE TABLE pos_stations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES properties (id),
  code         text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,16}$'),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('kitchen', 'bar', 'other')),
  printer_name text,
  is_active    boolean NOT NULL DEFAULT true,
  UNIQUE (property_id, code),
  UNIQUE (id, property_id)
);

-- Food goes to a kitchen, drinks to a bar (POS-07), per outlet (POS-19).
CREATE TABLE outlet_station_routes (
  outlet_id   uuid NOT NULL,
  property_id uuid NOT NULL,
  route       text NOT NULL CHECK (route IN ('kitchen', 'bar')),
  station_id  uuid NOT NULL,
  PRIMARY KEY (outlet_id, route),
  FOREIGN KEY (outlet_id, property_id) REFERENCES outlets (id, property_id),
  FOREIGN KEY (station_id, property_id) REFERENCES pos_stations (id, property_id)
);

-- ---------------------------------------------------------------------------
-- Group menu (CFG-05: defined once, enabled per outlet with its own price)
-- ---------------------------------------------------------------------------
CREATE TABLE menu_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{2,16}$'),
  name       text NOT NULL,
  -- Which station prepares it; 'none' prints no ticket (shop items, entry fees).
  route      text NOT NULL CHECK (route IN ('kitchen', 'bar', 'none')),
  sort_order smallint NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true
);

CREATE TABLE menu_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{2,24}$'),
  name          text NOT NULL,
  description   text,
  category_id   uuid NOT NULL REFERENCES menu_categories (id),
  -- Tax category (POS-02): the charge code carries the tax codes (VAT, levy).
  charge_code   text NOT NULL REFERENCES charge_codes (code),
  is_alcohol    boolean NOT NULL DEFAULT false,      -- liquor-hour lock (POS-17)
  image_url     text,
  sap_item_code text,                                -- SAP-02/03, TBC from the mapping workbook
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX menu_items_category ON menu_items (category_id);
CREATE TRIGGER menu_items_touch BEFORE UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

-- Portions and sizes: glass/bottle, tot/double, half/full (POS-02, INV-04).
-- Every item has at least one; single-size items use code STD.
CREATE TABLE menu_item_portions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    uuid NOT NULL REFERENCES menu_items (id),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9]{2,8}$'),
  name       text NOT NULL,          -- shown after the item name; '' for STD
  sort_order smallint NOT NULL DEFAULT 0,
  UNIQUE (item_id, code)
);

-- Modifiers and extras (POS-02): "No ice", "Extra cheese +150".
CREATE TABLE modifier_groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{2,16}$'),
  name       text NOT NULL,
  min_select smallint NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select smallint NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  CHECK (max_select >= min_select)
);

CREATE TABLE modifier_options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL REFERENCES modifier_groups (id),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,16}$'),
  name        text NOT NULL,
  price_delta money_amount NOT NULL DEFAULT 0 CHECK (price_delta >= 0),
  sort_order  smallint NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (group_id, code)
);

CREATE TABLE menu_item_modifier_groups (
  item_id    uuid NOT NULL REFERENCES menu_items (id),
  group_id   uuid NOT NULL REFERENCES modifier_groups (id),
  sort_order smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, group_id)
);

-- ---------------------------------------------------------------------------
-- Outlet price list (POS-03 outlet-specific prices, POS-12 availability,
-- POS-01 favourites). Prices include VAT and levy. Each order line keeps its
-- own price snapshot, so a later price change never rewrites a sale (§9).
-- ---------------------------------------------------------------------------
CREATE TABLE outlet_menu_prices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL,
  outlet_id       uuid NOT NULL,
  item_id         uuid NOT NULL REFERENCES menu_items (id),
  portion_id      uuid NOT NULL REFERENCES menu_item_portions (id),
  price           money_amount NOT NULL CHECK (price >= 0),
  is_available    boolean NOT NULL DEFAULT true,     -- "86'd": never sold silently (POS-12)
  is_favourite    boolean NOT NULL DEFAULT false,
  -- Portions left today; NULL = not counted. Sending more than this warns or
  -- blocks per the outlet's stock policy (POS-12). Full stock control is INV-*.
  stock_remaining quantity CHECK (stock_remaining IS NULL OR stock_remaining >= 0),
  sort_order      smallint NOT NULL DEFAULT 0,
  updated_by      uuid REFERENCES users (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outlet_id, portion_id),
  FOREIGN KEY (outlet_id, property_id) REFERENCES outlets (id, property_id)
);
CREATE INDEX outlet_menu_prices_outlet ON outlet_menu_prices (outlet_id);
CREATE TRIGGER outlet_menu_prices_touch BEFORE UPDATE ON outlet_menu_prices
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

-- Scheduled discounts such as happy hour (POS-03). Applied when a line is
-- added and stored on the line; the best matching rule wins.
CREATE TABLE price_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL REFERENCES properties (id),
  outlet_id        uuid,                       -- NULL = every outlet of the property
  name             text NOT NULL,
  category_id      uuid REFERENCES menu_categories (id),
  item_id          uuid REFERENCES menu_items (id),
  weekdays         smallint[] NOT NULL CHECK (cardinality(weekdays) > 0 AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  starts_at        time NOT NULL,
  ends_at          time NOT NULL CHECK (ends_at > starts_at),
  discount_percent numeric(5, 2) NOT NULL CHECK (discount_percent > 0 AND discount_percent <= 100),
  valid_from       date NOT NULL,
  valid_to         date,
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (outlet_id, property_id) REFERENCES outlets (id, property_id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

-- ---------------------------------------------------------------------------
-- Tables (POS-05)
-- ---------------------------------------------------------------------------
CREATE TABLE pos_tables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  outlet_id   uuid NOT NULL,
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9-]{1,8}$'),
  area        text NOT NULL DEFAULT 'Main',
  seats       smallint NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 40),
  sort_order  smallint NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (outlet_id, code),
  UNIQUE (id, property_id),
  FOREIGN KEY (outlet_id, property_id) REFERENCES outlets (id, property_id)
);

-- ---------------------------------------------------------------------------
-- House accounts (POS-18): staff meals, director/owner consumption and
-- management entertainment. Never guest revenue; limits per calendar month.
-- ---------------------------------------------------------------------------
CREATE TABLE house_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES properties (id),
  code          text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,16}$'),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('staff_meals', 'director', 'entertainment', 'other')),
  monthly_limit money_amount CHECK (monthly_limit IS NULL OR monthly_limit >= 0),
  cost_centre   text,                       -- where the cost is allocated (SAP dimension/GL, TBC)
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  UNIQUE (id, property_id)
);

-- ---------------------------------------------------------------------------
-- Row-level security (SEC-06, AT-18) and grants. The group menu is shared.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outlet_liquor_hours', 'pos_stations', 'outlet_station_routes', 'outlet_menu_prices',
                           'price_rules', 'pos_tables', 'house_accounts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id))',
                   t || '_scope', t);
  END LOOP;
END;
$$;

GRANT SELECT, INSERT, UPDATE ON menu_categories, menu_items, menu_item_portions, modifier_groups, modifier_options TO hotel_app;
GRANT SELECT, INSERT, DELETE ON menu_item_modifier_groups TO hotel_app;
GRANT SELECT, INSERT, UPDATE ON pos_stations, outlet_menu_prices, price_rules, pos_tables, house_accounts TO hotel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON outlet_liquor_hours, outlet_station_routes TO hotel_app;
