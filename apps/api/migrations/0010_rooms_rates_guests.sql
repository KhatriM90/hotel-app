-- 0010 Rooms, room types and housekeeping status (CFG-02), rate plans with
-- weekday/weekend/seasonal prices and occupancy supplements (RES-05),
-- booking policies (RES-07, FD-06), companies/agents and guest profiles with
-- restricted identity documents (FD-02).
--
-- Master data (room types, rooms, rates) is loaded by the seed script, not
-- here: room numbers and prices are test data until the client supplies theirs.

-- ---------------------------------------------------------------------------
-- Room types and rooms (CFG-02)
-- ---------------------------------------------------------------------------
CREATE TABLE room_types (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL REFERENCES properties (id),
  code           text NOT NULL CHECK (code ~ '^[A-Z0-9]{2,8}$'),
  name           text NOT NULL,
  description    text,
  base_occupancy smallint NOT NULL DEFAULT 2 CHECK (base_occupancy >= 1),
  max_adults     smallint NOT NULL DEFAULT 2 CHECK (max_adults >= 1),
  max_occupancy  smallint NOT NULL DEFAULT 3 CHECK (max_occupancy >= max_adults),
  beds           text,
  amenities      text[] NOT NULL DEFAULT '{}',
  sort_order     smallint NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  UNIQUE (id, property_id)
);
CREATE TRIGGER room_types_touch BEFORE UPDATE ON room_types
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER room_types_property_immutable BEFORE UPDATE ON room_types
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('property_id');

-- Housekeeping states (HK-01). Reception only allocates clean or inspected rooms (FD-03).
CREATE TYPE hk_status AS ENUM ('clean', 'inspected', 'dirty', 'in_progress');

CREATE TABLE rooms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL,
  room_type_id  uuid NOT NULL,
  number        text NOT NULL CHECK (number ~ '^[A-Z0-9-]{1,10}$'),
  floor         text,
  building      text,
  hk_status     hk_status NOT NULL DEFAULT 'clean',
  hk_updated_at timestamptz NOT NULL DEFAULT now(),
  -- Unsellable rooms never appear in availability (e.g. staff housing, long-term repair).
  is_sellable   boolean NOT NULL DEFAULT true,
  active_from   date,
  active_to     date,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, number),
  UNIQUE (id, property_id),
  FOREIGN KEY (property_id) REFERENCES properties (id),
  -- Same-property foreign key: a room can never point at another property's room type.
  FOREIGN KEY (room_type_id, property_id) REFERENCES room_types (id, property_id),
  CHECK (active_to IS NULL OR active_from IS NULL OR active_to > active_from)
);
CREATE TRIGGER rooms_touch BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER rooms_property_immutable BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('property_id');

-- ---------------------------------------------------------------------------
-- Companies and agents, shared across the group (CFG-05, FD-02, RES-02)
-- ---------------------------------------------------------------------------
CREATE TABLE companies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('company', 'agent')),
  name          text NOT NULL,
  kra_pin       text CHECK (kra_pin IS NULL OR kra_pin ~ '^[A-Z][0-9]{9}[A-Z]$'),
  contact_name  text,
  contact_phone text,
  contact_email text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_name_uq ON companies (kind, lower(name));
CREATE TRIGGER companies_touch BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Rate plans (RES-05). A plan is property-specific (CFG-04). Prices are VAT- and
-- levy-inclusive per night for the room at base occupancy; extra adults and
-- children pay supplements. Each price row covers a date range; the row with
-- the highest priority wins (base season = 0, seasonal overrides > 0).
-- ---------------------------------------------------------------------------
CREATE TABLE rate_plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL REFERENCES properties (id),
  code           text NOT NULL CHECK (code ~ '^[A-Z0-9]{2,12}$'),
  name           text NOT NULL,
  -- Negotiated rates are tied to a company or agent and are not offered to walk-ins.
  is_negotiated  boolean NOT NULL DEFAULT false,
  company_id     uuid REFERENCES companies (id),
  -- ISO weekday numbers (1 = Monday … 7 = Sunday) of nights priced at the weekend rate.
  weekend_days   smallint[] NOT NULL DEFAULT '{5,6}',
  effective_from date NOT NULL,
  effective_to   date,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  UNIQUE (id, property_id),
  CHECK (NOT is_negotiated OR company_id IS NOT NULL),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (weekend_days <@ '{1,2,3,4,5,6,7}'::smallint[])
);
CREATE TRIGGER rate_plans_touch BEFORE UPDATE ON rate_plans
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER rate_plans_property_immutable BEFORE UPDATE ON rate_plans
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('property_id');

-- Price rows are never edited: a change is a new row with a later effective range
-- or a higher priority, so the history of offered prices is kept (RES-05).
CREATE TABLE rate_prices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       uuid NOT NULL,
  rate_plan_id      uuid NOT NULL,
  room_type_id      uuid NOT NULL,
  season_name       text NOT NULL DEFAULT 'Base',
  valid_from        date NOT NULL,
  valid_to          date,                         -- exclusive; NULL = open-ended
  priority          smallint NOT NULL DEFAULT 0,
  weekday_price     money_amount NOT NULL CHECK (weekday_price >= 0),
  weekend_price     money_amount NOT NULL CHECK (weekend_price >= 0),
  extra_adult_price money_amount NOT NULL DEFAULT 0 CHECK (extra_adult_price >= 0),
  child_price       money_amount NOT NULL DEFAULT 0 CHECK (child_price >= 0),
  created_by        uuid REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (rate_plan_id, property_id) REFERENCES rate_plans (id, property_id),
  FOREIGN KEY (room_type_id, property_id) REFERENCES room_types (id, property_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX rate_prices_lookup ON rate_prices (rate_plan_id, room_type_id, valid_from);
CREATE TRIGGER rate_prices_append_only BEFORE UPDATE OR DELETE ON rate_prices
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Booking policies per property (RES-07, FD-06). Snapshotted onto each
-- reservation when it is made, so later policy changes do not rewrite terms.
-- ---------------------------------------------------------------------------
CREATE TABLE booking_policies (
  property_id               uuid PRIMARY KEY REFERENCES properties (id),
  deposit_type              text NOT NULL DEFAULT 'percent' CHECK (deposit_type IN ('none', 'percent', 'nights')),
  deposit_value             numeric(8, 2) NOT NULL DEFAULT 50 CHECK (deposit_value >= 0),
  deposit_due_days          smallint NOT NULL DEFAULT 7 CHECK (deposit_due_days >= 0),
  default_hold_minutes      integer NOT NULL DEFAULT 1440 CHECK (default_hold_minutes BETWEEN 5 AND 20160),
  free_cancellation_hours   integer NOT NULL DEFAULT 48 CHECK (free_cancellation_hours >= 0),
  late_cancellation_nights  smallint NOT NULL DEFAULT 1 CHECK (late_cancellation_nights >= 0),
  no_show_nights            smallint NOT NULL DEFAULT 1 CHECK (no_show_nights >= 0),
  refund_policy             text NOT NULL DEFAULT '',
  check_in_time             time NOT NULL DEFAULT '14:00',
  check_out_time            time NOT NULL DEFAULT '10:00',
  early_check_in_fee        money_amount NOT NULL DEFAULT 0 CHECK (early_check_in_fee >= 0),
  late_check_out_fee        money_amount NOT NULL DEFAULT 0 CHECK (late_check_out_fee >= 0),
  registration_terms        text NOT NULL DEFAULT '',
  updated_by                uuid REFERENCES users (id),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER booking_policies_touch BEFORE UPDATE ON booking_policies
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

INSERT INTO booking_policies (property_id) SELECT id FROM properties;

CREATE FUNCTION app_create_property_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO booking_policies (property_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER properties_create_policy AFTER INSERT ON properties
  FOR EACH ROW EXECUTE FUNCTION app_create_property_policy();

-- ---------------------------------------------------------------------------
-- Guest profiles, shared across the group (CFG-05, FD-02).
-- Identity documents live in a separate table that only roles with
-- guest.identity permission may read (FD-02, AT-14, SEC-05).
-- ---------------------------------------------------------------------------
CREATE TABLE guests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name    text NOT NULL CHECK (length(first_name) BETWEEN 1 AND 80),
  last_name     text NOT NULL CHECK (length(last_name) BETWEEN 1 AND 80),
  email         text,
  phone         text,
  nationality   char(2) CHECK (nationality ~ '^[A-Z]{2}$'),   -- ISO 3166-1 alpha-2
  date_of_birth date,
  address       text,
  company_id    uuid REFERENCES companies (id),
  preferences   text,
  notes         text,
  -- SEC-05: recorded consent for marketing; never assumed.
  marketing_consent_at timestamptz,
  created_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guests_name ON guests (lower(last_name), lower(first_name));
CREATE INDEX guests_phone ON guests (phone) WHERE phone IS NOT NULL;
CREATE INDEX guests_email ON guests (lower(email)) WHERE email IS NOT NULL;
CREATE TRIGGER guests_touch BEFORE UPDATE ON guests
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE guest_identity_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id        uuid NOT NULL REFERENCES guests (id),
  document_type   text NOT NULL CHECK (document_type IN ('national_id', 'passport', 'alien_id', 'driving_licence', 'other')),
  document_number text NOT NULL CHECK (length(document_number) BETWEEN 3 AND 40),
  issuing_country char(2) NOT NULL CHECK (issuing_country ~ '^[A-Z]{2}$'),
  expiry_date     date,
  verified_by     uuid REFERENCES users (id),
  verified_at     timestamptz,
  -- Where the property recorded it; the profile itself is group-wide.
  property_id     uuid REFERENCES properties (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guest_identity_documents_guest ON guest_identity_documents (guest_id, created_at DESC);
CREATE UNIQUE INDEX guest_identity_documents_uq ON guest_identity_documents (guest_id, document_type, issuing_country, document_number);

-- ---------------------------------------------------------------------------
-- Row-level security (SEC-06, AT-18). Guests, companies and identity documents
-- are group-wide by design (CFG-05); access to them is controlled by permissions.
-- ---------------------------------------------------------------------------
ALTER TABLE room_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_types FORCE ROW LEVEL SECURITY;
CREATE POLICY room_types_scope ON room_types
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));

ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms FORCE ROW LEVEL SECURITY;
CREATE POLICY rooms_scope ON rooms
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));

ALTER TABLE rate_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_plans_scope ON rate_plans
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));

ALTER TABLE rate_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_prices_scope ON rate_prices
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));

ALTER TABLE booking_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_policies_scope ON booking_policies
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));

GRANT SELECT, INSERT, UPDATE ON room_types, rooms, rate_plans, companies, guests TO hotel_app;
GRANT SELECT, INSERT ON rate_prices TO hotel_app;
GRANT SELECT, INSERT, UPDATE ON guest_identity_documents TO hotel_app;
GRANT SELECT, UPDATE ON booking_policies TO hotel_app;
