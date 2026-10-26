-- 0007 Client master data supplied by Manish Khatri on 26 Oct 2026:
-- KRA PIN, SAP branch IDs (BPLId), active SAP tax codes and the SAP outlet list.

-- One legal entity, one KRA PIN. Legal name still TBC.
UPDATE legal_entity SET kra_pin = 'P000598390N' WHERE id = 1;

-- SAP multi-branch IDs (SAP-13).
UPDATE properties SET sap_branch_id = 1 WHERE code = 'K1';
UPDATE properties SET sap_branch_id = 4 WHERE code = 'SW';
UPDATE properties SET sap_branch_id = 3 WHERE code = 'KM';

-- The client reports no separate eTIMS branch IDs, only the KRA PIN.
-- etims_branch_id stays NULL until the eTIMS branch question is settled (INT-02).

-- ---------------------------------------------------------------------------
-- SAP tax groups (OVTG), active codes only. Mirrors SAP; SAP stays the owner
-- of rates and GL accounts (SAP-02). rate_percent is a percentage (16 = 16%).
-- ---------------------------------------------------------------------------
CREATE TABLE tax_codes (
  sap_code       text PRIMARY KEY CHECK (sap_code ~ '^[A-Z0-9]{1,8}$'),
  name           text NOT NULL,
  category       text NOT NULL CHECK (category IN ('input', 'output')),
  rate_percent   rate NOT NULL,
  effective_from date NOT NULL,
  gl_account     text,
  is_active      boolean NOT NULL DEFAULT true,
  synced_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tax_codes (sap_code, name, category, rate_percent, effective_from, gl_account) VALUES
  ('I1', 'Input VAT 16.00%',  'input',  16, '2000-01-01', '20101401'),
  ('I2', 'Input VAT 0.00%',   'input',   0, '2004-01-01', '20101402'),
  ('I4', 'Input VAT 8.00%',   'input',   8, '2000-01-01', '20101401'),
  ('X1', 'Exempt Input',      'input',   0, '2000-01-01', '20101403'),
  ('C1', 'Catering Levy 2%',  'output',  2, '2004-01-01', '20101404'),
  ('O1', 'Output VAT 16.00%', 'output', 16, '2000-01-01', '20101401'),
  ('O2', 'Output VAT 0.00%',  'output',  0, '2004-01-01', '20101402'),
  ('O4', 'Output VAT 14.00%', 'output', 14, '2000-01-01', '20101401'),
  ('X0', 'Exempt Output',     'output',  0, '2000-01-01', '20101403');

GRANT SELECT ON tax_codes TO hotel_app;

-- ---------------------------------------------------------------------------
-- Outlets as named in SAP. sap_outlet_name is kept verbatim (including SAP's
-- spellings) because the integration must match it exactly. The app code
-- carries the property prefix (CFG-04).
-- ---------------------------------------------------------------------------
ALTER TABLE outlets ADD COLUMN sap_outlet_name text;
CREATE UNIQUE INDEX outlets_sap_outlet_name_uq ON outlets (sap_outlet_name) WHERE sap_outlet_name IS NOT NULL;

INSERT INTO outlets (property_id, code, name, type, revenue_centre, sells_alcohol, sap_outlet_name)
SELECT p.id, v.code, v.name, v.type::outlet_type, v.rc::revenue_centre, v.alcohol, v.sap
  FROM (VALUES
    -- K1 Klubhouse, Parklands (SAP prefix PSH_)
    ('K1', 'K1-ROOMS',    'Accommodation',        'accommodation', 'ROOMS', false, 'PSH_ACCOMODATION'),
    ('K1', 'K1-COCKTAIL', 'Cocktail Bar',         'bar',           'BAR',   true,  'PSH_COCKTAIL BAR'),
    ('K1', 'K1-COWGIRL',  'Cowgirl Bar',          'bar',           'BAR',   true,  'PSH_COWGIRL BAR'),
    ('K1', 'K1-FLAVOUR',  'Flavour Bar',          'bar',           'BAR',   true,  'PSH_FLAVOUR BAR'),
    ('K1', 'K1-GAMES',    'Games',                'leisure',       'LEIS',  false, 'PSH_GAMES'),
    ('K1', 'K1-GUINNESS', 'Guinness Bar',         'bar',           'BAR',   true,  'PSH_GUINESS BAR'),
    ('K1', 'K1-HEAVEN',   'Heaven Bar',           'bar',           'BAR',   true,  'PSH_HEAVEN BAR'),
    ('K1', 'K1-HK',       'Housekeeping',         'housekeeping',  'OTHER', false, 'PSH_HOUSE KEEPING'),
    ('K1', 'K1-KARWASH',  'Karwash',              'other',         'OTHER', false, 'PSH_KARWASH'),
    ('K1', 'K1-KOFFEE',   'Klub Koffee',          'restaurant',    'REST',  false, 'PSH_KLUB KOFFEE'),
    ('K1', 'K1-LAUNDRY',  'Laundry',              'laundry',       'OTHER', false, 'PSH_LAUNDRY'),
    ('K1', 'K1-KITCHEN',  'Main Kitchen',         'kitchen',       'REST',  false, 'PSH_MAIN KITCHEN'),
    ('K1', 'K1-OTHER',    'Other Sales',          'other',         'OTHER', false, 'PSH_OTHER SALES'),
    ('K1', 'K1-SHOP',     'Reception Shop',       'shop',          'OTHER', false, 'PSH_RECEPTION SHOP'),
    ('K1', 'K1-RENTAL',   'Rental',               'other',         'OTHER', false, 'PSH_RENTAL'),
    ('K1', 'K1-SHED',     'Shed Bar',             'bar',           'BAR',   true,  'PSH_SHED BAR'),
    ('K1', 'K1-SOCCER',   'Soccer City',          'leisure',       'LEIS',  false, 'PSH_SOCCER CITY'),
    ('K1', 'K1-SPICE',    'Spice Bar',            'bar',           'BAR',   true,  'PSH_SPICE BAR'),
    ('K1', 'K1-TANQUERAY','Tanqueray Bar',        'bar',           'BAR',   true,  'PSH_TANQUERY BAR'),
    -- Small World Country Club, Lukenya (SAP prefix SWCC_)
    ('SW', 'SW-COMP',     'Complimentary',        'other',         'OTHER', false, 'SWCC Complimentray'),
    ('SW', 'SW-ROOMS',    'Accommodation',        'accommodation', 'ROOMS', false, 'SWCC_ACCOMODATION'),
    ('SW', 'SW-HK',       'Housekeeping',         'housekeeping',  'OTHER', false, 'SWCC_HOUSE KEEPING'),
    ('SW', 'SW-MAINBAR',  'Main Bar',             'bar',           'BAR',   true,  'SWCC_MAIN BAR'),
    ('SW', 'SW-KITCHEN',  'Main Kitchen',         'kitchen',       'REST',  false, 'SWCC_MAIN KITCHEN'),
    ('SW', 'SW-STORE',    'Main Store',           'store',         'OTHER', false, 'SWCC_MAIN STORE'),
    ('SW', 'SW-MASSAGE',  'Massage',              'spa',           'LEIS',  false, 'SWCC_MASSAGE'),
    ('SW', 'SW-SHOP',     'Reception Shop',       'shop',          'OTHER', false, 'SWCC_RECEPTION SHOP'),
    ('SW', 'SW-STEVES-CB','Steve''s Cocktail Bar','bar',           'BAR',   true,  'SWCC_STEVE''S COCKTAIL BAR'),
    ('SW', 'SW-STEVES-PB','Steve''s Pool Bar',    'bar',           'BAR',   true,  'SWCC_STEVES''S POOL BAR'),
    ('SW', 'SW-SWIM',     'Swimming',             'leisure',       'LEIS',  false, 'SWCC_SWIMMING'),
    -- Kahama Mombasa (SAP prefix KHM_)
    ('KM', 'KM-ROOMS',    'Accommodation',        'accommodation', 'ROOMS', false, 'KHM_ACCOMMODATION'),
    ('KM', 'KM-COCKTAIL', 'Cocktail Bar',         'bar',           'BAR',   true,  'KHM_COCKTAIL BAR'),
    ('KM', 'KM-COWGIRL',  'Cowgirl Bar',          'bar',           'BAR',   true,  'KHM_COWGIRL BAR'),
    ('KM', 'KM-GAMES',    'Games',                'leisure',       'LEIS',  false, 'KHM_GAMES'),
    ('KM', 'KM-HK',       'Housekeeping',         'housekeeping',  'OTHER', false, 'KHM_HOUSE KEEPING'),
    ('KM', 'KM-KARWASH',  'Karwash',              'other',         'OTHER', false, 'KHM_KARWASH'),
    ('KM', 'KM-LAUNDRY',  'Laundry',              'laundry',       'OTHER', false, 'KHM_LAUNDRY'),
    ('KM', 'KM-KITCHEN',  'Main Kitchen',         'kitchen',       'REST',  false, 'KHM_MAIN KITCHEN'),
    ('KM', 'KM-PITCHER',  'Pitcher & Butch',      'restaurant',    'REST',  true,  'KHM_PITCHER & BUTCH'),
    ('KM', 'KM-SHOP',     'Reception Shop',       'shop',          'OTHER', false, 'KHM_RECEPTION SHOP'),
    ('KM', 'KM-SHISHA',   'Shisha Bar',           'bar',           'BAR',   true,  'KHM_SHISHA BAR'),
    ('KM', 'KM-STAFFKIT', 'Staff Kitchen',        'kitchen',       'REST',  false, 'KHM_STAFF KITCHEN'),
    ('KM', 'KM-POOL',     'Swimming Pool',        'leisure',       'LEIS',  false, 'KHM_SWIMMING POOL')
  ) AS v(prop, code, name, type, rc, alcohol, sap)
  JOIN properties p ON p.code = v.prop
ON CONFLICT (property_id, code) DO NOTHING;
