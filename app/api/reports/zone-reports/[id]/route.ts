import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** RFC-4180-ish parser for the CSVs writeZoneReport produces. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c !== "")) out.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    if (row.some((c) => c !== "")) out.push(row);
  }
  return out;
}

/** GET → one zone report as JSON lines (header → value), for the handheld. */
export async function GET(req: Request, ctx: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const r = await pool.query<{ raw_csv: string; workflow_mode: string; created_at: Date; device_id: string }>(
    `SELECT raw_csv, workflow_mode, created_at, device_id FROM device_upload_logs
      WHERE id = $1 AND tenant_id = $2::uuid AND workflow_mode LIKE 'Zone %'`,
    [Number(id), session.tid],
  );
  const row = r.rows[0];
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [header, ...rows] = parseCsv(row.raw_csv);
  const keys = header ?? [];
  return NextResponse.json(
    {
      id: Number(id),
      mode: row.workflow_mode,
      device: row.device_id,
      createdAt: row.created_at.toISOString(),
      lines: rows.map((cells) => Object.fromEntries(keys.map((k, i) => [k, cells[i] ?? ""]))),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
