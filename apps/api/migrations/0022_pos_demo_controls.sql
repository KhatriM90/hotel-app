-- Controls asked for at the Kahama POS demo, 25 Nov 2026.
--  * outlets.counter_staff_only: counter sales and bar tabs only for barmen,
--    cashiers and supervisors at that outlet (waiters keep tables, takeaway
--    and room service). On at Kahama outlets that also serve tables.
--  * pos_room_charge_moves: a room charge posted to the wrong room is moved to
--    the right one with a supervisor's approval. The wrong folio gets linked
--    reversals, the right folio the same charges; nothing is edited or deleted.

ALTER TABLE outlets ADD COLUMN counter_staff_only boolean NOT NULL DEFAULT false;

UPDATE outlets SET counter_staff_only = true
 WHERE property_id = (SELECT id FROM properties WHERE code = 'KM') AND 'table' = ANY (service_types);

CREATE TABLE pos_room_charge_moves (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            uuid NOT NULL,
  check_id               uuid NOT NULL,
  from_stay_id           uuid NOT NULL,
  from_folio_id          uuid NOT NULL,
  to_stay_id             uuid NOT NULL,
  to_folio_id            uuid NOT NULL,
  amount                 money_amount NOT NULL CHECK (amount > 0),
  reason                 text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  approval_id            uuid NOT NULL REFERENCES approvals (id),
  acknowledgement_method text NOT NULL CHECK (acknowledgement_method IN ('guest_signature', 'staff_verified')),
  signed_name            text NOT NULL CHECK (length(signed_name) BETWEEN 2 AND 120),
  signature              text CHECK (signature IS NULL OR length(signature) <= 200000),
  moved_by               uuid REFERENCES users (id),
  moved_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, property_id),
  FOREIGN KEY (check_id, property_id) REFERENCES pos_checks (id, property_id),
  FOREIGN KEY (from_stay_id, property_id) REFERENCES stays (id, property_id),
  FOREIGN KEY (to_stay_id, property_id) REFERENCES stays (id, property_id),
  FOREIGN KEY (from_folio_id, property_id) REFERENCES folios (id, property_id),
  FOREIGN KEY (to_folio_id, property_id) REFERENCES folios (id, property_id),
  CHECK (from_stay_id <> to_stay_id),
  CHECK (acknowledgement_method <> 'guest_signature' OR signature IS NOT NULL)
);
CREATE INDEX pos_room_charge_moves_check ON pos_room_charge_moves (check_id, moved_at);
CREATE TRIGGER pos_room_charge_moves_append_only BEFORE UPDATE OR DELETE ON pos_room_charge_moves
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

ALTER TABLE pos_room_charge_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_room_charge_moves FORCE ROW LEVEL SECURITY;
CREATE POLICY pos_room_charge_moves_scope ON pos_room_charge_moves
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));
GRANT SELECT, INSERT ON pos_room_charge_moves TO hotel_app;
