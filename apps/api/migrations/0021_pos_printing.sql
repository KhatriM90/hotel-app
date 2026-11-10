-- Network printing for kitchen/bar tickets and guest bills (INT-04), from the
-- Kahama service-team meeting of 9 Nov 2026 (item 2.4: tickets fail to print
-- and nobody knows). All three properties use Epson receipt printers.
--
-- The cloud cannot reach printers on the hotel network, so each property runs
-- the YeaStay POS bridge on a PC there. Like the door-lock bridge it only makes
-- outbound HTTPS calls: it claims print jobs, sends them to the printer and
-- reports printed or failed. Every job has a status, so a ticket that did not
-- print is shown to the waiter and the station instead of silently lost.

-- ---------------------------------------------------------------------------
-- Printers
-- ---------------------------------------------------------------------------
CREATE TABLE pos_printers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id        uuid NOT NULL REFERENCES properties (id),
  code               text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,16}$'),
  name               text NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  -- network: Epson on the LAN, raw ESC/POS on TCP (port 9100).
  -- windows: a printer installed on the bridge PC (USB), sent raw through the Windows spooler.
  connection         text NOT NULL CHECK (connection IN ('network', 'windows')),
  host               text CHECK (host IS NULL OR host ~ '^[A-Za-z0-9.-]{1,253}$'),
  port               integer NOT NULL DEFAULT 9100 CHECK (port BETWEEN 1 AND 65535),
  windows_name       text CHECK (windows_name IS NULL OR length(windows_name) BETWEEN 1 AND 200),
  -- 80 mm paper prints 48 characters a line, 58 mm prints 32.
  paper_mm           integer NOT NULL DEFAULT 80 CHECK (paper_mm IN (58, 80)),
  -- Where a job goes when this printer keeps failing.
  backup_printer_id  uuid,
  is_active          boolean NOT NULL DEFAULT true,
  updated_by         uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  UNIQUE (id, property_id),
  FOREIGN KEY (backup_printer_id, property_id) REFERENCES pos_printers (id, property_id),
  CHECK (backup_printer_id IS DISTINCT FROM id),
  CHECK ((connection = 'network' AND host IS NOT NULL) OR (connection = 'windows' AND windows_name IS NOT NULL))
);
CREATE TRIGGER pos_printers_touch BEFORE UPDATE ON pos_printers
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER pos_printers_no_delete BEFORE DELETE ON pos_printers
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- Kitchen and bar tickets print on their station's printer.
ALTER TABLE pos_stations ADD COLUMN printer_id uuid;
ALTER TABLE pos_stations ADD FOREIGN KEY (printer_id, property_id) REFERENCES pos_printers (id, property_id);
-- Guest bills and receipts print on the outlet's receipt printer when it has one;
-- otherwise the tablet prints them through its browser as before.
ALTER TABLE outlets ADD COLUMN receipt_printer_id uuid;
ALTER TABLE outlets ADD FOREIGN KEY (receipt_printer_id, property_id) REFERENCES pos_printers (id, property_id);

-- ---------------------------------------------------------------------------
-- The POS bridge at each property (one per property; pairing again replaces it)
-- ---------------------------------------------------------------------------
CREATE TABLE pos_bridges (
  property_id     uuid PRIMARY KEY REFERENCES properties (id),
  -- SHA-256 of a random 256-bit token; the token is shown once at pairing.
  token_hash      text UNIQUE,
  paired_at       timestamptz,
  paired_by       uuid REFERENCES users (id),
  last_seen_at    timestamptz,
  bridge_id       text,
  version         text,
  mode            text CHECK (mode IS NULL OR mode IN ('live', 'mock')),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pos_bridges (property_id) SELECT id FROM properties;
CREATE TRIGGER pos_bridges_touch BEFORE UPDATE ON pos_bridges
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER pos_bridges_no_delete BEFORE DELETE ON pos_bridges
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Print jobs
-- ---------------------------------------------------------------------------
CREATE TABLE print_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL,
  printer_id       uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('ticket', 'bill', 'receipt', 'test')),
  ticket_id        uuid,
  check_id         uuid,
  outlet_id        uuid,
  -- What staff see: "Ticket K1-TKT-000123 · Table T4", "Bill K1-CHK-000045".
  title            text NOT NULL,
  -- The ESC/POS bytes, base64. Rendered by YeaStay so the bridge only passes them on.
  payload          text NOT NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'printing', 'printed', 'failed', 'cancelled')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  claimed_by       text,
  claim_expires_at timestamptz,
  last_error       text,
  printed_at       timestamptz,
  failed_at        timestamptz,
  -- A failed job moved to the printer's backup, or retried by staff, points at the new job.
  replaced_by      uuid REFERENCES print_jobs (id),
  -- Staff saw the failure alert and dealt with it.
  acknowledged_at  timestamptz,
  acknowledged_by  uuid REFERENCES users (id),
  requested_by     uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, property_id),
  FOREIGN KEY (printer_id, property_id) REFERENCES pos_printers (id, property_id),
  FOREIGN KEY (ticket_id, property_id) REFERENCES pos_tickets (id, property_id),
  FOREIGN KEY (check_id, property_id) REFERENCES pos_checks (id, property_id),
  CHECK (status <> 'printed' OR printed_at IS NOT NULL),
  CHECK (status <> 'failed' OR (failed_at IS NOT NULL AND last_error IS NOT NULL))
);
CREATE INDEX print_jobs_queue ON print_jobs (property_id, next_attempt_at) WHERE status = 'queued';
CREATE INDEX print_jobs_failed ON print_jobs (property_id, failed_at) WHERE status = 'failed' AND acknowledged_at IS NULL;
CREATE INDEX print_jobs_ticket ON print_jobs (ticket_id);
CREATE INDEX print_jobs_check ON print_jobs (check_id);
CREATE TRIGGER print_jobs_touch BEFORE UPDATE ON print_jobs
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER print_jobs_no_delete BEFORE DELETE ON print_jobs
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_printers', 'pos_bridges', 'print_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_property_visible(property_id)) WITH CHECK (app_property_visible(property_id))',
                   t || '_scope', t);
  END LOOP;
END;
$$;
GRANT SELECT, INSERT, UPDATE ON pos_printers, pos_bridges, print_jobs TO hotel_app;
