-- 0006 Outlet types seen in the client's SAP outlet list (26 Oct 2026):
-- accommodation, kitchens, housekeeping, laundry, reception shops, massage.
-- Separate migration because new enum values cannot be used in the
-- transaction that adds them.
ALTER TYPE outlet_type ADD VALUE IF NOT EXISTS 'accommodation';
ALTER TYPE outlet_type ADD VALUE IF NOT EXISTS 'kitchen';
ALTER TYPE outlet_type ADD VALUE IF NOT EXISTS 'housekeeping';
ALTER TYPE outlet_type ADD VALUE IF NOT EXISTS 'laundry';
ALTER TYPE outlet_type ADD VALUE IF NOT EXISTS 'shop';
ALTER TYPE outlet_type ADD VALUE IF NOT EXISTS 'spa';
