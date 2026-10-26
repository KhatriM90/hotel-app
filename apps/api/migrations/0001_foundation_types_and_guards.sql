-- 0001 Foundation: money domains, append-only and finalised-record guards,
-- and the property-scope predicate used by row-level security.
-- Brief v1.2 §9 non-negotiables.

-- ---------------------------------------------------------------------------
-- Decimal money (§9 "Use decimal money and consistent rounding")
-- ---------------------------------------------------------------------------
-- Settled amounts: 2 decimals (KES cents).
CREATE DOMAIN money_amount AS numeric(18, 2)
  CHECK (VALUE <> 'NaN'::numeric);
-- Unit prices, ex-tax intermediates and snapshots that need more precision.
CREATE DOMAIN money_precise AS numeric(20, 6)
  CHECK (VALUE <> 'NaN'::numeric);
-- Tax rates, levy rates, exchange rates (e.g. 0.160000).
CREATE DOMAIN rate AS numeric(12, 6)
  CHECK (VALUE <> 'NaN'::numeric AND VALUE >= 0);
-- Stock and sale quantities (bar ml / bottle conversions need decimals, INV-04).
CREATE DOMAIN quantity AS numeric(18, 4)
  CHECK (VALUE <> 'NaN'::numeric);

-- ---------------------------------------------------------------------------
-- Append-only guard: attach to ledgers/logs that may only ever be inserted.
--   CREATE TRIGGER x_append_only BEFORE UPDATE OR DELETE ON x
--     FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
--   CREATE TRIGGER x_no_truncate BEFORE TRUNCATE ON x
--     FOR EACH STATEMENT EXECUTE FUNCTION app_forbid_mutation();
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on %.% is not permitted', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'HT001',
          HINT = 'Record a linked reversing/correcting entry instead (BIL-07).';
END;
$$;

-- ---------------------------------------------------------------------------
-- Finalised-record guard (§9 "Staff must not silently edit or delete
-- finalised transactions"; BIL-07). Attach to any table with a
-- `finalised_at timestamptz` column:
--   CREATE TRIGGER x_finalised_guard BEFORE UPDATE OR DELETE ON x
--     FOR EACH ROW EXECUTE FUNCTION app_guard_finalised('col_a', 'col_b');
-- Trigger arguments name columns that may still change after finalisation
-- (e.g. an integration status pointer). Everything else is frozen, including
-- finalised_at itself, and finalised rows can never be deleted.
-- Prefer keeping integration/fiscal status in side tables (§9 "keep order
-- fulfilment, payment status, folio posting and fiscal-invoice status separate").
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_guard_finalised() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable_cols text[] := coalesce(TG_ARGV, ARRAY[]::text[]);
BEGIN
  IF OLD.finalised_at IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finalised record in %.% cannot be deleted', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'HT002',
            HINT = 'Post a linked reversal or credit note instead (BIL-07).';
  END IF;

  IF (to_jsonb(NEW) - mutable_cols) IS DISTINCT FROM (to_jsonb(OLD) - mutable_cols) THEN
    RAISE EXCEPTION 'finalised record in %.% cannot be edited', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'HT002',
            HINT = 'Post a linked reversal or credit note instead (BIL-07).';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Immutable-column guard: freezes the named columns from the moment of insert.
--   CREATE TRIGGER x_immutable BEFORE UPDATE ON x
--     FOR EACH ROW EXECUTE FUNCTION app_immutable_columns('payload', 'external_ref');
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_immutable_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col text;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF old_row -> col IS DISTINCT FROM new_row -> col THEN
      RAISE EXCEPTION 'column %.%.% is immutable', TG_TABLE_SCHEMA, TG_TABLE_NAME, col
        USING ERRCODE = 'HT001';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- updated_at maintenance for mutable master data.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Property scope (CFG-04, SEC-06, AT-18).
-- The API connects as the non-superuser role `hotel_app`, which is subject to
-- row-level security. Each request transaction sets:
--   SET LOCAL app.all_properties = 'on'            -- group roles
--   SET LOCAL app.property_ids   = '{uuid,uuid}'    -- everyone else
-- A connection that sets neither sees no property-scoped rows (fail closed).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_property_visible(p_property_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.all_properties', true), '') = 'on'
      OR p_property_id = ANY (
           coalesce(nullif(current_setting('app.property_ids', true), ''), '{}')::uuid[]
         );
$$;
