import type { Sql } from "@/lib/db";

export type CompareLineInput = {
  sku: string;
  name: string;
  rfid_qty: number;
  ext_qty: number;
};

export async function createCompareRun(
  sql: Sql,
  locationId: string,
  lines: CompareLineInput[],
): Promise<{ runId: string }> {
  const [run] = await sql<{ id: string }[]>`
    INSERT INTO compare_runs (location_id) VALUES (${locationId}::uuid)
    RETURNING id
  `;
  if (!run) throw new Error("compare run insert failed");

  for (const line of lines) {
    await sql`
      INSERT INTO compare_lines (compare_run_id, sku, name, rfid_qty, ext_qty)
      VALUES (${run.id}::uuid, ${line.sku}, ${line.name}, ${line.rfid_qty}, ${line.ext_qty})
    `;
  }

  await sql`
    UPDATE compare_runs SET completed_at = now() WHERE id = ${run.id}::uuid
  `;

  return { runId: run.id };
}

export async function materializeExceptionsFromCompare(
  sql: Sql,
  tenantId: string,
  locationId: string,
  runId: string,
): Promise<number> {
  const lines = await sql<
    { sku: string; name: string; rfid_qty: number; ext_qty: number }[]
  >`
    SELECT sku, name, rfid_qty, ext_qty FROM compare_lines
    WHERE compare_run_id = ${runId}::uuid
  `;
  let n = 0;
  for (const row of lines) {
    if (row.rfid_qty === row.ext_qty) continue;
    await sql`
      INSERT INTO exceptions (tenant_id, location_id, type, severity, state, detail)
      VALUES (
        ${tenantId}::uuid,
        ${locationId}::uuid,
        'pos_mismatch',
        'review',
        'new',
        ${`${row.sku} · ${row.name}: RFID ${row.rfid_qty} vs Ext ${row.ext_qty}`}
      )
    `;
    n += 1;
  }
  return n;
}
