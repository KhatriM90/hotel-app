-- 0011 Reservations and stays (RES-01 … RES-08), front desk (FD-01 … FD-08)
-- and the approval record used for overrides and waivers (SEC-02).
--
-- Model (brief §9 "Accommodation"):
--   reservation (K1-BK-…)  one booking reference, possibly several rooms (RES-08)
--     └─ stay (K1-ST-…)    one room's occupancy; permanent identity that survives
--                          room moves (FD-05, AT-05) and carries the lifecycle (RES-03)
--          ├─ stay_nights       agreed price per night, preserved on amendment (RES-05/06)
--          ├─ room_allocations  which physical room on which nights; an exclusion
--          │                    constraint makes double booking impossible (RES-04, AT-08)
--          └─ folio (K1-FO-…)   the financial account (0012)

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Approvals (SEC-02): who approved a rate override, fee waiver, reversal or
-- credit transfer, and why. Append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES properties (id),
  action       text NOT NULL CHECK (action ~ '^[a-z_.]{3,60}$'),
  entity_type  text NOT NULL,
  entity_id    text,
  requested_by uuid NOT NULL REFERENCES users (id),
  approved_by  uuid NOT NULL REFERENCES users (id),
  reason       text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  details      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, property_id)
);
CREATE INDEX approvals_entity ON approvals (entity_type, entity_id);
CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Reservations (RES-02, RES-07, RES-08)
-- ---------------------------------------------------------------------------
CREATE TYPE booking_source AS ENUM ('walk_in', 'phone', 'email', 'agent', 'website', 'other');

CREATE TABLE reservations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL REFERENCES properties (id),
  number           text NOT NULL UNIQUE,          -- confirmation reference, e.g. K1-BK-000001
  source           booking_source NOT NULL,
  booker_guest_id  uuid NOT NULL REFERENCES guests (id),
  company_id       uuid REFERENCES companies (id),
  agent_id         uuid REFERENCES companies (id),
  agent_reference  text,
  notes            text,
  -- Terms in force when the booking was made (RES-07); later policy edits do not apply.
  policy_snapshot  jsonb NOT NULL,
  deposit_required money_amount NOT NULL DEFAULT 0 CHECK (deposit_required >= 0),
  deposit_due_date date,
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, property_id),
  CHECK (source <> 'agent' OR agent_id IS NOT NULL)
);
CREATE INDEX reservations_property_created ON reservations (property_id, created_at DESC);
CREATE TRIGGER reservations_touch BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER reservations_immutable BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('property_id', 'number', 'created_at', 'created_by', 'policy_snapshot');

-- ---------------------------------------------------------------------------
-- Stays and the booking lifecycle (RES-03)
-- ---------------------------------------------------------------------------
CREATE TYPE stay_status AS ENUM ('enquiry', 'hold', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show');

-- The explicit transition rules (RES-03). Enforced by trigger, so no code path
-- (or manual SQL as the app role) can skip a step.
CREATE TABLE stay_status_transitions (
  from_status stay_status NOT NULL,
  to_status   stay_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO stay_status_transitions VALUES
  ('enquiry',    'hold'),
  ('enquiry',    'confirmed'),
  ('enquiry',    'cancelled'),
  ('hold',       'confirmed'),
  ('hold',       'enquiry'),      -- hold expired: inventory released, enquiry kept
  ('hold',       'cancelled'),
  ('confirmed',  'checked_in'),
  ('confirmed',  'cancelled'),
  ('confirmed',  'no_show'),
  ('checked_in', 'checked_out');

CREATE TABLE stays (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL REFERENCES properties (id),
  number              text NOT NULL UNIQUE,       -- permanent stay ID, e.g. K1-ST-000001 (§9)
  reservation_id      uuid NOT NULL,
  room_type_id        uuid NOT NULL,
  rate_plan_id        uuid NOT NULL,
  -- The room the guest currently occupies or is allocated; history is in room_allocations.
  room_id             uuid,
  status              stay_status NOT NULL,
  arrival_date        date NOT NULL,
  departure_date      date NOT NULL,
  adults              smallint NOT NULL CHECK (adults BETWEEN 1 AND 12),
  children            smallint NOT NULL DEFAULT 0 CHECK (children BETWEEN 0 AND 12),
  primary_guest_id    uuid NOT NULL REFERENCES guests (id),
  hold_expires_at     timestamptz,
  -- FD-06: revised departure time (late checkout), NULL = policy check-out time.
  departure_time      time,
  -- FD-03 / BIL-02: whether outlets may charge to this stay, and up to what amount.
  room_charge_allowed boolean NOT NULL DEFAULT false,
  credit_limit        money_amount CHECK (credit_limit IS NULL OR credit_limit >= 0),
  checked_in_at       timestamptz,
  checked_in_by       uuid REFERENCES users (id),
  checked_out_at      timestamptz,
  checked_out_by      uuid REFERENCES users (id),
  cancelled_at        timestamptz,
  cancelled_by        uuid REFERENCES users (id),
  cancel_reason       text,
  no_show_at          timestamptz,
  -- FD-04: registration card acknowledgement.
  registration_acknowledged_at timestamptz,
  registration_method text CHECK (registration_method IN ('paper_signature', 'digital_signature', 'staff_verified')),
  registration_signed_name text,
  registration_signature text,          -- data URL of a drawn signature, when captured digitally
  notes               text,
  created_by          uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, property_id),
  FOREIGN KEY (reservation_id, property_id) REFERENCES reservations (id, property_id),
  FOREIGN KEY (room_type_id, property_id) REFERENCES room_types (id, property_id),
  FOREIGN KEY (rate_plan_id, property_id) REFERENCES rate_plans (id, property_id),
  FOREIGN KEY (room_id, property_id) REFERENCES rooms (id, property_id),
  CHECK (departure_date > arrival_date),
  CHECK (status <> 'hold' OR hold_expires_at IS NOT NULL),
  CHECK (status NOT IN ('checked_in', 'checked_out') OR (room_id IS NOT NULL AND checked_in_at IS NOT NULL)),
  CHECK (registration_signature IS NULL OR length(registration_signature) <= 200000)
);
CREATE INDEX stays_reservation ON stays (reservation_id);
CREATE INDEX stays_property_arrival ON stays (property_id, arrival_date) WHERE status IN ('hold', 'confirmed');
CREATE INDEX stays_property_departure ON stays (property_id, departure_date) WHERE status = 'checked_in';
CREATE INDEX stays_guest ON stays (primary_guest_id);
CREATE TRIGGER stays_touch BEFORE UPDATE ON stays
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER stays_immutable BEFORE UPDATE ON stays
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('property_id', 'number', 'reservation_id', 'created_at', 'created_by');

CREATE FUNCTION app_stay_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('enquiry', 'hold', 'confirmed') THEN
      RAISE EXCEPTION 'a stay must start as enquiry, hold or confirmed, not %', NEW.status USING ERRCODE = 'HT004';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT EXISTS (SELECT 1 FROM stay_status_transitions WHERE from_status = OLD.status AND to_status = NEW.status) THEN
    RAISE EXCEPTION 'stay % cannot move from % to %', OLD.number, OLD.status, NEW.status
      USING ERRCODE = 'HT004', HINT = 'See stay_status_transitions for the allowed booking lifecycle (RES-03).';
  END IF;
  -- Closed stays are history: nothing about them changes afterwards (§9).
  IF OLD.status IN ('checked_out', 'cancelled', 'no_show') AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
    RAISE EXCEPTION 'stay % is % and cannot be changed', OLD.number, OLD.status USING ERRCODE = 'HT002';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stays_transition BEFORE INSERT OR UPDATE ON stays
  FOR EACH ROW EXECUTE FUNCTION app_stay_transition();
CREATE TRIGGER stays_no_delete BEFORE DELETE ON stays
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- Occupants of a stay (FD-03); each stay keeps its own occupants (RES-08).
CREATE TABLE stay_occupants (
  stay_id     uuid NOT NULL,
  property_id uuid NOT NULL,
  guest_id    uuid NOT NULL REFERENCES guests (id),
  is_primary  boolean NOT NULL DEFAULT false,
  added_by    uuid REFERENCES users (id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stay_id, guest_id),
  FOREIGN KEY (stay_id, property_id) REFERENCES stays (id, property_id)
);
CREATE UNIQUE INDEX stay_occupants_one_primary ON stay_occupants (stay_id) WHERE is_primary;

-- Agreed price per night (RES-05). Kept when the booking is amended; only
-- added nights are priced at current rates (RES-06).
CREATE TABLE stay_nights (
  stay_id           uuid NOT NULL,
  property_id       uuid NOT NULL,
  night_date        date NOT NULL,
  rate_plan_id      uuid NOT NULL,
  room_type_id      uuid NOT NULL,
  base_amount       money_amount NOT NULL CHECK (base_amount >= 0),
  supplement_amount money_amount NOT NULL DEFAULT 0 CHECK (supplement_amount >= 0),
  amount            money_amount NOT NULL CHECK (amount >= 0),   -- what the guest agreed to pay
  season_name       text,
  is_override       boolean NOT NULL DEFAULT false,
  approval_id       uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stay_id, night_date),
  FOREIGN KEY (stay_id, property_id) REFERENCES stays (id, property_id),
  FOREIGN KEY (rate_plan_id, property_id) REFERENCES rate_plans (id, property_id),
  FOREIGN KEY (room_type_id, property_id) REFERENCES room_types (id, property_id),
  FOREIGN KEY (approval_id, property_id) REFERENCES approvals (id, property_id),
  CHECK (NOT is_override OR approval_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Physical room allocation (RES-04, FD-05). Nights are a half-open date range
-- [arrival, departure). The exclusion constraint guarantees that no two active
-- allocations (stays or maintenance blocks) overlap on the same room, under
-- any concurrency: the database itself rejects the second booking (AT-08).
-- ---------------------------------------------------------------------------
CREATE TABLE room_allocations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL,
  room_id        uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('stay', 'block')),
  stay_id        uuid,
  during         daterange NOT NULL CHECK (NOT isempty(during) AND lower_inc(during) AND NOT upper_inc(during)),
  block_reason   text,
  released_at    timestamptz,
  release_reason text CHECK (release_reason IN ('cancelled', 'no_show', 'hold_expired', 'moved', 'amended', 'checked_out', 'block_ended')),
  created_by     uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (room_id, property_id) REFERENCES rooms (id, property_id),
  FOREIGN KEY (stay_id, property_id) REFERENCES stays (id, property_id),
  CHECK ((kind = 'stay') = (stay_id IS NOT NULL)),
  CHECK (kind <> 'block' OR block_reason IS NOT NULL),
  CHECK ((released_at IS NULL) = (release_reason IS NULL)),
  CONSTRAINT room_allocations_no_overlap
    EXCLUDE USING gist (room_id WITH =, during WITH &&) WHERE (released_at IS NULL)
);
CREATE INDEX room_allocations_stay ON room_allocations (stay_id) WHERE stay_id IS NOT NULL;
CREATE INDEX room_allocations_active ON room_allocations USING gist (property_id, during) WHERE released_at IS NULL;
-- A released allocation is history.
CREATE FUNCTION app_allocation_released_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'released room allocation % cannot change', OLD.id USING ERRCODE = 'HT002';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER room_allocations_released_final BEFORE UPDATE ON room_allocations
  FOR EACH ROW EXECUTE FUNCTION app_allocation_released_is_final();
CREATE TRIGGER room_allocations_immutable BEFORE UPDATE ON room_allocations
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('property_id', 'room_id', 'kind', 'stay_id', 'created_at');
CREATE TRIGGER room_allocations_no_delete BEFORE DELETE ON room_allocations
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- Room move history (FD-05). Append-only.
CREATE TABLE room_moves (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL,
  stay_id      uuid NOT NULL,
  from_room_id uuid NOT NULL,
  to_room_id   uuid NOT NULL,
  move_date    date NOT NULL,
  reason       text NOT NULL,
  moved_by     uuid REFERENCES users (id),
  moved_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (stay_id, property_id) REFERENCES stays (id, property_id),
  FOREIGN KEY (from_room_id, property_id) REFERENCES rooms (id, property_id),
  FOREIGN KEY (to_room_id, property_id) REFERENCES rooms (id, property_id),
  CHECK (from_room_id <> to_room_id)
);
CREATE TRIGGER room_moves_append_only BEFORE UPDATE OR DELETE ON room_moves
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- Amendment history (RES-06): what changed, the price difference and who approved.
CREATE TABLE reservation_amendments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL,
  reservation_id   uuid NOT NULL,
  stay_id          uuid NOT NULL,
  kind             text NOT NULL,
  previous_values  jsonb NOT NULL,
  new_values       jsonb NOT NULL,
  price_difference money_amount NOT NULL,
  reason           text,
  approval_id      uuid,
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (reservation_id, property_id) REFERENCES reservations (id, property_id),
  FOREIGN KEY (stay_id, property_id) REFERENCES stays (id, property_id),
  FOREIGN KEY (approval_id, property_id) REFERENCES approvals (id, property_id)
);
CREATE INDEX reservation_amendments_reservation ON reservation_amendments (reservation_id, created_at);
CREATE TRIGGER reservation_amendments_append_only BEFORE UPDATE OR DELETE ON reservation_amendments
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Guest requests with handover notes (FD-07)
-- ---------------------------------------------------------------------------
CREATE TABLE guest_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES properties (id),
  stay_id       uuid,
  room_id       uuid,
  category      text NOT NULL CHECK (category IN ('maintenance', 'linen', 'wake_up', 'housekeeping', 'transport', 'other')),
  description   text NOT NULL CHECK (length(description) BETWEEN 3 AND 1000),
  priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  owner_user_id uuid REFERENCES users (id),
  due_at        timestamptz,
  completed_at  timestamptz,
  created_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, property_id),
  FOREIGN KEY (stay_id, property_id) REFERENCES stays (id, property_id),
  FOREIGN KEY (room_id, property_id) REFERENCES rooms (id, property_id),
  CHECK (stay_id IS NOT NULL OR room_id IS NOT NULL)
);
CREATE INDEX guest_requests_open ON guest_requests (property_id, status, due_at);
CREATE TRIGGER guest_requests_touch BEFORE UPDATE ON guest_requests
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE guest_request_notes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id  uuid NOT NULL,
  property_id uuid NOT NULL,
  note        text NOT NULL CHECK (length(note) BETWEEN 1 AND 1000),
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (request_id, property_id) REFERENCES guest_requests (id, property_id)
);
CREATE TRIGGER guest_request_notes_append_only BEFORE UPDATE OR DELETE ON guest_request_notes
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Closed business days (BIL-10 stand-in: posts room nights, advances the date).
-- ---------------------------------------------------------------------------
CREATE TABLE business_days (
  property_id         uuid NOT NULL REFERENCES properties (id),
  business_date       date NOT NULL,
  room_charges_posted integer NOT NULL,
  closed_by           uuid REFERENCES users (id),
  closed_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, business_date)
);
CREATE TRIGGER business_days_append_only BEFORE UPDATE OR DELETE ON business_days
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Expired holds (RES-03, RES-04): release the inventory and return the stay to
-- enquiry. Called before every availability check and booking, and by the
-- maintenance job, so an expired hold never blocks a room.
-- ---------------------------------------------------------------------------
CREATE FUNCTION release_expired_holds(p_property_id uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_count integer;
BEGIN
  WITH expired AS (
    UPDATE stays SET status = 'enquiry', hold_expires_at = NULL, room_id = NULL
     WHERE property_id = p_property_id AND status = 'hold' AND hold_expires_at <= now()
    RETURNING id
  ), released AS (
    UPDATE room_allocations a SET released_at = now(), release_reason = 'hold_expired'
      FROM expired e
     WHERE a.stay_id = e.id AND a.released_at IS NULL
    RETURNING a.id
  )
  SELECT count(*) INTO v_count FROM expired;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security (SEC-06, AT-18)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['approvals', 'reservations', 'stays', 'stay_occupants', 'stay_nights', 'room_allocations',
                           'room_moves', 'reservation_amendments', 'guest_requests', 'guest_request_notes', 'business_days'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id))',
                   t || '_scope', t);
  END LOOP;
END;
$$;

GRANT SELECT ON stay_status_transitions TO hotel_app;
GRANT SELECT, INSERT ON approvals, room_moves, reservation_amendments, guest_request_notes, business_days TO hotel_app;
GRANT SELECT, INSERT, UPDATE ON reservations, stays, room_allocations, guest_requests TO hotel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON stay_occupants, stay_nights TO hotel_app;
GRANT EXECUTE ON FUNCTION release_expired_holds(uuid) TO hotel_app;
