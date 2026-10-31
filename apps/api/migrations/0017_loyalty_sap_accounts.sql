-- 0017 SAP G/L account mapping for loyalty journals (LOY18, CLUB07).
-- Finance maps the cashback expense and wallet liability accounts in the back
-- office. Until then, wallet and cashback journals are held here instead of
-- going to the outbox with a placeholder account, and they are released to SAP
-- once, with the mapped accounts, when the mapping is saved.

-- Every mapping change is a new row; the latest is in force.
CREATE TABLE loyalty_sap_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cashback_expense   text NOT NULL CHECK (cashback_expense ~ '^[A-Za-z0-9._-]{1,15}$'),
  wallet_liability   text NOT NULL CHECK (wallet_liability ~ '^[A-Za-z0-9._-]{1,15}$'),
  reason             text NOT NULL,
  created_by         uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (cashback_expense <> wallet_liability)
);
CREATE TRIGGER loyalty_sap_accounts_append_only BEFORE UPDATE OR DELETE ON loyalty_sap_accounts
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- Journals waiting for the mapping. Released once: the outbox row keeps the same external ref.
CREATE TABLE loyalty_held_journals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES properties (id),
  external_ref text NOT NULL UNIQUE,
  kind         text NOT NULL,
  doc_date     date NOT NULL,
  memo         text NOT NULL,
  amount       numeric(18, 2) NOT NULL CHECK (amount > 0),
  reverse      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  mapping_id   uuid REFERENCES loyalty_sap_accounts (id),
  CHECK ((released_at IS NULL) = (mapping_id IS NULL))
);
CREATE INDEX loyalty_held_journals_waiting ON loyalty_held_journals (created_at) WHERE released_at IS NULL;
CREATE TRIGGER loyalty_held_journals_immutable BEFORE UPDATE ON loyalty_held_journals
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('property_id', 'external_ref', 'kind', 'doc_date', 'memo', 'amount', 'reverse', 'created_at');
CREATE TRIGGER loyalty_held_journals_no_delete BEFORE DELETE ON loyalty_held_journals
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

GRANT SELECT, INSERT ON loyalty_sap_accounts TO hotel_app;
GRANT SELECT, INSERT, UPDATE ON loyalty_held_journals TO hotel_app;
