-- 0003 Property-scoped document numbering (CFG-04, BIL-09), idempotency keys
-- (§9, BIL-04) and the append-only audit log (SEC-04).

-- ---------------------------------------------------------------------------
-- Document numbering. Numbers carry the property prefix and are unique
-- group-wide, e.g. K1-INV-000123. The counter is a row lock, not a SEQUENCE,
-- so numbers are gapless: a rolled-back business transaction rolls back its
-- number too.
-- ---------------------------------------------------------------------------
CREATE TABLE document_types (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z_]{2,32}$'),
  prefix      text NOT NULL UNIQUE CHECK (prefix ~ '^[A-Z]{2,4}$'),
  description text NOT NULL
);

INSERT INTO document_types (code, prefix, description) VALUES
  ('BOOKING',     'BK',  'Reservation / booking reference'),
  ('STAY',        'ST',  'Guest stay (permanent identity, survives room moves)'),
  ('FOLIO',       'FO',  'Guest folio / financial account for a stay'),
  ('POS_CHECK',   'CHK', 'POS check'),
  ('INVOICE',     'INV', 'Final invoice'),
  ('RECEIPT',     'RCT', 'Payment receipt'),
  ('CREDIT_NOTE', 'CN',  'Credit note'),
  ('REFUND',      'RF',  'Refund'),
  ('PROFORMA',    'PF',  'Quotation / pro forma');

CREATE TABLE number_sequences (
  property_id   uuid NOT NULL REFERENCES properties (id),
  document_type text NOT NULL REFERENCES document_types (code),
  next_value    bigint NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  padding       smallint NOT NULL DEFAULT 6 CHECK (padding BETWEEN 1 AND 12),
  PRIMARY KEY (property_id, document_type)
);

-- Every number ever issued; append-only, so issued numbers can be reconciled.
CREATE TABLE number_allocations (
  number        text PRIMARY KEY,
  property_id   uuid NOT NULL REFERENCES properties (id),
  document_type text NOT NULL REFERENCES document_types (code),
  seq_value     bigint NOT NULL,
  allocated_by  uuid REFERENCES users (id),
  allocated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, document_type, seq_value)
);
CREATE TRIGGER number_allocations_append_only BEFORE UPDATE OR DELETE ON number_allocations
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
CREATE TRIGGER number_allocations_no_truncate BEFORE TRUNCATE ON number_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION app_forbid_mutation();

-- Allocates the next number for a property/document type. Runs with the
-- caller's privileges, so row-level security confines it to properties the
-- caller may see. Call it inside the transaction that creates the document.
CREATE FUNCTION next_document_number(p_property_id uuid, p_document_type text, p_actor uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_seq     bigint;
  v_padding smallint;
  v_code    text;
  v_prefix  text;
  v_digits  text;
  v_number  text;
BEGIN
  UPDATE number_sequences
     SET next_value = next_value + 1
   WHERE property_id = p_property_id AND document_type = p_document_type
  RETURNING next_value - 1, padding INTO v_seq, v_padding;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no numbering sequence for property % / %, or property not in scope',
      p_property_id, p_document_type USING ERRCODE = 'HT003';
  END IF;

  SELECT p.code INTO STRICT v_code FROM properties p WHERE p.id = p_property_id;
  SELECT d.prefix INTO STRICT v_prefix FROM document_types d WHERE d.code = p_document_type;

  v_digits := v_seq::text;
  IF length(v_digits) < v_padding THEN
    v_digits := lpad(v_digits, v_padding, '0');
  END IF;
  v_number := v_code || '-' || v_prefix || '-' || v_digits;

  INSERT INTO number_allocations (number, property_id, document_type, seq_value, allocated_by)
  VALUES (v_number, p_property_id, p_document_type, v_seq, p_actor);

  RETURN v_number;
END;
$$;

-- New properties get their sequences automatically.
CREATE FUNCTION app_create_property_sequences() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO number_sequences (property_id, document_type)
  SELECT NEW.id, d.code FROM document_types d
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER properties_create_sequences AFTER INSERT ON properties
  FOR EACH ROW EXECUTE FUNCTION app_create_property_sequences();

INSERT INTO number_sequences (property_id, document_type)
SELECT p.id, d.code FROM properties p CROSS JOIN document_types d;

ALTER TABLE number_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE number_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY number_sequences_scope ON number_sequences
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));

ALTER TABLE number_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE number_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY number_allocations_scope ON number_allocations
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));

-- ---------------------------------------------------------------------------
-- Idempotency keys (§9: POS postings, nightly charges, payment callbacks,
-- fiscal submissions; BIL-04; AT-03). The key row is inserted in the same
-- transaction as the business change, so either both commit or neither does.
-- A concurrent duplicate blocks on the primary key until the first commits,
-- then replays the stored response.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  scope           text NOT NULL,
  key             text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  property_id     uuid REFERENCES properties (id),
  request_hash    text NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX idempotency_keys_expiry ON idempotency_keys (expires_at);
CREATE TRIGGER idempotency_keys_immutable BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('scope', 'key', 'property_id', 'request_hash', 'created_by');

-- ---------------------------------------------------------------------------
-- Audit log (SEC-04): actor, time, business date, record, previous/new values
-- and reason. Append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  business_date   date,
  property_id     uuid REFERENCES properties (id),
  actor_user_id   uuid REFERENCES users (id),
  action          text NOT NULL,
  entity_type     text,
  entity_id       text,
  previous_values jsonb,
  new_values      jsonb,
  reason          text,
  request_id      text,
  ip_address      text
);
CREATE INDEX audit_events_property_time ON audit_events (property_id, occurred_at DESC);
CREATE INDEX audit_events_entity ON audit_events (entity_type, entity_id);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app_forbid_mutation();
