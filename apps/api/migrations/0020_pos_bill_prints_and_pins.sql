-- Kahama service-team meeting, 9 Nov 2026.
--
-- 1. Guest bill print control (POS-10, SEC-02, SEC-04). Every bill and receipt
--    print is recorded. A bill may be printed again freely only when it has
--    changed since its last print (new items, cancellations or a discount);
--    otherwise the reprint needs a reason and a manager's approval. Receipts
--    print once; a receipt copy always needs approval.
--
-- 2. Quick waiter sign-in on shared tablets (SEC-03, accountability). A manager
--    registers a tablet for a property; on that tablet staff sign in by tapping
--    their name and entering a personal PIN. Each tablet has its own automatic
--    sign-out (idle time, and optionally after every Send or payment).

-- ---------------------------------------------------------------------------
-- Bill and receipt prints
-- ---------------------------------------------------------------------------
CREATE TABLE pos_bill_prints (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL,
  check_id     uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('bill', 'receipt')),
  -- 1, 2, 3 … per check and kind.
  print_no     integer NOT NULL CHECK (print_no >= 1),
  -- What the slip showed, so the next print can tell whether the bill changed.
  total        numeric(14, 2) NOT NULL,
  line_state   text NOT NULL,
  -- True when the bill had changed since the previous print of this kind.
  changed      boolean NOT NULL,
  reason       text,
  approval_id  uuid REFERENCES approvals (id),
  printed_by   uuid NOT NULL REFERENCES users (id),
  device_id    uuid,
  printed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (check_id, kind, print_no),
  FOREIGN KEY (check_id, property_id) REFERENCES pos_checks (id, property_id),
  -- A copy of an unchanged bill, and any receipt copy, carries its reason and approval.
  CHECK (print_no = 1 OR changed OR (reason IS NOT NULL AND approval_id IS NOT NULL))
);
CREATE INDEX pos_bill_prints_property_time ON pos_bill_prints (property_id, printed_at);
CREATE TRIGGER pos_bill_prints_append_only BEFORE UPDATE OR DELETE ON pos_bill_prints
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
ALTER TABLE pos_bill_prints ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_bill_prints FORCE ROW LEVEL SECURITY;
CREATE POLICY pos_bill_prints_scope ON pos_bill_prints
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));
GRANT SELECT, INSERT ON pos_bill_prints TO hotel_app;

-- ---------------------------------------------------------------------------
-- Registered POS tablets
-- ---------------------------------------------------------------------------
CREATE TABLE pos_devices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           uuid NOT NULL REFERENCES properties (id),
  name                  text NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  -- SHA-256 of a random 256-bit token kept on the tablet; the token itself is never stored.
  token_hash            text NOT NULL UNIQUE,
  -- Signs the user out after this many seconds without a touch (30 s to 30 min).
  idle_signout_seconds  integer NOT NULL DEFAULT 120 CHECK (idle_signout_seconds BETWEEN 30 AND 1800),
  -- Signs the user out straight after each Send to kitchen/bar or payment.
  signout_after_send    boolean NOT NULL DEFAULT false,
  registered_by         uuid NOT NULL REFERENCES users (id),
  registered_at         timestamptz NOT NULL DEFAULT now(),
  revoked_by            uuid REFERENCES users (id),
  revoked_at            timestamptz,
  last_seen_at          timestamptz,
  updated_by            uuid REFERENCES users (id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, property_id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE TRIGGER pos_devices_touch BEFORE UPDATE ON pos_devices
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER pos_devices_no_delete BEFORE DELETE ON pos_devices
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
ALTER TABLE pos_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY pos_devices_scope ON pos_devices
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));
GRANT SELECT, INSERT, UPDATE ON pos_devices TO hotel_app;

ALTER TABLE pos_bill_prints
  ADD FOREIGN KEY (device_id, property_id) REFERENCES pos_devices (id, property_id);

-- ---------------------------------------------------------------------------
-- Personal POS PINs (scrypt hash, same as passwords) with a lockout
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN pos_pin_hash      text,
  ADD COLUMN pos_pin_set_at    timestamptz,
  ADD COLUMN pos_pin_failures  integer NOT NULL DEFAULT 0 CHECK (pos_pin_failures >= 0),
  ADD COLUMN pos_pin_locked_until timestamptz;
