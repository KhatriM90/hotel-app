-- 0012 Basic folio (BIL-01), payments and deposits (BIL-06, RES-07) and
-- guest documents (BIL-09).
--
-- §9 rules applied here:
--  * charges belong to a stay's folio, never to a room number;
--  * charges are append-only; corrections are linked reversals (BIL-07);
--  * payment amounts never change; pending and confirmed are distinct (BIL-06);
--  * price and tax snapshots are stored on each charge;
--  * guest balance = posted charges - confirmed payments; unapplied deposits stay identifiable.

-- ---------------------------------------------------------------------------
-- Charge codes (group master data, CFG-05). Tax codes refer to SAP tax groups
-- in tax_codes (0007); rates are read from there at posting time and snapshotted.
-- The tax mapping per code is provisional until the accountant confirms it (BIL-08, BIL-16).
-- ---------------------------------------------------------------------------
CREATE TABLE charge_codes (
  code               text PRIMARY KEY CHECK (code ~ '^[A-Z_]{2,20}$'),
  name               text NOT NULL,
  category           text NOT NULL CHECK (category IN ('accommodation', 'food', 'beverage', 'laundry', 'minibar', 'fee', 'other')),
  revenue_centre     revenue_centre NOT NULL,
  tax_codes          text[] NOT NULL DEFAULT '{}',
  prices_include_tax boolean NOT NULL DEFAULT true,
  manual_posting     boolean NOT NULL DEFAULT true,   -- false = only the system posts it
  is_active          boolean NOT NULL DEFAULT true
);

INSERT INTO charge_codes (code, name, category, revenue_centre, tax_codes, manual_posting) VALUES
  ('ROOM',          'Accommodation',          'accommodation', 'ROOMS', '{O1,C1}', false),
  ('FOOD',          'Food',                   'food',          'REST',  '{O1,C1}', true),
  ('BEVERAGE',      'Beverages',              'beverage',      'BAR',   '{O1,C1}', true),
  ('LAUNDRY',       'Laundry',                'laundry',       'OTHER', '{O1}',    true),
  ('MINIBAR',       'Minibar',                'minibar',       'OTHER', '{O1,C1}', true),
  ('OTHER',         'Other services',         'other',         'OTHER', '{O1}',    true),
  ('EARLY_CHECKIN', 'Early check-in fee',     'fee',           'ROOMS', '{O1,C1}', false),
  ('LATE_CHECKOUT', 'Late check-out fee',     'fee',           'ROOMS', '{O1,C1}', false),
  ('CANCEL_FEE',    'Cancellation charge',    'fee',           'ROOMS', '{O1}',    false),
  ('NO_SHOW_FEE',   'No-show charge',         'fee',           'ROOMS', '{O1}',    false);

-- ---------------------------------------------------------------------------
-- Folios (BIL-01). One per stay for now; split folios (BIL-05) add more.
-- ---------------------------------------------------------------------------
CREATE TABLE folios (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL REFERENCES properties (id),
  number         text NOT NULL UNIQUE,              -- permanent folio ID, e.g. K1-FO-000001 (§9)
  stay_id        uuid NOT NULL,
  reservation_id uuid NOT NULL,
  is_primary     boolean NOT NULL DEFAULT true,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at      timestamptz,
  closed_by      uuid REFERENCES users (id),
  finalised_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, property_id),
  FOREIGN KEY (stay_id, property_id) REFERENCES stays (id, property_id),
  FOREIGN KEY (reservation_id, property_id) REFERENCES reservations (id, property_id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (status = 'closed' OR finalised_at IS NULL)
);
CREATE UNIQUE INDEX folios_one_primary ON folios (stay_id) WHERE is_primary;
CREATE TRIGGER folios_finalised_guard BEFORE UPDATE OR DELETE ON folios
  FOR EACH ROW EXECUTE FUNCTION app_guard_finalised();
CREATE TRIGGER folios_immutable BEFORE UPDATE ON folios
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('property_id', 'number', 'stay_id', 'reservation_id', 'created_at');

-- ---------------------------------------------------------------------------
-- Charges (BIL-01): dates, quantities, outlets, tax, discounts, references.
-- Append-only. A reversal is a new row with the negated amounts and a link.
-- ---------------------------------------------------------------------------
CREATE TABLE folio_charges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL,
  folio_id        uuid NOT NULL,
  stay_id         uuid NOT NULL,
  charge_code     text NOT NULL REFERENCES charge_codes (code),
  description     text NOT NULL,
  outlet_id       uuid,
  service_date    date NOT NULL,                     -- business date the service belongs to (§9)
  quantity        quantity NOT NULL CHECK (quantity <> 0),
  unit_price      money_precise NOT NULL,            -- price snapshot, tax-inclusive
  discount_amount money_amount NOT NULL DEFAULT 0,
  amount          money_amount NOT NULL,             -- gross charged, after discount, incl. tax
  net_amount      money_amount NOT NULL,             -- ex tax
  tax_amount      money_amount NOT NULL,
  -- Room-night charges: one per stay and night, enforced below (BIL-10, AT-11).
  room_night_date date,
  reference       text,
  reversal_of     uuid REFERENCES folio_charges (id),
  reason          text,
  approval_id     uuid,
  posted_by       uuid REFERENCES users (id),
  posted_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, property_id),
  FOREIGN KEY (folio_id, property_id) REFERENCES folios (id, property_id),
  FOREIGN KEY (stay_id, property_id) REFERENCES stays (id, property_id),
  -- BIL-17: an outlet can only charge a folio at its own property.
  FOREIGN KEY (outlet_id, property_id) REFERENCES outlets (id, property_id),
  FOREIGN KEY (approval_id, property_id) REFERENCES approvals (id, property_id),
  CHECK (amount = net_amount + tax_amount),
  CHECK (reversal_of IS NULL OR (reason IS NOT NULL AND approval_id IS NOT NULL)),
  CHECK (discount_amount >= 0 OR reversal_of IS NOT NULL)
);
CREATE INDEX folio_charges_folio ON folio_charges (folio_id, posted_at);
CREATE UNIQUE INDEX folio_charges_one_room_night ON folio_charges (stay_id, room_night_date) WHERE room_night_date IS NOT NULL;
CREATE UNIQUE INDEX folio_charges_one_reversal ON folio_charges (reversal_of) WHERE reversal_of IS NOT NULL;
CREATE TRIGGER folio_charges_append_only BEFORE UPDATE OR DELETE ON folio_charges
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
CREATE TRIGGER folio_charges_no_truncate BEFORE TRUNCATE ON folio_charges
  FOR EACH STATEMENT EXECUTE FUNCTION app_forbid_mutation();

-- Tax lines per charge, with the rate in force at posting (§9 snapshots, BIL-16:
-- the catering levy is its own line, separate from VAT).
CREATE TABLE folio_charge_taxes (
  charge_id      uuid NOT NULL,
  property_id    uuid NOT NULL,
  tax_code       text NOT NULL REFERENCES tax_codes (sap_code),
  rate_percent   rate NOT NULL,
  taxable_amount money_amount NOT NULL,
  tax_amount     money_amount NOT NULL,
  PRIMARY KEY (charge_id, tax_code),
  FOREIGN KEY (charge_id, property_id) REFERENCES folio_charges (id, property_id)
);
CREATE TRIGGER folio_charge_taxes_append_only BEFORE UPDATE OR DELETE ON folio_charge_taxes
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Payments (BIL-06, RES-07). Each tender is one payment row. Amounts never
-- change; status moves pending → confirmed or pending → failed exactly once.
-- city_ledger is a credit transfer to a company account, not cash (BIL-12).
-- ---------------------------------------------------------------------------
CREATE TYPE payment_tender AS ENUM ('cash', 'mpesa', 'card', 'bank_transfer', 'cheque', 'city_ledger', 'other');

CREATE TABLE folio_payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id        uuid NOT NULL,
  folio_id           uuid NOT NULL,
  tender             payment_tender NOT NULL,
  amount             money_amount NOT NULL CHECK (amount > 0),
  reference          text,                         -- M-PESA code, card auth, bank ref
  status             text NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  is_deposit         boolean NOT NULL DEFAULT false,
  -- When a deposit was applied to the stay's charges at check-in (RES-07).
  deposit_applied_at timestamptz,
  company_id         uuid REFERENCES companies (id),
  approval_id        uuid,
  business_date      date NOT NULL,
  receipt_number     text UNIQUE,                  -- allocated on confirmation (BIL-09)
  received_by        uuid REFERENCES users (id),
  received_at        timestamptz NOT NULL DEFAULT now(),
  confirmed_by       uuid REFERENCES users (id),
  confirmed_at       timestamptz,
  failed_reason      text,
  UNIQUE (id, property_id),
  FOREIGN KEY (folio_id, property_id) REFERENCES folios (id, property_id),
  FOREIGN KEY (approval_id, property_id) REFERENCES approvals (id, property_id),
  CHECK (tender <> 'city_ledger' OR (company_id IS NOT NULL AND approval_id IS NOT NULL)),
  CHECK (tender NOT IN ('mpesa', 'card', 'bank_transfer', 'cheque') OR reference IS NOT NULL),
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CHECK (status <> 'failed' OR failed_reason IS NOT NULL),
  CHECK (deposit_applied_at IS NULL OR (is_deposit AND status = 'confirmed'))
);
CREATE INDEX folio_payments_folio ON folio_payments (folio_id, received_at);
-- Duplicate callback / double-entry protection for provider references (BIL-04, AT-03).
CREATE UNIQUE INDEX folio_payments_reference_uq ON folio_payments (tender, upper(reference))
  WHERE reference IS NOT NULL AND tender IN ('mpesa', 'card', 'bank_transfer', 'cheque') AND status <> 'failed';
CREATE TRIGGER folio_payments_immutable BEFORE UPDATE ON folio_payments
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns(
    'property_id', 'folio_id', 'tender', 'amount', 'reference', 'is_deposit', 'company_id',
    'approval_id', 'business_date', 'received_by', 'received_at');
CREATE TRIGGER folio_payments_no_delete BEFORE DELETE ON folio_payments
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

CREATE FUNCTION app_payment_status_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       -- the receipt number is written once, in the transaction that confirms the payment
       OR (OLD.receipt_number IS NOT NULL AND NEW.receipt_number IS DISTINCT FROM OLD.receipt_number)
       OR (NEW.receipt_number IS NOT NULL AND OLD.status <> 'confirmed')
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
       OR NEW.failed_reason IS DISTINCT FROM OLD.failed_reason THEN
      RAISE EXCEPTION 'payment % is % and final', OLD.id, OLD.status
        USING ERRCODE = 'HT002', HINT = 'Record a linked refund instead (BIL-07).';
    END IF;
    IF OLD.deposit_applied_at IS NOT NULL AND NEW.deposit_applied_at IS DISTINCT FROM OLD.deposit_applied_at THEN
      RAISE EXCEPTION 'deposit application of payment % is final', OLD.id USING ERRCODE = 'HT002';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER folio_payments_status_rules BEFORE UPDATE ON folio_payments
  FOR EACH ROW EXECUTE FUNCTION app_payment_status_rules();

-- ---------------------------------------------------------------------------
-- Balances. security_invoker so row-level security applies to the caller.
-- Guest balance = posted charges - confirmed payments (§9).
-- ---------------------------------------------------------------------------
CREATE VIEW folio_balances WITH (security_invoker = true) AS
SELECT f.id AS folio_id,
       f.property_id,
       coalesce(c.total, 0)::numeric(18, 2) AS charges_total,
       coalesce(p.confirmed, 0)::numeric(18, 2) AS payments_confirmed,
       coalesce(p.pending, 0)::numeric(18, 2) AS payments_pending,
       coalesce(p.deposits_unapplied, 0)::numeric(18, 2) AS deposits_unapplied,
       (coalesce(c.total, 0) - coalesce(p.confirmed, 0))::numeric(18, 2) AS balance
  FROM folios f
  LEFT JOIN (SELECT folio_id, sum(amount) AS total FROM folio_charges GROUP BY folio_id) c ON c.folio_id = f.id
  LEFT JOIN (SELECT folio_id,
                    sum(amount) FILTER (WHERE status = 'confirmed') AS confirmed,
                    sum(amount) FILTER (WHERE status = 'pending') AS pending,
                    sum(amount) FILTER (WHERE status = 'confirmed' AND is_deposit AND deposit_applied_at IS NULL) AS deposits_unapplied
               FROM folio_payments GROUP BY folio_id) p ON p.folio_id = f.id;

-- ---------------------------------------------------------------------------
-- Documents (BIL-09): pro forma, final invoice and receipt, each with a
-- unique property-prefixed number, a frozen content snapshot and a link to
-- what it was issued for. Running statements are generated on demand and are
-- not numbered. Credit notes arrive with BIL-07.
-- ---------------------------------------------------------------------------
CREATE TABLE documents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          uuid NOT NULL REFERENCES properties (id),
  document_type        text NOT NULL REFERENCES document_types (code)
                         CHECK (document_type IN ('PROFORMA', 'INVOICE', 'RECEIPT', 'CREDIT_NOTE')),
  number               text NOT NULL UNIQUE REFERENCES number_allocations (number),
  reservation_id       uuid,
  stay_id              uuid,
  folio_id             uuid,
  payment_id           uuid,
  original_document_id uuid REFERENCES documents (id),
  total                money_amount NOT NULL,
  content              jsonb NOT NULL,
  issued_by            uuid REFERENCES users (id),
  issued_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (reservation_id, property_id) REFERENCES reservations (id, property_id),
  FOREIGN KEY (stay_id, property_id) REFERENCES stays (id, property_id),
  FOREIGN KEY (folio_id, property_id) REFERENCES folios (id, property_id),
  FOREIGN KEY (payment_id, property_id) REFERENCES folio_payments (id, property_id),
  CHECK (document_type <> 'INVOICE' OR folio_id IS NOT NULL),
  CHECK (document_type <> 'RECEIPT' OR payment_id IS NOT NULL),
  CHECK (document_type <> 'PROFORMA' OR reservation_id IS NOT NULL),
  CHECK (document_type <> 'CREDIT_NOTE' OR original_document_id IS NOT NULL)
);
CREATE UNIQUE INDEX documents_one_invoice_per_folio ON documents (folio_id) WHERE document_type = 'INVOICE';
CREATE UNIQUE INDEX documents_one_receipt_per_payment ON documents (payment_id) WHERE document_type = 'RECEIPT';
CREATE INDEX documents_reservation ON documents (reservation_id) WHERE reservation_id IS NOT NULL;
CREATE TRIGGER documents_append_only BEFORE UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
CREATE TRIGGER documents_no_truncate BEFORE TRUNCATE ON documents
  FOR EACH STATEMENT EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Row-level security (SEC-06, AT-18) and grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['folios', 'folio_charges', 'folio_charge_taxes', 'folio_payments', 'documents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id))',
                   t || '_scope', t);
  END LOOP;
END;
$$;

GRANT SELECT ON charge_codes, folio_balances TO hotel_app;
GRANT SELECT, INSERT, UPDATE ON folios, folio_payments TO hotel_app;
GRANT SELECT, INSERT ON folio_charges, folio_charge_taxes, documents TO hotel_app;
