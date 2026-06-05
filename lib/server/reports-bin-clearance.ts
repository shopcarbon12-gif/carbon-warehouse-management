import type { Pool } from "pg";
import { shortName } from "@/lib/format-name";

/**
 * Bin Clearance report — each "clean bin" action, aggregated from the
 * clean_bin ADJUSTMENT rows in inventory_audit_logs (one row per EPC). Groups
 * by bin + actor + minute so a single clear of N tags reads as one line.
 * Actor renders as "First L.".
 */
export type BinClearanceRow = {
  bin_code: string;
  epc_count: number;
  cleared_at: string;
  cleared_by: string;
};

export async function listBinClearances(
  pool: Pool,
  tenantId: string,
  opts: { search?: string; limit?: number } = {},
): Promise<BinClearanceRow[]> {
  const limit = Math.min(opts.limit ?? 300, 1000);
  const conds: string[] = [
    "al.tenant_id = $1::uuid",
    "al.reason = 'clean_bin'",
  ];
  const params: unknown[] = [tenantId];
  let p = 2;
  if (opts.search?.trim()) {
    conds.push(`al.old_value ILIKE $${p}`);
    params.push(`%${opts.search.trim()}%`);
    p++;
  }
  params.push(limit);

  const r = await pool.query<{
    bin_code: string;
    epc_count: string;
    cleared_at: Date;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  }>(
    `SELECT al.old_value AS bin_code,
            COUNT(*)::text AS epc_count,
            MAX(al.created_at) AS cleared_at,
            MAX(u.first_name) AS first_name,
            MAX(u.last_name) AS last_name,
            MAX(u.email) AS email
       FROM inventory_audit_logs al
       LEFT JOIN users u ON u.id = al.user_uuid
      WHERE ${conds.join(" AND ")}
      GROUP BY al.old_value, al.user_uuid, date_trunc('minute', al.created_at)
      ORDER BY MAX(al.created_at) DESC
      LIMIT $${p}`,
    params,
  );

  return r.rows.map((row) => ({
    bin_code: row.bin_code,
    epc_count: Number(row.epc_count),
    cleared_at: row.cleared_at.toISOString(),
    cleared_by: shortName(row.first_name, row.last_name, row.email),
  }));
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function binClearanceCsv(rows: BinClearanceRow[]): string {
  const header = "bin_code,epc_count,cleared_at,cleared_by";
  const lines = [header];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.bin_code),
        csvCell(r.epc_count),
        csvCell(r.cleared_at),
        csvCell(r.cleared_by),
      ].join(","),
    );
  }
  return lines.join("\n");
}
