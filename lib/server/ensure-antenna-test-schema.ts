/**
 * Defensive schema bootstrap for the antenna-test columns. Migrations 033 / 035
 * are supposed to add these but the docker-migrate.mjs has been failing
 * partway on prod, leaving production stuck. Endpoints that touch
 * `devices.test_pending_at` (and friends) call this once on entry to make
 * sure the columns exist — `IF NOT EXISTS` so it's a no-op when the migration
 * actually applied. The result is cached in module state so we don't pay for
 * the round-trip on every request.
 */
import type { Pool } from "pg";

let ensured = false;

export async function ensureAntennaTestSchema(pool: Pool): Promise<void> {
  if (ensured) return;
  try {
    await pool.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS test_pending_at TIMESTAMPTZ`,
    );
    await pool.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_test_at TIMESTAMPTZ`,
    );
    await pool.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_test_passed BOOLEAN`,
    );
    await pool.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_test_epc_count INT`,
    );
    // POS reader recovery indicator (2026-05-30). Set by the agent heartbeat;
    // read by the Carbon-POS sell screen "Reader recovering…" badge.
    await pool.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS recovery_state TEXT`,
    );
    await pool.query(
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS recovering_since TIMESTAMPTZ`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS devices_test_pending_idx
         ON devices (test_pending_at)
         WHERE test_pending_at IS NOT NULL`,
    );
    ensured = true;
  } catch (e) {
    // Don't poison the cache on a transient failure — try again next call.
    console.error("[ensure antenna-test schema]", e instanceof Error ? e.message : e);
  }
}
