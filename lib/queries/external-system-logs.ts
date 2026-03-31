import type { Pool } from "pg";

export async function insertExternalSystemLog(
  pool: Pool,
  tenantId: string,
  row: {
    system_name: string;
    direction: "INBOUND" | "OUTBOUND";
    payload_summary: string;
    status: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO external_system_logs (tenant_id, system_name, direction, payload_summary, status)
     VALUES ($1::uuid, $2, $3, $4, $5)`,
    [
      tenantId,
      row.system_name.slice(0, 128),
      row.direction,
      row.payload_summary.slice(0, 8000),
      row.status.slice(0, 64),
    ],
  );
}
