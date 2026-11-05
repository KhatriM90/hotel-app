-- 0016 Front desk changes requested after the 5 Nov 2026 client demo.
--
--  * guests.kra_pin and group-wide rules for which guest fields are mandatory;
--  * companies get notes and credit terms, and can be added from the app (agents);
--  * stays.auto_post_room_charges: a manager can stop the nightly room-charge
--    posting for one stay (charges are then posted at checkout);
--  * booking_policies.hotel_policies: house rules shown in guest emails and on
--    the registration card;
--  * email_outbox: guest emails (booking confirmation with pro forma, receipts
--    and policies), sent with retries and an idempotency key per message.

ALTER TABLE guests ADD COLUMN kra_pin text CHECK (kra_pin IS NULL OR kra_pin ~ '^[A-Z][0-9]{9}[A-Z]$');
CREATE INDEX guests_kra_pin ON guests (kra_pin) WHERE kra_pin IS NOT NULL;

CREATE TABLE guest_field_rules (
  field       text PRIMARY KEY CHECK (field IN ('phone', 'email', 'nationality', 'kraPin', 'dateOfBirth', 'address')),
  requirement text NOT NULL CHECK (requirement IN ('required', 'required_kenyan', 'optional')),
  updated_by  uuid REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO guest_field_rules (field, requirement) VALUES
  ('phone', 'required'), ('email', 'optional'), ('nationality', 'required'),
  ('kraPin', 'required_kenyan'), ('dateOfBirth', 'optional'), ('address', 'optional');
CREATE TRIGGER guest_field_rules_touch BEFORE UPDATE ON guest_field_rules
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
GRANT SELECT, UPDATE ON guest_field_rules TO hotel_app;

ALTER TABLE companies
  ADD COLUMN notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  ADD COLUMN credit_days smallint CHECK (credit_days IS NULL OR credit_days BETWEEN 0 AND 365),
  ADD COLUMN created_by uuid REFERENCES users (id);

ALTER TABLE stays ADD COLUMN auto_post_room_charges boolean NOT NULL DEFAULT true;

ALTER TABLE booking_policies ADD COLUMN hotel_policies text NOT NULL DEFAULT '' CHECK (length(hotel_policies) <= 10000);

CREATE TABLE email_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties (id),
  -- One message per key: re-sending the same confirmation never mails twice.
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  kind            text NOT NULL CHECK (kind IN ('booking_confirmation')),
  reservation_id  uuid,
  to_address      text NOT NULL CHECK (to_address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  subject         text NOT NULL,
  html            text NOT NULL,
  -- Document ids attached as PDFs when the message is sent.
  attachments     uuid[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  sent_at         timestamptz,
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (reservation_id, property_id) REFERENCES reservations (id, property_id),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX email_outbox_ready ON email_outbox (next_attempt_at) WHERE status IN ('pending', 'failed');
CREATE INDEX email_outbox_reservation ON email_outbox (reservation_id);
CREATE TRIGGER email_outbox_touch BEFORE UPDATE ON email_outbox
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER email_outbox_immutable BEFORE UPDATE ON email_outbox
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('property_id', 'idempotency_key', 'kind', 'reservation_id', 'to_address', 'subject', 'html', 'attachments', 'created_at');
CREATE TRIGGER email_outbox_no_delete BEFORE DELETE ON email_outbox
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY email_outbox_scope ON email_outbox
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));
GRANT SELECT, INSERT, UPDATE ON email_outbox TO hotel_app;
