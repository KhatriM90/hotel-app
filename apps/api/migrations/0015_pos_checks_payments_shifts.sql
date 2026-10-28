-- 0015 POS transactions: outlet trading days, cashier shifts, checks, lines,
-- kitchen/bar tickets, payments, room charges, house-account charges and refunds.
--
-- §9 rules applied here:
--  * fulfilment (line status), payment (pos_payments), folio posting
--    (pos_room_charges → folio_charges) and fiscal status are kept apart;
--  * a check is settled once: by payments, by one room charge for the unpaid
--    remainder, or by a house account; POS revenue is the check's lines and is
--    counted once. A room charge is a transfer to the guest ledger (BIL-12);
--  * closed checks, payments, tickets, refunds and events never change or
--    disappear; corrections are linked records with reasons and approvals;
--  * every check carries the business date of its outlet's trading day.

INSERT INTO document_types (code, prefix, description) VALUES
  ('POS_TICKET', 'KOT', 'Kitchen/bar order ticket'),
  ('CASH_SHIFT', 'SFT', 'Cashier shift');
INSERT INTO number_sequences (property_id, document_type)
SELECT p.id, d.code FROM properties p CROSS JOIN document_types d
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Outlet trading days. The date comes from the clock and the outlet's (or
-- property's) cut-off when the first check or shift of the day opens; closing
-- it is a manual action that requires every check and shift to be closed and
-- stores the day's totals (POS day close / Z report).
-- ---------------------------------------------------------------------------
CREATE TABLE pos_outlet_days (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL,
  outlet_id     uuid NOT NULL,
  business_date date NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_by     uuid REFERENCES users (id),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_by     uuid REFERENCES users (id),
  closed_at     timestamptz,
  totals        jsonb,
  finalised_at  timestamptz,
  UNIQUE (outlet_id, business_date),
  UNIQUE (id, property_id),
  FOREIGN KEY (outlet_id, property_id) REFERENCES outlets (id, property_id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((status = 'closed') = (finalised_at IS NOT NULL))
);
CREATE UNIQUE INDEX pos_outlet_days_one_open ON pos_outlet_days (outlet_id) WHERE status = 'open';
CREATE TRIGGER pos_outlet_days_finalised_guard BEFORE UPDATE OR DELETE ON pos_outlet_days
  FOR EACH ROW EXECUTE FUNCTION app_guard_finalised();

-- ---------------------------------------------------------------------------
-- Cashier shifts (POS-13): opening float, cash movements, handover, blind
-- count, expected versus actual and a signed variance review. One open shift
-- per user; cash is only taken inside an open shift.
-- ---------------------------------------------------------------------------
CREATE TABLE cashier_shifts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          uuid NOT NULL,
  number               text NOT NULL UNIQUE,         -- K1-SFT-000001
  outlet_id            uuid NOT NULL,
  outlet_day_id        uuid NOT NULL,
  user_id              uuid NOT NULL REFERENCES users (id),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opening_float        money_amount NOT NULL CHECK (opening_float >= 0),
  handover_from_id     uuid REFERENCES cashier_shifts (id),
  opened_at            timestamptz NOT NULL DEFAULT now(),
  counted_amount       money_amount CHECK (counted_amount IS NULL OR counted_amount >= 0),
  expected_amount      money_amount,
  variance             money_amount,
  count_note           text,
  closed_at            timestamptz,
  closed_by            uuid REFERENCES users (id),
  reviewed_by          uuid REFERENCES users (id),
  reviewed_at          timestamptz,
  review_note          text,
  review_approval_id   uuid,
  finalised_at         timestamptz,
  UNIQUE (id, property_id),
  FOREIGN KEY (outlet_id, property_id) REFERENCES outlets (id, property_id),
  FOREIGN KEY (outlet_day_id, property_id) REFERENCES pos_outlet_days (id, property_id),
  FOREIGN KEY (review_approval_id, property_id) REFERENCES approvals (id, property_id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((status = 'closed') = (finalised_at IS NOT NULL)),
  CHECK (status = 'open' OR (counted_amount IS NOT NULL AND expected_amount IS NOT NULL AND variance = counted_amount - expected_amount)),
  CHECK (reviewed_at IS NULL OR (status = 'closed' AND reviewed_by IS NOT NULL AND review_note IS NOT NULL))
);
CREATE UNIQUE INDEX cashier_shifts_one_open_per_user ON cashier_shifts (user_id) WHERE status = 'open';
CREATE UNIQUE INDEX cashier_shifts_one_handover ON cashier_shifts (handover_from_id) WHERE handover_from_id IS NOT NULL;
-- After the count only the variance review may be added.
CREATE TRIGGER cashier_shifts_finalised_guard BEFORE UPDATE OR DELETE ON cashier_shifts
  FOR EACH ROW EXECUTE FUNCTION app_guard_finalised('reviewed_by', 'reviewed_at', 'review_note', 'review_approval_id');
CREATE TRIGGER cashier_shifts_immutable BEFORE UPDATE ON cashier_shifts
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('property_id', 'number', 'outlet_id', 'outlet_day_id', 'user_id', 'opening_float', 'handover_from_id', 'opened_at');

CREATE TABLE cash_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  shift_id    uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('paid_in', 'paid_out', 'drop')),
  amount      money_amount NOT NULL CHECK (amount > 0),
  reason      text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  approval_id uuid,
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shift_id, property_id) REFERENCES cashier_shifts (id, property_id),
  FOREIGN KEY (approval_id, property_id) REFERENCES approvals (id, property_id),
  CHECK (kind <> 'paid_out' OR approval_id IS NOT NULL)      -- cash out needs a manager (AT-13)
);
CREATE TRIGGER cash_movements_append_only BEFORE UPDATE OR DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Checks (POS-04, POS-05, POS-06). The id may be generated on the device so an
-- order taken offline keeps its identity when it syncs (OPS-05).
-- ---------------------------------------------------------------------------
CREATE TYPE pos_service_type AS ENUM ('table', 'counter', 'takeaway', 'room_service');

CREATE TABLE pos_checks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL,
  number           text NOT NULL UNIQUE,                  -- K1-CHK-000001
  outlet_id        uuid NOT NULL,
  outlet_day_id    uuid NOT NULL,
  business_date    date NOT NULL,
  service_type     pos_service_type NOT NULL,
  table_id         uuid,
  tab_name         text CHECK (tab_name IS NULL OR length(tab_name) BETWEEN 1 AND 60),
  covers           smallint NOT NULL DEFAULT 1 CHECK (covers BETWEEN 0 AND 200),
  waiter_id        uuid NOT NULL REFERENCES users (id),
  -- Resident the check belongs to (room service, or linked for charging). A
  -- linked open check blocks that stay's checkout (BIL-11).
  stay_id          uuid,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'void', 'merged')),
  settlement       text CHECK (settlement IN ('payment', 'room_charge', 'house_account', 'zero')),
  merged_into_id   uuid REFERENCES pos_checks (id),
  void_reason      text,
  void_approval_id uuid,
  notes            text,
  device_id        text CHECK (device_id IS NULL OR device_id ~ '^[A-Za-z0-9._:-]{4,80}$'),
  opened_by        uuid REFERENCES users (id),
  opened_at        timestamptz NOT NULL DEFAULT now(),
  client_opened_at timestamptz,
  closed_by        uuid REFERENCES users (id),
  closed_at        timestamptz,
  finalised_at     timestamptz,
  UNIQUE (id, property_id),
  FOREIGN KEY (outlet_id, property_id) REFERENCES outlets (id, property_id),
  FOREIGN KEY (outlet_day_id, property_id) REFERENCES pos_outlet_days (id, property_id),
  FOREIGN KEY (table_id, property_id) REFERENCES pos_tables (id, property_id),
  -- BIL-17: a check can only be linked to a stay at its own property.
  FOREIGN KEY (stay_id, property_id) REFERENCES stays (id, property_id),
  FOREIGN KEY (void_approval_id, property_id) REFERENCES approvals (id, property_id),
  CHECK (service_type <> 'table' OR table_id IS NOT NULL),
  CHECK (service_type <> 'room_service' OR stay_id IS NOT NULL),
  CHECK ((status = 'open') = (finalised_at IS NULL)),
  CHECK (status <> 'closed' OR (settlement IS NOT NULL AND closed_at IS NOT NULL)),
  CHECK (status <> 'merged' OR merged_into_id IS NOT NULL),
  CHECK (status <> 'void' OR (void_reason IS NOT NULL AND void_approval_id IS NOT NULL))
);
CREATE INDEX pos_checks_outlet_open ON pos_checks (outlet_id) WHERE status = 'open';
CREATE INDEX pos_checks_day ON pos_checks (outlet_day_id);
CREATE INDEX pos_checks_stay ON pos_checks (stay_id) WHERE stay_id IS NOT NULL;
CREATE TRIGGER pos_checks_finalised_guard BEFORE UPDATE OR DELETE ON pos_checks
  FOR EACH ROW EXECUTE FUNCTION app_guard_finalised();
CREATE TRIGGER pos_checks_immutable BEFORE UPDATE ON pos_checks
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('property_id', 'number', 'outlet_id', 'outlet_day_id', 'business_date', 'opened_at', 'opened_by', 'device_id');

-- Lines keep price, discount and tax snapshots (§9). Lines are never deleted:
-- a line removed before it was sent is 'cancelled', a sent but unprepared line
-- is cancelled with an approval, a prepared one is 'wasted' (POS-11).
CREATE TABLE pos_check_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          uuid NOT NULL,
  check_id             uuid NOT NULL,
  item_id              uuid NOT NULL REFERENCES menu_items (id),
  portion_id           uuid NOT NULL REFERENCES menu_item_portions (id),
  name                 text NOT NULL,
  charge_code          text NOT NULL REFERENCES charge_codes (code),
  is_alcohol           boolean NOT NULL,
  route                text NOT NULL CHECK (route IN ('kitchen', 'bar', 'none')),
  quantity             quantity NOT NULL CHECK (quantity > 0),
  unit_price           money_amount NOT NULL CHECK (unit_price >= 0),     -- outlet price snapshot
  modifiers            jsonb NOT NULL DEFAULT '[]',
  modifiers_unit_price money_amount NOT NULL DEFAULT 0 CHECK (modifiers_unit_price >= 0),
  rule_id              uuid REFERENCES price_rules (id),
  rule_percent         numeric(5, 2) NOT NULL DEFAULT 0 CHECK (rule_percent BETWEEN 0 AND 100),
  rule_discount        money_amount NOT NULL DEFAULT 0 CHECK (rule_discount >= 0),
  discount_percent     numeric(5, 2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  discount_amount      money_amount NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  discount_reason      text,
  discount_approval_id uuid,
  is_comp              boolean NOT NULL DEFAULT false,
  amount               money_amount NOT NULL CHECK (amount >= 0),         -- after all discounts, incl. tax
  net_amount           money_amount NOT NULL,
  tax_amount           money_amount NOT NULL,
  taxes                jsonb NOT NULL DEFAULT '[]',
  notes                text CHECK (notes IS NULL OR length(notes) <= 300),
  status               text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'sent', 'preparing', 'ready', 'served', 'cancelled', 'wasted')),
  ticket_id            uuid,
  liquor_override_id   uuid,
  added_by             uuid REFERENCES users (id),
  added_at             timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  served_at            timestamptz,
  cancelled_by         uuid REFERENCES users (id),
  cancelled_at         timestamptz,
  cancel_reason        text,
  cancel_approval_id   uuid,
  UNIQUE (id, property_id),
  FOREIGN KEY (check_id, property_id) REFERENCES pos_checks (id, property_id),
  FOREIGN KEY (discount_approval_id, property_id) REFERENCES approvals (id, property_id),
  FOREIGN KEY (cancel_approval_id, property_id) REFERENCES approvals (id, property_id),
  FOREIGN KEY (liquor_override_id, property_id) REFERENCES approvals (id, property_id),
  CHECK (amount = net_amount + tax_amount),
  CHECK (NOT is_comp OR (discount_percent = 100 AND amount = 0)),
  CHECK (discount_amount = 0 OR discount_reason IS NOT NULL),
  CHECK (status NOT IN ('cancelled', 'wasted') OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  -- Anything that reached the kitchen or bar needs a manager to cancel (POS-11).
  CHECK (status NOT IN ('cancelled', 'wasted') OR sent_at IS NULL OR cancel_approval_id IS NOT NULL),
  CHECK (status = 'draft' OR status = 'cancelled' OR sent_at IS NOT NULL)
);
CREATE INDEX pos_check_lines_check ON pos_check_lines (check_id, added_at);

CREATE FUNCTION app_pos_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'POS lines are never deleted; cancel them instead' USING ERRCODE = 'HT001';
  END IF;
  IF EXISTS (SELECT 1 FROM pos_checks c WHERE c.id = OLD.check_id AND c.finalised_at IS NOT NULL) THEN
    RAISE EXCEPTION 'line % belongs to a closed check and cannot change', OLD.id
      USING ERRCODE = 'HT002', HINT = 'Refund the payment or reverse the folio charge instead (BIL-07).';
  END IF;
  IF OLD.status IN ('cancelled', 'wasted') THEN
    RAISE EXCEPTION 'line % is % and final', OLD.id, OLD.status USING ERRCODE = 'HT002';
  END IF;
  IF NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.portion_id IS DISTINCT FROM OLD.portion_id
     OR NEW.unit_price IS DISTINCT FROM OLD.unit_price OR NEW.added_at IS DISTINCT FROM OLD.added_at
     OR NEW.property_id IS DISTINCT FROM OLD.property_id THEN
    RAISE EXCEPTION 'line % item and price snapshot are immutable', OLD.id USING ERRCODE = 'HT001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pos_check_lines_guard BEFORE UPDATE OR DELETE ON pos_check_lines
  FOR EACH ROW EXECUTE FUNCTION app_pos_line_guard();
CREATE TRIGGER pos_check_lines_no_truncate BEFORE TRUNCATE ON pos_check_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app_forbid_mutation();

-- Who did what to a check and its lines, in order (POS-06 "keep additions and
-- cancellations traceable", SEC-04). Append-only.
CREATE TABLE pos_check_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id uuid NOT NULL,
  check_id    uuid NOT NULL,
  line_id     uuid,
  event       text NOT NULL CHECK (event ~ '^[a-z_]{3,40}$'),
  details     jsonb,
  actor       uuid REFERENCES users (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (check_id, property_id) REFERENCES pos_checks (id, property_id)
);
CREATE INDEX pos_check_events_check ON pos_check_events (check_id, id);
CREATE TRIGGER pos_check_events_append_only BEFORE UPDATE OR DELETE ON pos_check_events
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Kitchen and bar tickets (POS-07). Content is frozen when sent; every print
-- is logged so reprints are labelled. A cancellation ticket tells the station
-- that sent items were cancelled.
-- ---------------------------------------------------------------------------
CREATE TABLE pos_tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL,
  number       text NOT NULL UNIQUE,                   -- K1-KOT-000001
  check_id     uuid NOT NULL,
  station_id   uuid,
  route        text NOT NULL CHECK (route IN ('kitchen', 'bar')),
  kind         text NOT NULL DEFAULT 'order' CHECK (kind IN ('order', 'cancellation')),
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'preparing', 'ready', 'done')),
  content      jsonb NOT NULL,
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, property_id),
  FOREIGN KEY (check_id, property_id) REFERENCES pos_checks (id, property_id),
  FOREIGN KEY (station_id, property_id) REFERENCES pos_stations (id, property_id)
);
CREATE INDEX pos_tickets_station_open ON pos_tickets (station_id, created_at) WHERE status <> 'done';
CREATE TRIGGER pos_tickets_touch BEFORE UPDATE ON pos_tickets
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER pos_tickets_immutable BEFORE UPDATE ON pos_tickets
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('property_id', 'number', 'check_id', 'station_id', 'route', 'kind', 'content', 'created_by', 'created_at');
CREATE TRIGGER pos_tickets_no_delete BEFORE DELETE ON pos_tickets
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

ALTER TABLE pos_check_lines ADD FOREIGN KEY (ticket_id, property_id) REFERENCES pos_tickets (id, property_id);

CREATE TABLE pos_ticket_prints (
  ticket_id   uuid NOT NULL,
  property_id uuid NOT NULL,
  print_no    integer NOT NULL CHECK (print_no >= 1),
  reason      text,
  printed_by  uuid REFERENCES users (id),
  printed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, print_no),
  FOREIGN KEY (ticket_id, property_id) REFERENCES pos_tickets (id, property_id),
  CHECK (print_no = 1 OR reason IS NOT NULL)
);
CREATE TRIGGER pos_ticket_prints_append_only BEFORE UPDATE OR DELETE ON pos_ticket_prints
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Payments at the POS (POS-10). Amount is what was applied to the check;
-- cash tendered above it was given back as change. Pending (e.g. an M-PESA
-- payment not yet verified) never settles the check (AT-15).
-- ---------------------------------------------------------------------------
CREATE TABLE pos_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL,
  check_id      uuid NOT NULL,
  shift_id      uuid,
  tender        payment_tender NOT NULL CHECK (tender IN ('cash', 'mpesa', 'card', 'bank_transfer', 'other')),
  amount        money_amount NOT NULL CHECK (amount > 0),
  tendered      money_amount CHECK (tendered IS NULL OR tendered >= amount),
  reference     text,
  status        text NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  business_date date NOT NULL,
  received_by   uuid REFERENCES users (id),
  received_at   timestamptz NOT NULL DEFAULT now(),
  confirmed_by  uuid REFERENCES users (id),
  confirmed_at  timestamptz,
  failed_reason text,
  UNIQUE (id, property_id),
  FOREIGN KEY (check_id, property_id) REFERENCES pos_checks (id, property_id),
  FOREIGN KEY (shift_id, property_id) REFERENCES cashier_shifts (id, property_id),
  CHECK (tender <> 'cash' OR (shift_id IS NOT NULL AND status = 'confirmed')),
  CHECK (tendered IS NULL OR tender = 'cash'),
  CHECK (tender NOT IN ('mpesa', 'card', 'bank_transfer') OR reference IS NOT NULL),
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CHECK (status <> 'failed' OR failed_reason IS NOT NULL)
);
CREATE INDEX pos_payments_check ON pos_payments (check_id);
CREATE INDEX pos_payments_shift ON pos_payments (shift_id) WHERE shift_id IS NOT NULL;
-- Duplicate callback / double entry protection (BIL-04, AT-03).
CREATE UNIQUE INDEX pos_payments_reference_uq ON pos_payments (tender, upper(reference))
  WHERE reference IS NOT NULL AND tender IN ('mpesa', 'card', 'bank_transfer') AND status <> 'failed';
CREATE TRIGGER pos_payments_immutable BEFORE UPDATE ON pos_payments
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns(
    'property_id', 'check_id', 'shift_id', 'tender', 'amount', 'tendered', 'reference', 'business_date', 'received_by', 'received_at');
CREATE TRIGGER pos_payments_no_delete BEFORE DELETE ON pos_payments
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

CREATE FUNCTION app_pos_payment_status_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'payment % is % and final', OLD.id, OLD.status
      USING ERRCODE = 'HT002', HINT = 'Record a linked refund instead (BIL-07).';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pos_payments_status_rules BEFORE UPDATE ON pos_payments
  FOR EACH ROW EXECUTE FUNCTION app_pos_payment_status_rules();

-- ---------------------------------------------------------------------------
-- Room charge (POS-09, BIL-02, BIL-03): the unpaid remainder of a check moves
-- to the guest's folio as itemised charges, with the guest's acknowledgement.
-- One per check. The folio charges link back to the check (pos_check_id).
-- ---------------------------------------------------------------------------
CREATE TABLE pos_room_charges (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            uuid NOT NULL,
  check_id               uuid NOT NULL UNIQUE,
  stay_id                uuid NOT NULL,
  folio_id               uuid NOT NULL,
  amount                 money_amount NOT NULL CHECK (amount > 0),
  acknowledgement_method text NOT NULL CHECK (acknowledgement_method IN ('guest_signature', 'staff_verified')),
  signed_name            text NOT NULL CHECK (length(signed_name) BETWEEN 2 AND 120),
  signature              text CHECK (signature IS NULL OR length(signature) <= 200000),
  business_date          date NOT NULL,
  posted_by              uuid REFERENCES users (id),
  posted_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, property_id),
  FOREIGN KEY (check_id, property_id) REFERENCES pos_checks (id, property_id),
  FOREIGN KEY (stay_id, property_id) REFERENCES stays (id, property_id),
  FOREIGN KEY (folio_id, property_id) REFERENCES folios (id, property_id),
  CHECK (acknowledgement_method <> 'guest_signature' OR signature IS NOT NULL)
);
CREATE TRIGGER pos_room_charges_append_only BEFORE UPDATE OR DELETE ON pos_room_charges
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

ALTER TABLE folio_charges ADD COLUMN pos_check_id uuid;
ALTER TABLE folio_charges ADD FOREIGN KEY (pos_check_id, property_id) REFERENCES pos_checks (id, property_id);
CREATE INDEX folio_charges_pos_check ON folio_charges (pos_check_id) WHERE pos_check_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- House accounts (POS-18): the whole check goes to a named account with an
-- approval. Not revenue; reported separately with its cost centre.
-- ---------------------------------------------------------------------------
CREATE TABLE house_account_charges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL,
  house_account_id uuid NOT NULL,
  check_id         uuid NOT NULL UNIQUE,
  amount           money_amount NOT NULL CHECK (amount >= 0),
  reason           text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  approval_id      uuid NOT NULL,
  business_date    date NOT NULL,
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (house_account_id, property_id) REFERENCES house_accounts (id, property_id),
  FOREIGN KEY (check_id, property_id) REFERENCES pos_checks (id, property_id),
  FOREIGN KEY (approval_id, property_id) REFERENCES approvals (id, property_id)
);
CREATE INDEX house_account_charges_account ON house_account_charges (house_account_id, business_date);
CREATE TRIGGER house_account_charges_append_only BEFORE UPDATE OR DELETE ON house_account_charges
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Refunds of POS payments (POS-11, BIL-07): linked to the original payment,
-- with reason, approval and a property-prefixed number (K1-RF-…). A refunded
-- prepared item does not go back into stock (INV-06).
-- ---------------------------------------------------------------------------
CREATE TABLE pos_refunds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL,
  number        text NOT NULL UNIQUE,
  check_id      uuid NOT NULL,
  payment_id    uuid NOT NULL,
  tender        payment_tender NOT NULL,
  amount        money_amount NOT NULL CHECK (amount > 0),
  reason        text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  approval_id   uuid NOT NULL,
  shift_id      uuid,
  reference     text,
  business_date date NOT NULL,
  created_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (check_id, property_id) REFERENCES pos_checks (id, property_id),
  FOREIGN KEY (payment_id, property_id) REFERENCES pos_payments (id, property_id),
  FOREIGN KEY (approval_id, property_id) REFERENCES approvals (id, property_id),
  FOREIGN KEY (shift_id, property_id) REFERENCES cashier_shifts (id, property_id),
  CHECK (tender <> 'cash' OR shift_id IS NOT NULL)
);
CREATE INDEX pos_refunds_payment ON pos_refunds (payment_id);
CREATE TRIGGER pos_refunds_append_only BEFORE UPDATE OR DELETE ON pos_refunds
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Check totals. security_invoker so row-level security applies to the caller.
-- due = live lines; settled = confirmed payments + room charge + house account.
-- ---------------------------------------------------------------------------
CREATE VIEW pos_check_totals WITH (security_invoker = true) AS
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
       (coalesce(l.total, 0) - coalesce(p.confirmed, 0) - coalesce(r.amount, 0) - coalesce(h.amount, 0))::numeric(18, 2) AS balance
  FROM pos_checks c
  LEFT JOIN (SELECT check_id, sum(amount) AS total, sum(tax_amount) AS tax, sum(rule_discount + discount_amount) AS discounts
               FROM pos_check_lines WHERE status NOT IN ('cancelled', 'wasted') GROUP BY check_id) l ON l.check_id = c.id
  LEFT JOIN (SELECT check_id, sum(amount) FILTER (WHERE status = 'confirmed') AS confirmed,
                    sum(amount) FILTER (WHERE status = 'pending') AS pending
               FROM pos_payments GROUP BY check_id) p ON p.check_id = c.id
  LEFT JOIN pos_room_charges r ON r.check_id = c.id
  LEFT JOIN house_account_charges h ON h.check_id = c.id
  LEFT JOIN (SELECT check_id, sum(amount) AS amount FROM pos_refunds GROUP BY check_id) rf ON rf.check_id = c.id;

-- ---------------------------------------------------------------------------
-- Row-level security (SEC-06, AT-18) and grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_outlet_days', 'cashier_shifts', 'cash_movements', 'pos_checks', 'pos_check_lines', 'pos_check_events',
                           'pos_tickets', 'pos_ticket_prints', 'pos_payments', 'pos_room_charges', 'house_account_charges', 'pos_refunds'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id))',
                   t || '_scope', t);
  END LOOP;
END;
$$;

GRANT SELECT ON pos_check_totals TO hotel_app;
GRANT SELECT, INSERT, UPDATE ON pos_outlet_days, cashier_shifts, pos_checks, pos_check_lines, pos_tickets, pos_payments TO hotel_app;
GRANT SELECT, INSERT ON cash_movements, pos_check_events, pos_ticket_prints, pos_room_charges, house_account_charges, pos_refunds TO hotel_app;
