-- Customer KRA PIN on POS bills (POS demo, 25 Nov 2026, points 15 to 17).
--
-- Before settling, the waiter asks whether the customer wants their KRA PIN on
-- the bill. Regular customers are saved so they can be found again by name,
-- phone or PIN. The group is one legal entity, so saved customers are shared by
-- all three properties, like guests and companies.
--
-- The check keeps a copy of the name, PIN and phone as they were when set, so a
-- later change to the saved customer never alters a bill already printed.

CREATE TABLE pos_customers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  kra_pin              text CHECK (kra_pin IS NULL OR kra_pin ~ '^[A-Z][0-9]{9}[A-Z]$'),
  phone                text CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{7,15}$'),
  is_active            boolean NOT NULL DEFAULT true,
  created_property_id  uuid REFERENCES properties (id),
  created_by           uuid REFERENCES users (id),
  updated_by           uuid REFERENCES users (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pos_customers_pin ON pos_customers (kra_pin) WHERE kra_pin IS NOT NULL;
CREATE INDEX pos_customers_name ON pos_customers (lower(name) text_pattern_ops);
CREATE INDEX pos_customers_phone ON pos_customers (phone) WHERE phone IS NOT NULL;
CREATE TRIGGER pos_customers_touch BEFORE UPDATE ON pos_customers
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER pos_customers_no_delete BEFORE DELETE ON pos_customers
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
GRANT SELECT, INSERT, UPDATE ON pos_customers TO hotel_app;

ALTER TABLE pos_checks
  ADD COLUMN customer_id      uuid REFERENCES pos_customers (id),
  ADD COLUMN customer_name    text CHECK (customer_name IS NULL OR length(btrim(customer_name)) BETWEEN 2 AND 120),
  ADD COLUMN customer_kra_pin text CHECK (customer_kra_pin IS NULL OR customer_kra_pin ~ '^[A-Z][0-9]{9}[A-Z]$'),
  ADD COLUMN customer_phone   text CHECK (customer_phone IS NULL OR customer_phone ~ '^\+?[0-9]{7,15}$'),
  ADD CONSTRAINT pos_checks_customer_named CHECK (customer_kra_pin IS NULL OR customer_name IS NOT NULL);
