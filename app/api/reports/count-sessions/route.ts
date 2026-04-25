import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import {
  insertCountSessionReport,
  listCountSessionReports,
} from "@/lib/queries/inventory-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------- POST: archive a count-session report ---------- */

const reportRowSchema = z
  .object({
    epc: z.string().optional().nullable(),
    system_id: z.union([z.number(), z.string()]).optional().nullable(),
    custom_sku: z.string().optional().nullable(),
    item_name: z.string().optional().nullable(),
    color: z.string().optional().nullable(),
    size: z.string().optional().nullable(),
    retail_price: z.union([z.number(), z.string()]).optional().nullable(),
    bin: z.string().optional().nullable(),
    seen_count: z.union([z.number(), z.string()]).optional().nullable(),
    first_seen_iso: z.string().optional().nullable(),
    last_seen_iso: z.string().optional().nullable(),
  })
  .passthrough();

const postBodySchema = z.object({
  activity: z.string().min(1).max(64),
  when: z.string().min(1).max(64),
  overrideCatalog: z.boolean().optional().default(false),
  rows: z.array(reportRowSchema).min(1).max(50_000),
  deviceId: z.string().min(1).max(256).optional(),
});

const CSV_HEADER =
  "epc,system_id,custom_sku,item_name,color,size,retail_price,bin,seen_count,first_seen_iso,last_seen_iso";

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "number" ? String(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsvFromRows(rows: z.infer<typeof reportRowSchema>[]): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.epc),
        csvCell(r.system_id),
        csvCell(r.custom_sku),
        csvCell(r.item_name),
        csvCell(r.color),
        csvCell(r.size),
        csvCell(r.retail_price),
        csvCell(r.bin),
        csvCell(r.seen_count),
        csvCell(r.first_seen_iso),
        csvCell(r.last_seen_iso),
      ].join(","),
    );
  }
  return lines.join("\n");
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function buildFilename(activity: string, when: Date): string {
  const a = activity.toUpperCase().replace(/[^A-Z0-9_-]/g, "_") || "REPORT";
  const y = when.getUTCFullYear();
  const mo = pad2(when.getUTCMonth() + 1);
  const d = pad2(when.getUTCDate());
  const h = pad2(when.getUTCHours());
  const mi = pad2(when.getUTCMinutes());
  const s = pad2(when.getUTCSeconds());
  return `${a}_${y}${mo}${d}_${h}${mi}${s}.csv`;
}

export async function POST(req: Request) {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = postBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const auth = await resolveTenantOrError(req, pool, parsed.data.deviceId);
  if (auth instanceof Response) return auth;

  const whenDate = new Date(parsed.data.when);
  if (Number.isNaN(whenDate.getTime())) {
    return NextResponse.json({ error: "Invalid when timestamp" }, { status: 400 });
  }

  const csv = buildCsvFromRows(parsed.data.rows);
  const filename = buildFilename(parsed.data.activity, whenDate);

  try {
    const inserted = await insertCountSessionReport(pool, {
      tenantId: auth.tenantId,
      activity: parsed.data.activity,
      uploadedAt: whenDate,
      uploadedBy: auth.userId,
      deviceId: auth.deviceId,
      overrideCatalog: parsed.data.overrideCatalog,
      rowCount: parsed.data.rows.length,
      csvContent: csv,
      filename,
    });
    return NextResponse.json(inserted, { status: 201 });
  } catch (e) {
    console.error("[reports/count-sessions POST]", e);
    return NextResponse.json({ error: "Insert failed" }, { status: 500 });
  }
}

/* ---------- GET: paginated list ---------- */

export async function GET(req: Request) {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const hintedDeviceId = searchParams.get("deviceId") ?? undefined;

  const auth = await resolveTenantOrError(req, pool, hintedDeviceId);
  if (auth instanceof Response) return auth;

  const activity = searchParams.get("activity") ?? undefined;
  const search = searchParams.get("search") ?? undefined;
  const dateFrom = searchParams.get("from") ?? undefined;
  const dateTo = searchParams.get("to") ?? undefined;
  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(searchParams.get("limit") ?? "25", 10) || 25),
  );

  try {
    const result = await listCountSessionReports(pool, auth.tenantId, {
      activity,
      search,
      dateFrom,
      dateTo,
      page,
      limit,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[reports/count-sessions GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
