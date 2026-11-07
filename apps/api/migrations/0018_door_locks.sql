-- 0018 Door locks (INT-09, FD-03, FD-05): TEMIC20 "V20 RF" guest key cards.
--
-- All three properties use TEMIC20 locks with one card encoder at each
-- reception, and YeaStay is the only system that issues guest cards
-- (Manish, 7 Nov 2026). The vendor's HUNERF.dll is 32-bit Windows, so a small
-- bridge program on the reception PC pulls encode jobs from here over
-- outbound HTTPS, like the SAP worker (brief §12), and reports the result.
--
--  * door_lock_settings: one row per property: the vendor's SystemCode and
--    HotelCode, encoder COM port, grace after check-out time, the card number
--    counter and the paired bridge (only a SHA-256 of its token is stored).
--  * rooms.lock_address: the 11-digit address from the lock software.
--  * room_lock_state: the room password (RPass) on the room's newest guest
--    card. A "new" card writes a newer one and cancels earlier guest cards at
--    the door; a "duplicate" card reuses it.
--  * key_cards: every encode or read request and its outcome: the keys
--    history kept on the stay through room moves (FD-05). Never deleted.
--
-- Numbered 0018 so it sorts after the loyalty branch's 0016/0017 migrations.

CREATE TABLE door_lock_settings (
  property_id         uuid PRIMARY KEY REFERENCES properties (id),
  vendor              text NOT NULL DEFAULT 'TEMIC20' CHECK (vendor IN ('TEMIC20')),
  enabled             boolean NOT NULL DEFAULT false,
  -- From the vendor (they read them from the lock software's HData.mdb).
  system_code         text CHECK (system_code IS NULL OR system_code ~ '^[0-9A-Za-z]{1,32}$'),
  hotel_code          text CHECK (hotel_code IS NULL OR hotel_code ~ '^[0-9A-Za-z]{1,32}$'),
  card_pass           text NOT NULL DEFAULT '82A094FFFFFF' CHECK (card_pass ~ '^[0-9A-F]{12}$'),
  com_port            smallint NOT NULL DEFAULT 1 CHECK (com_port BETWEEN 1 AND 64),
  -- Cards stop working this long after the stay's check-out time.
  card_grace_minutes  smallint NOT NULL DEFAULT 30 CHECK (card_grace_minutes BETWEEN 0 AND 720),
  next_card_no        integer NOT NULL DEFAULT 1 CHECK (next_card_no BETWEEN 1 AND 16777215),
  bridge_token_hash   text UNIQUE CHECK (bridge_token_hash IS NULL OR bridge_token_hash ~ '^[0-9a-f]{64}$'),
  bridge_paired_at    timestamptz,
  bridge_paired_by    uuid REFERENCES users (id),
  bridge_last_seen_at timestamptz,
  bridge_id           text,
  bridge_version      text,
  bridge_mode         text CHECK (bridge_mode IS NULL OR bridge_mode IN ('dll', 'mock')),
  updated_by          uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR (system_code IS NOT NULL AND hotel_code IS NOT NULL))
);
INSERT INTO door_lock_settings (property_id) SELECT id FROM properties;
CREATE TRIGGER door_lock_settings_touch BEFORE UPDATE ON door_lock_settings
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER door_lock_settings_no_delete BEFORE DELETE ON door_lock_settings
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
ALTER TABLE door_lock_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE door_lock_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY door_lock_settings_scope ON door_lock_settings
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));
GRANT SELECT, INSERT, UPDATE ON door_lock_settings TO hotel_app;

ALTER TABLE rooms ADD COLUMN lock_address text CHECK (lock_address IS NULL OR lock_address ~ '^01[0-9]{9}$');
CREATE UNIQUE INDEX rooms_lock_address ON rooms (property_id, lock_address) WHERE lock_address IS NOT NULL;

CREATE TABLE key_cards (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL REFERENCES properties (id),
  kind             text NOT NULL CHECK (kind IN ('new', 'duplicate', 'read')),
  stay_id          uuid,
  room_id          uuid,
  -- Duplicates queued with a new card in one request are cancelled if it fails.
  parent_id        uuid REFERENCES key_cards (id),
  card_no          integer CHECK (card_no IS NULL OR card_no BETWEEN 1 AND 16777215),
  lock_address     text CHECK (lock_address IS NULL OR lock_address ~ '^01[0-9]{9}$'),
  room_pass        text CHECK (room_pass IS NULL OR room_pass ~ '^[0-9A-F]{1,8}$'),
  valid_from       timestamptz,
  valid_to         timestamptz,
  -- The exact KeyCard arguments sent to the bridge (codes included), for support.
  params           jsonb,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'encoding', 'done', 'failed', 'cancelled')),
  claimed_by       text,
  claim_expires_at timestamptz,
  error_code       integer,
  error            text,
  -- What a read job found on the card.
  read_card_no     integer,
  read_system_code text,
  requested_by     uuid REFERENCES users (id),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  cancelled_by     uuid REFERENCES users (id),
  UNIQUE (id, property_id),
  FOREIGN KEY (stay_id, property_id) REFERENCES stays (id, property_id),
  FOREIGN KEY (room_id, property_id) REFERENCES rooms (id, property_id),
  CHECK (kind = 'read' OR (stay_id IS NOT NULL AND room_id IS NOT NULL AND card_no IS NOT NULL AND lock_address IS NOT NULL
                           AND room_pass IS NOT NULL AND valid_from IS NOT NULL AND valid_to > valid_from AND params IS NOT NULL)),
  CHECK ((status IN ('done', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);
CREATE INDEX key_cards_queue ON key_cards (property_id, requested_at) WHERE status IN ('pending', 'encoding');
CREATE INDEX key_cards_stay ON key_cards (stay_id, requested_at);
CREATE INDEX key_cards_card_no ON key_cards (property_id, card_no, requested_at) WHERE status = 'done';
CREATE TRIGGER key_cards_immutable BEFORE UPDATE ON key_cards
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns(
    'property_id', 'kind', 'stay_id', 'room_id', 'parent_id', 'card_no', 'lock_address', 'room_pass', 'valid_from', 'valid_to',
    'params', 'requested_by', 'requested_at');
CREATE TRIGGER key_cards_no_delete BEFORE DELETE ON key_cards
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
ALTER TABLE key_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE key_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY key_cards_scope ON key_cards
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));
GRANT SELECT, INSERT, UPDATE ON key_cards TO hotel_app;

CREATE TABLE room_lock_state (
  room_id      uuid PRIMARY KEY,
  property_id  uuid NOT NULL REFERENCES properties (id),
  room_pass    text NOT NULL CHECK (room_pass ~ '^[0-9A-F]{1,8}$'),
  -- The "new" card that set it (and so the stay it belongs to).
  key_card_id  uuid NOT NULL REFERENCES key_cards (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (room_id, property_id) REFERENCES rooms (id, property_id)
);
CREATE TRIGGER room_lock_state_touch BEFORE UPDATE ON room_lock_state
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER room_lock_state_no_delete BEFORE DELETE ON room_lock_state
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
ALTER TABLE room_lock_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_lock_state FORCE ROW LEVEL SECURITY;
CREATE POLICY room_lock_state_scope ON room_lock_state
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));
GRANT SELECT, INSERT, UPDATE ON room_lock_state TO hotel_app;
