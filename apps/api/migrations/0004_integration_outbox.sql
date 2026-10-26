-- 0004 Durable integration outbox (§9 "keep durable pending events",
-- INT-07, SAP-11, SAP-20, OPS-02). The HQ integration worker pulls from here
-- over HTTPS (outbound-only from HQ, brief §12).

CREATE TYPE outbox_status AS ENUM ('pending', 'claimed', 'posted', 'failed', 'dead');

CREATE TABLE integration_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL REFERENCES properties (id),
  target           text NOT NULL CHECK (target IN ('SAP')),
  event_type       text NOT NULL CHECK (event_type ~ '^[A-Z_]{3,40}$'),
  -- Sent to SAP as U_HTL_ExtRef; the worker looks it up before every attempt (SAP-20).
  external_ref     text NOT NULL UNIQUE CHECK (length(external_ref) BETWEEN 8 AND 100),
  payload          jsonb NOT NULL,
  status           outbox_status NOT NULL DEFAULT 'pending',
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  claimed_by       text,
  claim_expires_at timestamptz,
  sap_doc_entry    integer,
  sap_doc_num      integer,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  posted_at        timestamptz,
  CHECK (status <> 'posted' OR sap_doc_entry IS NOT NULL),
  CHECK (status <> 'claimed' OR (claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL))
);
CREATE INDEX integration_outbox_ready ON integration_outbox (target, next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX integration_outbox_claims ON integration_outbox (claim_expires_at)
  WHERE status = 'claimed';
CREATE INDEX integration_outbox_property_status ON integration_outbox (property_id, status);

CREATE TRIGGER integration_outbox_touch BEFORE UPDATE ON integration_outbox
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
-- The source transaction is never lost or rewritten (SAP-AT06).
CREATE TRIGGER integration_outbox_immutable BEFORE UPDATE ON integration_outbox
  FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('property_id', 'target', 'event_type', 'external_ref', 'payload', 'created_at');
CREATE TRIGGER integration_outbox_no_delete BEFORE DELETE ON integration_outbox
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
-- Once posted, a row is final.
CREATE FUNCTION app_outbox_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'posted integration event % cannot change', OLD.id USING ERRCODE = 'HT002';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER integration_outbox_posted_final BEFORE UPDATE ON integration_outbox
  FOR EACH ROW EXECUTE FUNCTION app_outbox_posted_is_final();

ALTER TABLE integration_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_outbox_scope ON integration_outbox
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));
