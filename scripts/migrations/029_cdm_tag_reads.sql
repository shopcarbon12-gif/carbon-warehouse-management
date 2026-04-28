-- v3.1: Carbon CDM tag-read ingest table.
-- Persists every EPC the Carbon CDM agent forwards from a fixed RFID reader.
-- Wider analytics tables (inventory, transfers) read FROM this stream.

CREATE TABLE IF NOT EXISTS cdm_reads (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  cdm_agent_id uuid NOT NULL REFERENCES cdm_agents (id) ON DELETE CASCADE,
  reader_id uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  antenna_id uuid REFERENCES devices (id) ON DELETE SET NULL,
  epc_hex varchar(48) NOT NULL,
  rssi smallint,
  read_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cdm_reads_tenant_read_at ON cdm_reads (tenant_id, read_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cdm_reads_reader_read_at ON cdm_reads (reader_id, read_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cdm_reads_epc_read_at ON cdm_reads (epc_hex, read_at DESC);
