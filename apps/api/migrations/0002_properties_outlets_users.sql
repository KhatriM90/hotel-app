-- 0002 Group → property → outlet structure (CFG-01, CFG-03, CFG-04),
-- users, roles and property access (SEC-01, SEC-06).

-- One legal entity, one KRA PIN for all three properties (brief "Planning assumptions").
CREATE TABLE legal_entity (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name       text NOT NULL,
  kra_pin    text CHECK (kra_pin IS NULL OR kra_pin ~ '^[A-Z][0-9]{9}[A-Z]$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER legal_entity_touch BEFORE UPDATE ON legal_entity
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE properties (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{2,4}$'),
  name                  text NOT NULL,
  location              text NOT NULL,
  is_head_office        boolean NOT NULL DEFAULT false,
  currency              char(3) NOT NULL DEFAULT 'KES',
  timezone              text NOT NULL DEFAULT 'Africa/Nairobi',
  -- Calendar time before this cut-off belongs to the previous trading day (§9 business date).
  business_day_cutoff   time NOT NULL DEFAULT '04:00',
  -- Advanced only by the property's night audit (BIL-10).
  current_business_date date NOT NULL,
  contact_phone         text,
  contact_email         text,
  address               text,
  document_branding     jsonb NOT NULL DEFAULT '{}'::jsonb,
  sap_branch_id         integer,          -- SAP BPLId (SAP-13), TBC with client
  sap_dimension1        text NOT NULL,    -- SAP Dimension 1 = property (SAP-15)
  etims_branch_id       text,             -- KRA bhfId (INT-02), TBC with client
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX properties_one_head_office ON properties (is_head_office) WHERE is_head_office;
CREATE UNIQUE INDEX properties_sap_branch_uq ON properties (sap_branch_id) WHERE sap_branch_id IS NOT NULL;
CREATE UNIQUE INDEX properties_etims_branch_uq ON properties (etims_branch_id) WHERE etims_branch_id IS NOT NULL;
CREATE TRIGGER properties_touch BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TYPE outlet_type AS ENUM ('restaurant', 'bar', 'room_service', 'store', 'conference', 'leisure', 'other');
CREATE TYPE revenue_centre AS ENUM ('ROOMS', 'REST', 'BAR', 'RSVC', 'CONF', 'LEIS', 'OTHER');

CREATE TABLE outlets (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            uuid NOT NULL REFERENCES properties (id),
  code                   text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,16}$'),
  name                   text NOT NULL,
  type                   outlet_type NOT NULL,
  revenue_centre         revenue_centre NOT NULL,       -- SAP Dimension 2 (SAP-15)
  issuing_warehouse_code text CHECK (issuing_warehouse_code ~ '^[A-Z0-9-]{2,8}$'), -- SAP-14, one per outlet
  sells_alcohol          boolean NOT NULL DEFAULT false, -- liquor-hour lock applies (POS-17)
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  UNIQUE (id, property_id)
);
CREATE TRIGGER outlets_touch BEFORE UPDATE ON outlets
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER outlets_property_immutable BEFORE UPDATE ON outlets
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('property_id');

CREATE TABLE roles (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  is_group_role boolean NOT NULL DEFAULT false,
  description   text
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username       text NOT NULL CHECK (username ~ '^[a-z0-9._-]{3,64}$'),
  display_name   text NOT NULL,
  email          text,
  password_hash  text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  mfa_enabled    boolean NOT NULL DEFAULT false,
  -- Group users (owner, group accounts, area managers) see every property (SEC-06).
  all_properties boolean NOT NULL DEFAULT false,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE user_roles (
  user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_code text NOT NULL REFERENCES roles (code),
  PRIMARY KEY (user_id, role_code)
);

CREATE TABLE user_property_access (
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES properties (id),
  PRIMARY KEY (user_id, property_id)
);

-- Row-level security: property-scoped tables (SEC-06, AT-18).
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties FORCE ROW LEVEL SECURITY;
CREATE POLICY properties_scope ON properties
  USING (app_property_visible(id)) WITH CHECK (app_property_visible(id));

ALTER TABLE outlets ENABLE ROW LEVEL SECURITY;
ALTER TABLE outlets FORCE ROW LEVEL SECURITY;
CREATE POLICY outlets_scope ON outlets
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));

-- Reference data -------------------------------------------------------------
INSERT INTO legal_entity (id, name, kra_pin) VALUES (1, 'Hotel group (legal name TBC)', NULL);

INSERT INTO properties (code, name, location, is_head_office, current_business_date, sap_dimension1) VALUES
  ('K1', 'K1 Klubhouse',             'Parklands, Nairobi',  true,  CURRENT_DATE, 'K1'),
  ('SW', 'Small World Country Club', 'Lukenya, Athi River', false, CURRENT_DATE, 'SW'),
  ('KM', 'Kahama Mombasa',           'Mombasa',             false, CURRENT_DATE, 'KM');

INSERT INTO roles (code, name, is_group_role, description) VALUES
  ('owner',          'Owner',               true,  'Group owner; all properties (SEC-01, SEC-06)'),
  ('group_accounts', 'Group accounts',      true,  'Group accounting; all properties (SEC-06, RPT-08)'),
  ('area_manager',   'Area manager',        true,  'Oversees several or all properties (SEC-06)'),
  ('admin',          'System administrator',true,  'Technical administration'),
  ('manager',        'Manager',             false, 'Property manager (SEC-01)'),
  ('receptionist',   'Receptionist',        false, 'Front desk (SEC-01)'),
  ('cashier',        'Cashier',             false, 'Cashier (SEC-01)'),
  ('waiter',         'Waiter',              false, 'Restaurant service (SEC-01)'),
  ('bartender',      'Bartender',           false, 'Bar service (SEC-01)'),
  ('kitchen',        'Kitchen',             false, 'Kitchen staff (SEC-01)'),
  ('housekeeper',    'Housekeeper',         false, 'Housekeeping (SEC-01)'),
  ('storekeeper',    'Storekeeper',         false, 'Stores (SEC-01)'),
  ('accountant',     'Accountant',          false, 'Property accounts (SEC-01)');
