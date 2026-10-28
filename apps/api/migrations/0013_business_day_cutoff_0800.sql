-- The client's trading day runs 08:00 to 08:00 the next morning (Manish Khatri,
-- 28 Oct 2026). Sales between midnight and 08:00 belong to the previous
-- business date. Applies to all three properties; POS day close (and later the
-- night audit, BIL-10) read this cut-off. New properties default to it too.
ALTER TABLE properties ALTER COLUMN business_day_cutoff SET DEFAULT '08:00';
UPDATE properties SET business_day_cutoff = '08:00';
