import type { Pool } from "pg";

export type CompareLineInput = {
  sku: string;
  name: string;
  rfid_qty: number;
  ext_qty: number;
};

export async function createCompareRun(
  pool: Pool,
  locationId: string,
  lines: CompareLineInput[],
): Promise<{ runId: string }> {
  const run = await pool.query<{ id: string }>(
    `INSERT INTO compare_runs (location_id) VALUES ($1::uuid) RETURNING id`,
    [locationId],
  );
  const row = run.rows[0];
  if (!row) throw new Error("compare run insert failed");

  for (const line of lines) {
    await pool.query(
      `INSERT INTO compare_lines (compare_run_id, sku, name, rfid_qty, ext_qty)
       VALUES ($1::uuid, $2, $3, $4, $5)`,
      [row.id, line.sku, line.name, line.rfid_qty, line.ext_qty],
    );
  }

  await pool.query(`UPDATE compare_runs SET completed_at = now() WHERE id = $1::uuid`, [
    row.id,
  ]);

  return { runId: row.id };
}

export async function materializeExceptionsFromCompare(
  pool: Pool,
  tenantId: string,
  locationId: string,
  runId: string,
): Promise<number> {
  const lines = await pool.query<{
    sku: string;
    name: string;
    rfid_qty: number;
    ext_qty: number;
  }>(
    `SELECT sku, name, rfid_qty, ext_qty FROM compare_lines
     WHERE compare_run_id = $1::uuid`,
    [runId],
  );
  let n = 0;
  for (const r of lines.rows) {
    if (r.rfid_qty === r.ext_qty) continue;
    const detail = `${r.sku} · ${r.name}: RFID ${r.rfid_qty} vs Ext ${r.ext_qty}`;
    await pool.query(
      `INSERT INTO exceptions (tenant_id, location_id, type, severity, state, detail)
       VALUES ($1::uuid, $2::uuid, 'pos_mismatch', 'review', 'new', $3)`,
      [tenantId, locationId, detail],
    );
    n += 1;
  }
  return n;
}
