import type { Pool } from "pg";
import { shortName } from "@/lib/format-name";

export type LabelPrintRow = {
  epc: string | null;
  sku: string | null;
  item_name: string | null;
  qty: number;
  template: string | null;
  printer: string | null;
  printed_at: string;
  printed_by: string;
};

export async function listLabelPrints(
  pool: Pool,
  tenantId: string,
  opts: { kind: "rfid" | "non_rfid"; search?: string; limit?: number },
): Promise<LabelPrintRow[]> {
  const limit = Math.min(opts.limit ?? 300, 2000);
  const conds = ["pe.tenant_id = $1::uuid", "pe.kind = $2"];
  const params: unknown[] = [tenantId, opts.kind];
  let p = 3;
  if (opts.search?.trim()) {
    conds.push(`(pe.epc ILIKE $${p} OR pe.sku ILIKE $${p})`);
    params.push(`%${opts.search.trim()}%`);
    p++;
  }
  params.push(limit);
  const r = await pool.query<{
    epc: string | null;
    sku: string | null;
    item_name: string | null;
    qty: number;
    template: string | null;
    printer: string | null;
    created_at: Date;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  }>(
    `SELECT pe.epc, pe.sku, pe.item_name, pe.qty, pe.template, pe.printer,
            pe.created_at, u.first_name, u.last_name, u.email
       FROM print_events pe
       LEFT JOIN users u ON u.id = pe.created_by
      WHERE ${conds.join(" AND ")}
      ORDER BY pe.created_at DESC
      LIMIT $${p}`,
    params,
  );
  return r.rows.map((row) => ({
    epc: row.epc,
    sku: row.sku,
    item_name: row.item_name,
    qty: row.qty,
    template: row.template,
    printer: row.printer,
    printed_at: row.created_at.toISOString(),
    printed_by: shortName(row.first_name, row.last_name, row.email),
  }));
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function labelPrintsCsv(
  rows: LabelPrintRow[],
  kind: "rfid" | "non_rfid",
): string {
  const header =
    kind === "non_rfid"
      ? "custom_sku,item_name,qty,template,printer,printed_at,printed_by"
      : "epc,custom_sku,qty,template,printer,printed_at,printed_by";
  const lines = [header];
  for (const r of rows) {
    const cells =
      kind === "non_rfid"
        ? [r.sku, r.item_name, r.qty, r.template, r.printer, r.printed_at, r.printed_by]
        : [r.epc, r.sku, r.qty, r.template, r.printer, r.printed_at, r.printed_by];
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\n");
}
