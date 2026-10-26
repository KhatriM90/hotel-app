-- 0009 SAP warehouses (SAP-14), from the client's SAP B1 list, 26 Oct 2026.
-- SAP warehouse codes are numeric (1-52), not the {P}-XXX pattern the brief
-- suggested, so outlets now reference this table instead of a naming rule.

CREATE TABLE warehouses (
  sap_code    text PRIMARY KEY CHECK (sap_code ~ '^[A-Za-z0-9-]{1,8}$'),
  name        text NOT NULL,                       -- verbatim SAP name
  property_id uuid NOT NULL REFERENCES properties (id),
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (sap_code, property_id)
);

ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouses_scope ON warehouses
  USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id));
GRANT SELECT ON warehouses TO hotel_app;

-- SWCC_STEVES'S POOL BAR (44) is listed under branch PSH in the source sheet;
-- its name and outlet are Small World, so it is loaded under SW.
INSERT INTO warehouses (sap_code, name, property_id)
SELECT v.code, v.name, p.id
  FROM (VALUES
    ('K1', '30', 'PSH_ACCOMODATION'), ('K1', '8', 'PSH_COCKTAIL BAR'), ('K1', '13', 'PSH_COWGIRL BAR'),
    ('K1', '47', 'PSH_DRUNCH'), ('K1', '45', 'PSH_EXPIRED'), ('K1', '10', 'PSH_FARM'),
    ('K1', '39', 'PSH_FRESH JUICES'), ('K1', '31', 'PSH_GAMES'), ('K1', '40', 'PSH_HEAVEN BAR'),
    ('K1', '14', 'PSH_HOUSE KEEPING'), ('K1', '9', 'PSH_KARWASH'), ('K1', '5', 'PSH_KLUB KOFFEE'),
    ('K1', '6', 'PSH_MAIN KITCHEN'), ('K1', '1', 'PSH_MAIN STORE'), ('K1', '3', 'PSH_PITCHER & BUTCH BAR'),
    ('K1', '11', 'PSH_RECEPTION SHOP'), ('K1', '4', 'PSH_SHED BAR'), ('K1', '12', 'PSH_SHISHA BAR'),
    ('K1', '35', 'PSH_SOCCER CITY'), ('K1', '2', 'PSH_SPICE BAR'), ('K1', '7', 'PSH_STAFF KITCHEN'),
    ('K1', '46', 'PSH_TANQUERY BAR'), ('K1', '49', 'PSH_WASTE/UNUSED PRODUCTS'),
    ('SW', '38', 'SWCC_ACCOMODATION'), ('SW', '52', 'SWCC_BUFFET'), ('SW', '50', 'SWCC_EXPIRED'),
    ('SW', '37', 'SWCC_FARM'), ('SW', '28', 'SWCC_HOUSE KEEPING'), ('SW', '51', 'SWCC_KLUBCOFFEE'),
    ('SW', '27', 'SWCC_MAIN BAR'), ('SW', '29', 'SWCC_MAIN KITCHEN'), ('SW', '25', 'SWCC_MAIN STORE'),
    ('SW', '26', 'SWCC_RECEPTION SHOP'), ('SW', '41', 'SWCC_STAFF KITCHEN'), ('SW', '43', 'SWCC_STEVE''S COCKTAIL BAR'),
    ('SW', '44', 'SWCC_STEVES''S POOL BAR'), ('SW', '42', 'SWCC_SWIMMING'),
    ('KM', '32', 'KHM_ACCOMODATION'), ('KM', '34', 'KHM_BREAKFAST'), ('KM', '20', 'KHM_COCKTAIL BAR'),
    ('KM', '21', 'KHM_COWGIRL BAR'), ('KM', '48', 'KHM_EXPIRED'), ('KM', '33', 'KHM_GAMES'),
    ('KM', '24', 'KHM_HOUSE KEEPING'), ('KM', '18', 'KHM_KARWASH'), ('KM', '17', 'KHM_MAIN KITCHEN'),
    ('KM', '15', 'KHM_MAINSTORE'), ('KM', '16', 'KHM_PITCHER & BUTCH'), ('KM', '23', 'KHM_RECEPTION SHOP'),
    ('KM', '22', 'KHM_SHISHA BAR'), ('KM', '19', 'KHM_STAFF KITCHEN')
  ) AS v(prop, code, name)
  JOIN properties p ON p.code = v.prop;

-- Outlets issue from a warehouse of their own property (SAP-14).
ALTER TABLE outlets DROP CONSTRAINT outlets_issuing_warehouse_code_check;
UPDATE outlets SET issuing_warehouse_code = NULL WHERE issuing_warehouse_code IS NOT NULL
  AND issuing_warehouse_code NOT IN (SELECT sap_code FROM warehouses);
ALTER TABLE outlets ADD CONSTRAINT outlets_issuing_warehouse_fk
  FOREIGN KEY (issuing_warehouse_code, property_id) REFERENCES warehouses (sap_code, property_id);

-- Outlets with no warehouse of their own (no stock or still TBC) stay NULL:
-- K1 Flavour Bar, Guinness Bar, Laundry, Other Sales, Rental;
-- SW Complimentary, Massage; KM Laundry, Swimming Pool.
UPDATE outlets o SET issuing_warehouse_code = v.wh
  FROM (VALUES
    ('K1-ROOMS', '30'), ('K1-COCKTAIL', '8'), ('K1-COWGIRL', '13'), ('K1-GAMES', '31'), ('K1-HEAVEN', '40'),
    ('K1-HK', '14'), ('K1-KARWASH', '9'), ('K1-KOFFEE', '5'), ('K1-KITCHEN', '6'), ('K1-SHOP', '11'),
    ('K1-SHED', '4'), ('K1-SOCCER', '35'), ('K1-SPICE', '2'), ('K1-TANQUERAY', '46'),
    ('SW-ROOMS', '38'), ('SW-HK', '28'), ('SW-MAINBAR', '27'), ('SW-KITCHEN', '29'), ('SW-STORE', '25'),
    ('SW-SHOP', '26'), ('SW-STEVES-CB', '43'), ('SW-STEVES-PB', '44'), ('SW-SWIM', '42'),
    ('KM-ROOMS', '32'), ('KM-COCKTAIL', '20'), ('KM-COWGIRL', '21'), ('KM-GAMES', '33'), ('KM-HK', '24'),
    ('KM-KARWASH', '18'), ('KM-KITCHEN', '17'), ('KM-PITCHER', '16'), ('KM-SHOP', '23'), ('KM-SHISHA', '22'),
    ('KM-STAFFKIT', '19')
  ) AS v(code, wh)
 WHERE o.code = v.code;
