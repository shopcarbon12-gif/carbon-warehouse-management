-- Activity history reads audit_log newest-first per tenant. Reader zone moves
-- (rfid_zone_change) are ~99% of rows, so people's actions get their own
-- small partial index; the full index serves "Show reader movements".
-- Production got these with CREATE INDEX CONCURRENTLY on 2026-10-05; here
-- they are IF NOT EXISTS no-ops there and plain builds on a fresh database.
CREATE INDEX IF NOT EXISTS audit_log_tenant_created_people_idx
  ON audit_log (tenant_id, created_at DESC)
  WHERE action <> 'rfid_zone_change';

CREATE INDEX IF NOT EXISTS audit_log_tenant_created_idx
  ON audit_log (tenant_id, created_at DESC);
