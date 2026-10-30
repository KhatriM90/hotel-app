-- 0016 Loyalty and club membership (addendum v1.2: LOY01, LOY05, LOY11–LOY28,
-- CLUB01–CLUB07; replaces ADV-02).
--
-- One member balance across the group (one legal entity, one SAP company):
-- points and wallet credit earned at any property can be used at any of them.
-- Every balance-changing event stores the property, outlet and business date
-- where it happened, so earning reports where it arose and redemption cost
-- where it was used (LAT14).
--
-- §9 rules applied here:
--  * the event ledger is append-only; corrections are compensating events
--    linked to the original (LOY16, S23);
--  * every event carries a unique business key, so a retried sale, settlement,
--    refund or month-end run never changes a balance twice (S22, CAT05);
--  * points and the monetary wallet are separate units and never mix with gift
--    cards, deposits or receivables (CLUB05);
--  * member profiles are group-wide like guest profiles (CFG-05); access is by
--    permission, and staff at one property see only their property's activity.

INSERT INTO document_types (code, prefix, description) VALUES ('POS_RETURN', 'RT', 'POS item return');
INSERT INTO number_sequences (property_id, document_type)
SELECT p.id, d.code FROM properties p CROSS JOIN document_types d
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Programme versions (LOY01, "version every rule with effective dates").
-- Settings are validated by the API; each transaction stores the version used.
-- A change is a new version, never an edit, so old sales and refunds keep the
-- rules they were made under (LAT09, CAT03).
-- ---------------------------------------------------------------------------
CREATE TABLE loyalty_programme_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version        integer NOT NULL UNIQUE CHECK (version >= 1),
  effective_from timestamptz NOT NULL,
  settings       jsonb NOT NULL,
  note           text NOT NULL CHECK (length(note) BETWEEN 3 AND 500),
  created_by     uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loyalty_programme_versions_effective ON loyalty_programme_versions (effective_from DESC, version DESC);
CREATE TRIGGER loyalty_programme_versions_append_only BEFORE UPDATE OR DELETE ON loyalty_programme_versions
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- Version 1 holds the addendum's proposed defaults; missing keys are filled from
-- the API's defaults, so later settings never need a data migration.
INSERT INTO loyalty_programme_versions (version, effective_from, settings, note)
VALUES (1, '2026-01-01T00:00:00+03:00', '{}', 'Proposed defaults from the loyalty addendum v1.2 (not yet approved commercial terms)');

-- ---------------------------------------------------------------------------
-- Club tiers and their effective-dated rates (CLUB01). NULL rate = programme default.
-- ---------------------------------------------------------------------------
CREATE TABLE club_tiers (
  code       text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]{2,16}$'),
  name       text NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true
);
INSERT INTO club_tiers (code, name, sort_order) VALUES ('CLUB', 'Club member', 1), ('PREMIER', 'Premier club member', 2);

CREATE TABLE club_tier_rates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_code        text NOT NULL REFERENCES club_tiers (code),
  discount_percent numeric(5, 2) CHECK (discount_percent BETWEEN 0 AND 100),
  cashback_percent numeric(5, 2) CHECK (cashback_percent BETWEEN 0 AND 100),
  effective_from   timestamptz NOT NULL,
  reason           text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX club_tier_rates_lookup ON club_tier_rates (tier_code, effective_from DESC);
CREATE TRIGGER club_tier_rates_append_only BEFORE UPDATE OR DELETE ON club_tier_rates
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
INSERT INTO club_tier_rates (tier_code, discount_percent, cashback_percent, effective_from, reason) VALUES
  ('CLUB', NULL, NULL, '2026-01-01T00:00:00+03:00', 'Programme default rates'),
  ('PREMIER', 12, 15, '2026-01-01T00:00:00+03:00', 'Proposed premier rates for demonstration');

-- ---------------------------------------------------------------------------
-- Members (LOY11, LOY24, LOY28). A stable member number, linked to the guest
-- profile and optionally a company. The phone is a contact, never the identity
-- key. Programme acceptance and marketing consent are recorded separately.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE loyalty_member_seq START 100001;

CREATE TABLE loyalty_members (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                text NOT NULL UNIQUE CHECK (number ~ '^YS[0-9]{6,}$'),
  kind                  text NOT NULL DEFAULT 'individual' CHECK (kind IN ('individual', 'corporate')),
  guest_id              uuid REFERENCES guests (id),
  company_id            uuid REFERENCES companies (id),
  display_name          text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 160),
  phone                 text CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ]{7,20}$'),
  phone_verified_at     timestamptz,
  email                 text,
  -- Secret printed in the card's QR code; scanning it verifies the member (LOY22).
  qr_token              text NOT NULL UNIQUE,
  -- Secret in the member's self-service link (LOY23).
  self_token            text NOT NULL UNIQUE,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed', 'merged', 'anonymised')),
  merged_into_id        uuid REFERENCES loyalty_members (id),
  programme_accepted_at timestamptz NOT NULL,
  marketing_consent_at  timestamptz,
  -- LOY24: nobody under 18 joins a programme with alcohol rewards.
  adult_confirmed       boolean NOT NULL CHECK (adult_confirmed),
  -- LOY22: a flagged staff account never earns on bills its holder serves or cashes.
  staff_user_id         uuid REFERENCES users (id),
  staff_flagged         boolean NOT NULL DEFAULT false,
  enrolled_property_id  uuid NOT NULL REFERENCES properties (id),
  enrolled_outlet_id    uuid REFERENCES outlets (id),
  enrolment_channel     text NOT NULL CHECK (enrolment_channel IN ('reception', 'pos', 'self', 'import')),
  sap_card_code         text,
  anonymised_at         timestamptz,
  created_by            uuid REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'merged' OR merged_into_id IS NOT NULL),
  CHECK (kind <> 'corporate' OR company_id IS NOT NULL),
  CHECK (staff_user_id IS NULL OR staff_flagged)
);
CREATE UNIQUE INDEX loyalty_members_one_per_guest ON loyalty_members (guest_id) WHERE guest_id IS NOT NULL AND status NOT IN ('merged', 'anonymised');
CREATE INDEX loyalty_members_phone ON loyalty_members (regexp_replace(phone, '[^0-9]', '', 'g')) WHERE phone IS NOT NULL;
CREATE INDEX loyalty_members_name ON loyalty_members (lower(display_name));
CREATE TRIGGER loyalty_members_touch BEFORE UPDATE ON loyalty_members
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER loyalty_members_immutable BEFORE UPDATE ON loyalty_members
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('number', 'enrolled_property_id', 'enrolment_channel', 'created_at', 'created_by');
CREATE TRIGGER loyalty_members_no_delete BEFORE DELETE ON loyalty_members
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Club membership (CLUB01) and approved individual rate overrides.
-- ---------------------------------------------------------------------------
CREATE TABLE club_memberships (
  member_id  uuid PRIMARY KEY REFERENCES loyalty_members (id),
  tier_code  text NOT NULL REFERENCES club_tiers (code),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'expired')),
  starts_on  date NOT NULL,
  ends_on    date,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE TRIGGER club_memberships_touch BEFORE UPDATE ON club_memberships
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE club_rate_overrides (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        uuid NOT NULL REFERENCES loyalty_members (id),
  discount_percent numeric(5, 2) CHECK (discount_percent BETWEEN 0 AND 100),
  cashback_percent numeric(5, 2) CHECK (cashback_percent BETWEEN 0 AND 100),
  effective_from   date NOT NULL,
  effective_to     date,
  reason           text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  approval_id      uuid NOT NULL REFERENCES approvals (id),
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (discount_percent IS NOT NULL OR cashback_percent IS NOT NULL),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX club_rate_overrides_member ON club_rate_overrides (member_id, effective_from DESC);
CREATE TRIGGER club_rate_overrides_append_only BEFORE UPDATE OR DELETE ON club_rate_overrides
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Ledger (LOY16): append-only events with signed amounts. Points are whole
-- numbers; the wallet is KES. Pending entitlement is not in the ledger until
-- the bill is settled.
-- ---------------------------------------------------------------------------
CREATE TABLE loyalty_events (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key            text NOT NULL UNIQUE CHECK (length(event_key) BETWEEN 6 AND 200),
  member_id            uuid NOT NULL REFERENCES loyalty_members (id),
  unit                 text NOT NULL CHECK (unit IN ('points', 'wallet')),
  type                 text NOT NULL CHECK (type IN ('earn', 'credit', 'redeem', 'restore', 'reverse', 'adjust', 'expire', 'merge_in', 'merge_out')),
  amount               numeric(18, 2) NOT NULL CHECK (amount <> 0),
  -- KES value at the conversion rate in force (points × point value; wallet = amount).
  value                numeric(18, 2) NOT NULL,
  property_id          uuid REFERENCES properties (id),
  outlet_id            uuid REFERENCES outlets (id),
  business_date        date,
  check_id             uuid REFERENCES pos_checks (id),
  folio_id             uuid REFERENCES folios (id),
  stay_id              uuid REFERENCES stays (id),
  return_id            uuid,
  batch_id             uuid,
  programme_version_id uuid REFERENCES loyalty_programme_versions (id),
  original_event_id    bigint REFERENCES loyalty_events (id),
  actor                uuid REFERENCES users (id),
  actor_roles          text[],
  device_id            text,
  reason               text,
  approval_id          uuid REFERENCES approvals (id),
  details              jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (unit <> 'points' OR amount = trunc(amount)),
  CHECK (type NOT IN ('adjust', 'merge_in', 'merge_out') OR reason IS NOT NULL),
  CHECK (type <> 'adjust' OR approval_id IS NOT NULL),
  CHECK (type NOT IN ('reverse', 'restore') OR original_event_id IS NOT NULL OR return_id IS NOT NULL OR batch_id IS NOT NULL)
);
CREATE INDEX loyalty_events_member ON loyalty_events (member_id, id);
CREATE INDEX loyalty_events_check ON loyalty_events (check_id) WHERE check_id IS NOT NULL;
CREATE INDEX loyalty_events_property_date ON loyalty_events (property_id, created_at);
CREATE TRIGGER loyalty_events_append_only BEFORE UPDATE OR DELETE ON loyalty_events
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
CREATE TRIGGER loyalty_events_no_truncate BEFORE TRUNCATE ON loyalty_events
  FOR EACH STATEMENT EXECUTE FUNCTION app_forbid_mutation();

-- Lots (EarnLot): what is left of each earning or credit, with its expiry.
-- Redemptions use the earliest-expiring lot first (LOY13). A 'deficit' lot
-- holds a negative balance after a reversal of points already spent; new
-- earning pays it off first, and redemption is blocked while it exists (S17).
CREATE TABLE loyalty_lots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        uuid NOT NULL REFERENCES loyalty_members (id),
  unit             text NOT NULL CHECK (unit IN ('points', 'wallet')),
  kind             text NOT NULL CHECK (kind IN ('earned', 'credited', 'restored', 'adjustment', 'merged', 'deficit')),
  original         numeric(18, 2) NOT NULL,
  remaining        numeric(18, 2) NOT NULL,
  available_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  property_id      uuid REFERENCES properties (id),
  source_event_id  bigint NOT NULL REFERENCES loyalty_events (id),
  expired_event_id bigint REFERENCES loyalty_events (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'deficit' OR (remaining >= 0 AND remaining <= original)),
  CHECK (kind <> 'deficit' OR (remaining <= 0 AND expires_at IS NULL)),
  CHECK (unit <> 'points' OR remaining = trunc(remaining))
);
CREATE INDEX loyalty_lots_open ON loyalty_lots (member_id, unit, expires_at) WHERE remaining <> 0;
CREATE UNIQUE INDEX loyalty_lots_one_deficit ON loyalty_lots (member_id, unit) WHERE kind = 'deficit';
CREATE TRIGGER loyalty_lots_immutable BEFORE UPDATE ON loyalty_lots
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('member_id', 'unit', 'kind', 'original', 'available_at', 'expires_at', 'property_id', 'source_event_id', 'created_at');
CREATE TRIGGER loyalty_lots_no_delete BEFORE DELETE ON loyalty_lots
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- Which lots each event drew from or added to, so a return restores into the
-- right expiry and the ledger can be rebuilt from history (LOY14, LAT12).
CREATE TABLE loyalty_lot_movements (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lot_id   uuid NOT NULL REFERENCES loyalty_lots (id),
  event_id bigint NOT NULL REFERENCES loyalty_events (id),
  amount   numeric(18, 2) NOT NULL CHECK (amount <> 0)
);
CREATE INDEX loyalty_lot_movements_event ON loyalty_lot_movements (event_id);
CREATE INDEX loyalty_lot_movements_lot ON loyalty_lot_movements (lot_id);
CREATE TRIGGER loyalty_lot_movements_append_only BEFORE UPDATE OR DELETE ON loyalty_lot_movements
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Verification before redemption (LOY13, LOY22): OTP to the registered phone
-- or the card's QR code. Never a typed phone number alone.
-- ---------------------------------------------------------------------------
CREATE TABLE loyalty_verifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   uuid NOT NULL REFERENCES loyalty_members (id),
  method      text NOT NULL CHECK (method IN ('otp', 'qr')),
  code_hash   text,
  attempts    smallint NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  verified_at timestamptz,
  property_id uuid NOT NULL REFERENCES properties (id),
  check_id    uuid REFERENCES pos_checks (id),
  purpose     text NOT NULL CHECK (purpose IN ('redeem', 'enrol')),
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (method <> 'otp' OR code_hash IS NOT NULL)
);
CREATE INDEX loyalty_verifications_member ON loyalty_verifications (member_id, created_at DESC);

-- Reservations (RedemptionReservation, LOY13, CLUB05, S20): points or credit
-- held for one check until it settles, is abandoned or times out.
CREATE TABLE loyalty_reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id       uuid NOT NULL REFERENCES loyalty_members (id),
  unit            text NOT NULL CHECK (unit IN ('points', 'wallet')),
  amount          numeric(18, 2) NOT NULL CHECK (amount > 0),
  check_id        uuid NOT NULL REFERENCES pos_checks (id),
  property_id     uuid NOT NULL REFERENCES properties (id),
  verification_id uuid NOT NULL REFERENCES loyalty_verifications (id),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'committed', 'released')),
  expires_at      timestamptz NOT NULL,
  release_reason  text,
  event_id        bigint REFERENCES loyalty_events (id),
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  CHECK (status = 'active' OR resolved_at IS NOT NULL),
  CHECK (status <> 'committed' OR event_id IS NOT NULL),
  CHECK (unit <> 'points' OR amount = trunc(amount))
);
CREATE UNIQUE INDEX loyalty_reservations_one_active ON loyalty_reservations (check_id, unit) WHERE status = 'active';
CREATE INDEX loyalty_reservations_member_active ON loyalty_reservations (member_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- POS checks and lines: the member on the bill and the benefits on each line.
-- Benefit amounts are tax-inclusive reductions of the line; *_value columns are
-- the eligible value (net of tax by default) the reward stands for.
-- ---------------------------------------------------------------------------
ALTER TABLE pos_checks ADD COLUMN loyalty_member_id uuid REFERENCES loyalty_members (id);
ALTER TABLE pos_checks ADD COLUMN loyalty_benefit text CHECK (loyalty_benefit IN ('discount', 'cashback'));
CREATE INDEX pos_checks_member ON pos_checks (loyalty_member_id) WHERE loyalty_member_id IS NOT NULL;

ALTER TABLE pos_check_lines ADD COLUMN member_discount_percent numeric(5, 2) NOT NULL DEFAULT 0 CHECK (member_discount_percent BETWEEN 0 AND 100);
ALTER TABLE pos_check_lines ADD COLUMN member_discount_amount money_amount NOT NULL DEFAULT 0 CHECK (member_discount_amount >= 0);
ALTER TABLE pos_check_lines ADD COLUMN reward_amount money_amount NOT NULL DEFAULT 0 CHECK (reward_amount >= 0);
ALTER TABLE pos_check_lines ADD COLUMN reward_points integer NOT NULL DEFAULT 0 CHECK (reward_points >= 0);
ALTER TABLE pos_check_lines ADD COLUMN reward_wallet money_amount NOT NULL DEFAULT 0 CHECK (reward_wallet >= 0);

CREATE OR REPLACE VIEW pos_check_totals WITH (security_invoker = true) AS
SELECT c.id AS check_id,
       c.property_id,
       coalesce(l.total, 0)::numeric(18, 2) AS total,
       coalesce(l.tax, 0)::numeric(18, 2) AS tax,
       coalesce(l.discounts, 0)::numeric(18, 2) AS discounts,
       coalesce(p.confirmed, 0)::numeric(18, 2) AS paid,
       coalesce(p.pending, 0)::numeric(18, 2) AS pending,
       coalesce(r.amount, 0)::numeric(18, 2) AS room_charged,
       coalesce(h.amount, 0)::numeric(18, 2) AS house_charged,
       coalesce(rf.amount, 0)::numeric(18, 2) AS refunded,
       (coalesce(l.total, 0) - coalesce(p.confirmed, 0) - coalesce(r.amount, 0) - coalesce(h.amount, 0))::numeric(18, 2) AS balance,
       coalesce(l.member_discount, 0)::numeric(18, 2) AS member_discount,
       coalesce(l.rewards, 0)::numeric(18, 2) AS rewards
  FROM pos_checks c
  LEFT JOIN (SELECT check_id, sum(amount) AS total, sum(tax_amount) AS tax, sum(rule_discount + discount_amount) AS discounts,
                    sum(member_discount_amount) AS member_discount, sum(reward_amount) AS rewards
               FROM pos_check_lines WHERE status NOT IN ('cancelled', 'wasted') GROUP BY check_id) l ON l.check_id = c.id
  LEFT JOIN (SELECT check_id, sum(amount) FILTER (WHERE status = 'confirmed') AS confirmed,
                    sum(amount) FILTER (WHERE status = 'pending') AS pending
               FROM pos_payments GROUP BY check_id) p ON p.check_id = c.id
  LEFT JOIN pos_room_charges r ON r.check_id = c.id
  LEFT JOIN house_account_charges h ON h.check_id = c.id
  LEFT JOIN (SELECT check_id, sum(amount) AS amount FROM pos_refunds GROUP BY check_id) rf ON rf.check_id = c.id;

-- Source allocations (SourceAllocation, LOY12, S06/S07): per line, frozen when
-- the check closes, so a partial return reconstructs the original calculation.
CREATE TABLE loyalty_check_allocations (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  check_id             uuid NOT NULL REFERENCES pos_checks (id),
  line_id              uuid NOT NULL REFERENCES pos_check_lines (id),
  member_id            uuid NOT NULL REFERENCES loyalty_members (id),
  property_id          uuid NOT NULL REFERENCES properties (id),
  programme_version_id uuid NOT NULL REFERENCES loyalty_programme_versions (id),
  eligible             boolean NOT NULL,
  excluded_reason      text,
  -- Eligible value after discounts and before rewards; points and wallet used.
  eligible_before      numeric(18, 2) NOT NULL,
  points               integer NOT NULL DEFAULT 0,
  wallet               numeric(18, 2) NOT NULL DEFAULT 0,
  -- Of the eligible value left after rewards: what was paid now, what went to a room.
  paid_share           numeric(18, 2) NOT NULL DEFAULT 0,
  pending_share        numeric(18, 2) NOT NULL DEFAULT 0,
  cashback_percent     numeric(5, 2),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (check_id, line_id)
);
CREATE TRIGGER loyalty_check_allocations_append_only BEFORE UPDATE OR DELETE ON loyalty_check_allocations
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- What the bill did to the member, frozen at close for the receipt (LOY17).
CREATE TABLE loyalty_check_outcomes (
  check_id         uuid PRIMARY KEY REFERENCES pos_checks (id),
  member_id        uuid NOT NULL REFERENCES loyalty_members (id),
  points_earned    integer NOT NULL DEFAULT 0,
  points_pending   integer NOT NULL DEFAULT 0,
  points_redeemed  integer NOT NULL DEFAULT 0,
  wallet_redeemed  numeric(18, 2) NOT NULL DEFAULT 0,
  member_discount  numeric(18, 2) NOT NULL DEFAULT 0,
  cashback_pending numeric(18, 2) NOT NULL DEFAULT 0,
  closing_points   integer NOT NULL,
  closing_wallet   numeric(18, 2) NOT NULL,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER loyalty_check_outcomes_append_only BEFORE UPDATE OR DELETE ON loyalty_check_outcomes
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Pending entitlement (S03, S05, S07, LAT08): eligible spend waiting for the
-- bill to be settled. Room-charged POS parts wait for checkout; a company
-- (city ledger) bill waits until finance confirms the company paid.
-- ---------------------------------------------------------------------------
CREATE TABLE loyalty_pending (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id            uuid NOT NULL REFERENCES loyalty_members (id),
  property_id          uuid NOT NULL REFERENCES properties (id),
  outlet_id            uuid REFERENCES outlets (id),
  check_id             uuid REFERENCES pos_checks (id),
  folio_id             uuid REFERENCES folios (id),
  stay_id              uuid REFERENCES stays (id),
  source               text NOT NULL CHECK (source IN ('room_charge', 'stay')),
  eligible_amount      numeric(18, 2) NOT NULL CHECK (eligible_amount >= 0),
  cashback_percent     numeric(5, 2),
  sale_date            date NOT NULL,
  programme_version_id uuid NOT NULL REFERENCES loyalty_programme_versions (id),
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'awaiting_company_payment', 'released', 'cancelled')),
  released_event_id    bigint REFERENCES loyalty_events (id),
  resolution_note      text,
  resolved_by          uuid REFERENCES users (id),
  resolved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('pending', 'awaiting_company_payment') OR resolved_at IS NOT NULL)
);
CREATE UNIQUE INDEX loyalty_pending_one_per_check ON loyalty_pending (check_id) WHERE check_id IS NOT NULL;
CREATE UNIQUE INDEX loyalty_pending_one_per_stay ON loyalty_pending (folio_id) WHERE source = 'stay';
CREATE INDEX loyalty_pending_open ON loyalty_pending (status) WHERE status IN ('pending', 'awaiting_company_payment');

-- ---------------------------------------------------------------------------
-- Item returns (S15, S16, CAT07, CAT08): which lines went back, what was
-- refunded in money and what was restored to the member.
-- ---------------------------------------------------------------------------
CREATE TABLE pos_returns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL,
  number          text NOT NULL UNIQUE,
  check_id        uuid NOT NULL,
  amount          money_amount NOT NULL CHECK (amount >= 0),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  approval_id     uuid NOT NULL,
  business_date   date NOT NULL,
  points_restored integer NOT NULL DEFAULT 0,
  points_reversed integer NOT NULL DEFAULT 0,
  wallet_restored numeric(18, 2) NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, property_id),
  FOREIGN KEY (check_id, property_id) REFERENCES pos_checks (id, property_id),
  FOREIGN KEY (approval_id, property_id) REFERENCES approvals (id, property_id)
);
CREATE TRIGGER pos_returns_append_only BEFORE UPDATE OR DELETE ON pos_returns
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

CREATE TABLE pos_return_lines (
  return_id   uuid NOT NULL,
  property_id uuid NOT NULL,
  line_id     uuid NOT NULL,
  quantity    quantity NOT NULL CHECK (quantity > 0),
  amount      money_amount NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (return_id, line_id),
  FOREIGN KEY (return_id, property_id) REFERENCES pos_returns (id, property_id),
  FOREIGN KEY (line_id, property_id) REFERENCES pos_check_lines (id, property_id)
);
CREATE TRIGGER pos_return_lines_append_only BEFORE UPDATE OR DELETE ON pos_return_lines
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

ALTER TABLE pos_refunds ADD COLUMN return_id uuid;
ALTER TABLE pos_refunds ADD FOREIGN KEY (return_id, property_id) REFERENCES pos_returns (id, property_id);
-- Deferred: the return's loyalty effect is posted before the return row that records it.
ALTER TABLE loyalty_events ADD FOREIGN KEY (return_id) REFERENCES pos_returns (id) DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Monthly cashback (CLUB03, CLUB04): one accrual per settled sale or allocated
-- bill portion at its sale-time rate, in the month it was fully settled.
-- Returns are negative accruals in the original sale's month.
-- ---------------------------------------------------------------------------
CREATE TABLE cashback_accruals (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  accrual_key         text NOT NULL UNIQUE,
  member_id           uuid NOT NULL REFERENCES loyalty_members (id),
  property_id         uuid NOT NULL REFERENCES properties (id),
  outlet_id           uuid REFERENCES outlets (id),
  check_id            uuid REFERENCES pos_checks (id),
  folio_id            uuid REFERENCES folios (id),
  return_id           uuid REFERENCES pos_returns (id) DEFERRABLE INITIALLY DEFERRED,
  kind                text NOT NULL CHECK (kind IN ('sale', 'return')),
  sale_date           date NOT NULL,
  settlement_month    date NOT NULL CHECK (extract(day FROM settlement_month) = 1),
  eligible_amount     numeric(18, 2) NOT NULL,
  rate_percent        numeric(5, 2) NOT NULL CHECK (rate_percent BETWEEN 0 AND 100),
  rate_source         text NOT NULL,
  original_accrual_id bigint REFERENCES cashback_accruals (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'sale') = (eligible_amount >= 0)),
  CHECK (kind = 'sale' OR original_accrual_id IS NOT NULL)
);
CREATE INDEX cashback_accruals_month ON cashback_accruals (settlement_month, member_id);
CREATE TRIGGER cashback_accruals_append_only BEFORE UPDATE OR DELETE ON cashback_accruals
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

CREATE TABLE cashback_batches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month                date NOT NULL CHECK (extract(day FROM month) = 1),
  kind                 text NOT NULL CHECK (kind IN ('regular', 'adjustment')),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'posting', 'posted', 'exception', 'discarded')),
  programme_version_id uuid NOT NULL REFERENCES loyalty_programme_versions (id),
  totals               jsonb NOT NULL DEFAULT '{}',
  created_by           uuid REFERENCES users (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  approved_by          uuid REFERENCES users (id),
  approved_at          timestamptz,
  approval_id          uuid REFERENCES approvals (id),
  posted_at            timestamptz,
  note                 text,
  CHECK (status IN ('draft', 'discarded') OR approved_at IS NOT NULL),
  CHECK (status <> 'posted' OR posted_at IS NOT NULL)
);
-- One live regular batch per month; adjustments follow a posted month (CLUB04).
CREATE UNIQUE INDEX cashback_batches_one_regular ON cashback_batches (month) WHERE kind = 'regular' AND status <> 'discarded';
CREATE UNIQUE INDEX cashback_batches_one_open_adjustment ON cashback_batches (month) WHERE kind = 'adjustment' AND status IN ('draft', 'approved', 'posting', 'exception');

CREATE TABLE cashback_batch_lines (
  batch_id            uuid NOT NULL REFERENCES cashback_batches (id),
  member_id           uuid NOT NULL REFERENCES loyalty_members (id),
  qualifying_spend    numeric(18, 2) NOT NULL,
  returns             numeric(18, 2) NOT NULL DEFAULT 0,
  rate_breakdown      jsonb NOT NULL,
  raw_credit          numeric(20, 6) NOT NULL,
  entitlement         numeric(18, 2) NOT NULL,
  previously_credited numeric(18, 2) NOT NULL DEFAULT 0,
  amount              numeric(18, 2) NOT NULL,
  flags               text[] NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'skipped', 'exception')),
  wallet_event_id     bigint REFERENCES loyalty_events (id),
  error               text,
  PRIMARY KEY (batch_id, member_id),
  CHECK (status <> 'posted' OR wallet_event_id IS NOT NULL OR amount = 0)
);

-- ---------------------------------------------------------------------------
-- Grants. Member data is group-wide (no row-level security), like guests.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON loyalty_programme_versions, club_tier_rates, club_rate_overrides, loyalty_events, loyalty_lot_movements,
  loyalty_check_allocations, loyalty_check_outcomes, cashback_accruals TO hotel_app;
GRANT SELECT ON club_tiers TO hotel_app;
GRANT SELECT, INSERT, UPDATE ON loyalty_members, club_memberships, loyalty_lots, loyalty_verifications, loyalty_reservations, loyalty_pending,
  cashback_batches TO hotel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cashback_batch_lines TO hotel_app;
GRANT USAGE ON SEQUENCE loyalty_member_seq TO hotel_app;

ALTER TABLE pos_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY pos_returns_scope ON pos_returns USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));
ALTER TABLE pos_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_return_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY pos_return_lines_scope ON pos_return_lines USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));
GRANT SELECT, INSERT ON pos_returns, pos_return_lines TO hotel_app;
