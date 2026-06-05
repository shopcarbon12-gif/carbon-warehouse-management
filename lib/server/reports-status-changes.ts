import type { Pool } from "pg";
import { shortName } from "@/lib/format-name";

/**
 * Status Change report (drives the mobile Status Change + Damages tiles and the
 * WMS-web Reports → Tags & Labels area). Reads the existing STATUS_CHANGE rows
 * the bulk-status endpoint already writes to `inventory_audit_logs` — no new
 * table or write-path needed. The actor renders as "First L." per the locked
 * rule (never the raw email).
 */
export type StatusChangeRow = {
  id: string;
  epc: string;
  old_status: string | null;
  new_status: string;
  reason: string | null;
  changed_at: string;
  changed_by: string; // "First L."
};

export async function listStatusChanges(
  pool: Pool,
  tenantId: string,
  opts: { damagedOnly?: boolean; search?: string; limit?: number } = {},
): Promise<StatusChangeRow[]> {
  const limit = Math.min(opts.limit ?? 300, 1000);
  const conds: string[] = [
    "al.tenant_id = $1::uuid",
    "al.log_type = 'STATUS_CHANGE'",
  ];
  const params: unknown[] = [tenantId];
  let p = 2;
  if (opts.damagedOnly) {
    conds.push("al.new_value = 'damaged'");
  }
  if (opts.search?.trim()) {
    conds.push(`al.entity_reference ILIKE $${p}`);
    params.push(`%${opts.search.trim()}%`);
    p++;
  }
  params.push(limit);

  const r = await pool.query<{
    id: string;
    epc: string;
    old_value: string | null;
    new_value: string | null;
    reason: string | null;
    created_at: Date;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  }>(
    `SELECT al.id::text,
            al.entity_reference AS epc,
            al.old_value,
            al.new_value,
            al.reason,
            al.created_at,
            u.first_name, u.last_name, u.email
       FROM inventory_audit_logs al
       LEFT JOIN users u ON u.id = al.user_uuid
      WHERE ${conds.join(" AND ")}
      ORDER BY al.created_at DESC
      LIMIT $${p}`,
    params,
  );

  return r.rows.map((row) => ({
    id: row.id,
    epc: row.epc,
    old_status: row.old_value,
    new_status: row.new_value ?? "",
    reason: row.reason,
    changed_at: row.created_at.toISOString(),
    changed_by: shortName(row.first_name, row.last_name, row.email),
  }));
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function statusChangesCsv(rows: StatusChangeRow[]): string {
  const header = "epc,old_status,new_status,reason,changed_at,changed_by";
  const lines = [header];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.epc),
        csvCell(r.old_status ?? ""),
        csvCell(r.new_status),
        csvCell(r.reason ?? ""),
        csvCell(r.changed_at),
        csvCell(r.changed_by),
      ].join(","),
    );
  }
  return lines.join("\n");
}
