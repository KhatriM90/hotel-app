-- 0008 Answers from Manish Khatri, 26 Oct 2026:
--  * eTIMS: the group has ONE eTIMS registration under KRA PIN P000598390N, not
--    one branch per property. Fiscal invoice numbers therefore come from one
--    group-wide sequence shared by all three properties (INT-02, SAP-12).
--    Property document numbers (K1-INV-…) stay per property (CFG-04); the
--    fiscal number is a separate reference on the fiscal record.
--  * SAP outlet codes: short codes (max 8 characters, the SAP dimension code
--    limit) for Dimension 2 (SAP-15).

-- ---------------------------------------------------------------------------
-- eTIMS registration (one per legal entity)
-- ---------------------------------------------------------------------------
-- bhfId '00' is KRA's head-office branch ID; confirm against the OSCU/VSCU
-- device registration before the first sandbox submission.
ALTER TABLE legal_entity ADD COLUMN etims_branch_id text NOT NULL DEFAULT '00'
  CHECK (etims_branch_id ~ '^[0-9]{2}$');

-- Per-property eTIMS branch IDs are not used.
DROP INDEX properties_etims_branch_uq;
ALTER TABLE properties DROP COLUMN etims_branch_id;

-- One counter for the whole group. Row lock, not a SEQUENCE: gapless, and a
-- rolled-back submission does not consume a number.
CREATE TABLE fiscal_sequences (
  etims_branch_id text PRIMARY KEY,
  next_value      bigint NOT NULL DEFAULT 1 CHECK (next_value >= 1)
);
INSERT INTO fiscal_sequences (etims_branch_id) SELECT etims_branch_id FROM legal_entity;

-- Every fiscal number issued, with the property that used it. Append-only.
CREATE TABLE fiscal_number_allocations (
  etims_branch_id text NOT NULL,
  invoice_no      bigint NOT NULL,
  property_id     uuid NOT NULL REFERENCES properties (id),
  allocated_by    uuid REFERENCES users (id),
  allocated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (etims_branch_id, invoice_no)
);
CREATE TRIGGER fiscal_number_allocations_append_only BEFORE UPDATE OR DELETE ON fiscal_number_allocations
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
CREATE TRIGGER fiscal_number_allocations_no_truncate BEFORE TRUNCATE ON fiscal_number_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION app_forbid_mutation();
ALTER TABLE fiscal_number_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_number_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_number_allocations_scope ON fiscal_number_allocations
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));

-- Allocates the next group-wide eTIMS invoice number for a sale at a property.
-- Call inside the transaction that creates the fiscal submission record.
CREATE FUNCTION next_fiscal_invoice_number(p_property_id uuid, p_actor uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_branch text;
  v_no     bigint;
BEGIN
  IF NOT app_property_visible(p_property_id) THEN
    RAISE EXCEPTION 'property % not in scope', p_property_id USING ERRCODE = 'HT003';
  END IF;
  SELECT etims_branch_id INTO STRICT v_branch FROM legal_entity WHERE id = 1;

  UPDATE fiscal_sequences SET next_value = next_value + 1
   WHERE etims_branch_id = v_branch
  RETURNING next_value - 1 INTO v_no;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no fiscal sequence for eTIMS branch %', v_branch USING ERRCODE = 'HT003';
  END IF;

  INSERT INTO fiscal_number_allocations (etims_branch_id, invoice_no, property_id, allocated_by)
  VALUES (v_branch, v_no, p_property_id, p_actor);
  RETURN v_no;
END;
$$;

GRANT SELECT, UPDATE ON fiscal_sequences TO hotel_app;
GRANT SELECT, INSERT ON fiscal_number_allocations TO hotel_app;
GRANT EXECUTE ON FUNCTION next_fiscal_invoice_number(uuid, uuid) TO hotel_app;

-- ---------------------------------------------------------------------------
-- SAP Dimension 2 codes per outlet (SAP-15). Proposed short codes; create
-- them in SAP with the same values.
-- ---------------------------------------------------------------------------
ALTER TABLE outlets ADD COLUMN sap_dimension2_code text CHECK (sap_dimension2_code ~ '^[A-Z0-9]{2,8}$');
CREATE UNIQUE INDEX outlets_sap_dimension2_uq ON outlets (sap_dimension2_code) WHERE sap_dimension2_code IS NOT NULL;

UPDATE outlets o SET sap_dimension2_code = v.dim2
  FROM (VALUES
    ('PSH_ACCOMODATION', 'K1ROOMS'),   ('PSH_COCKTAIL BAR', 'K1COCKTL'), ('PSH_COWGIRL BAR', 'K1COWGRL'),
    ('PSH_FLAVOUR BAR', 'K1FLAVR'),    ('PSH_GAMES', 'K1GAMES'),         ('PSH_GUINESS BAR', 'K1GUINS'),
    ('PSH_HEAVEN BAR', 'K1HEAVN'),     ('PSH_HOUSE KEEPING', 'K1HSKP'),  ('PSH_KARWASH', 'K1KRWSH'),
    ('PSH_KLUB KOFFEE', 'K1KOFFE'),    ('PSH_LAUNDRY', 'K1LNDRY'),       ('PSH_MAIN KITCHEN', 'K1KITCH'),
    ('PSH_OTHER SALES', 'K1OTHER'),    ('PSH_RECEPTION SHOP', 'K1SHOP'), ('PSH_RENTAL', 'K1RENTL'),
    ('PSH_SHED BAR', 'K1SHED'),        ('PSH_SOCCER CITY', 'K1SOCCR'),   ('PSH_SPICE BAR', 'K1SPICE'),
    ('PSH_TANQUERY BAR', 'K1TANQ'),
    ('SWCC Complimentray', 'SWCOMP'),  ('SWCC_ACCOMODATION', 'SWROOMS'), ('SWCC_HOUSE KEEPING', 'SWHSKP'),
    ('SWCC_MAIN BAR', 'SWMBAR'),       ('SWCC_MAIN KITCHEN', 'SWKITCH'), ('SWCC_MAIN STORE', 'SWSTORE'),
    ('SWCC_MASSAGE', 'SWMASSG'),       ('SWCC_RECEPTION SHOP', 'SWSHOP'),('SWCC_STEVE''S COCKTAIL BAR', 'SWSTVCB'),
    ('SWCC_STEVES''S POOL BAR', 'SWSTVPB'), ('SWCC_SWIMMING', 'SWSWIM'),
    ('KHM_ACCOMMODATION', 'KMROOMS'),  ('KHM_COCKTAIL BAR', 'KMCOCKTL'), ('KHM_COWGIRL BAR', 'KMCOWGRL'),
    ('KHM_GAMES', 'KMGAMES'),          ('KHM_HOUSE KEEPING', 'KMHSKP'),  ('KHM_KARWASH', 'KMKRWSH'),
    ('KHM_LAUNDRY', 'KMLNDRY'),        ('KHM_MAIN KITCHEN', 'KMKITCH'),  ('KHM_PITCHER & BUTCH', 'KMPITCH'),
    ('KHM_RECEPTION SHOP', 'KMSHOP'),  ('KHM_SHISHA BAR', 'KMSHSHA'),    ('KHM_STAFF KITCHEN', 'KMSTFKIT'),
    ('KHM_SWIMMING POOL', 'KMPOOL')
  ) AS v(sap, dim2)
 WHERE o.sap_outlet_name = v.sap;
