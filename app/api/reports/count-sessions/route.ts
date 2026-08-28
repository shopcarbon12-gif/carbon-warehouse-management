import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import {
  insertCountSessionReport,
  listCountSessionReports,
} from "@/lib/queries/inventory-reports";
import { enrichEpcsByCatalog } from "@/lib/server/catalog-enrich";

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
  // Pre-built CSV. When supplied, it is archived verbatim instead of being
  // rendered from `rows` against the count-session column set, and catalog
  // enrichment is skipped.
  //
  // This exists for reports whose natural shape isn't one-row-per-EPC — the
  // Tag Test module uploads one row per (step, power level) with signal
  // columns that have no meaning in the count schema. Reusing this endpoint
  // gives those reports the same storage, retention, listing and download
  // path as every other report for the cost of one optional field, instead of
  // a parallel stack that would have to be kept in step with this one.
  csv: z.string().min(1).max(5_000_000).optional(),
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

  // Resolve EPC → catalog (custom_sku, item_name, color, size, retail_price,
  // bin) server-side so the archived CSV carries full item context instead
  // of the empty columns the mobile sends. The mobile commits with epc +
  // timestamps only — every other column is blank — so without this step
  // the /reports/count-sessions page is unreadable.
  //
  // overrideCatalog semantics:
  //   false (default) — fill in only the columns the row left blank.
  //   true            — replace mobile-supplied values with the catalog
  //                     hit, useful when an operator suspects the mobile's
  //                     cached metadata is stale.
  const suppliedCsv = parsed.data.csv;
  const epcsToResolve = suppliedCsv
    ? []
    : parsed.data.rows
        .map((r) => (r.epc ?? "").trim())
        .filter((e) => e.length > 0);

  let enrichedRows = parsed.data.rows;
  if (epcsToResolve.length > 0) {
    try {
      const enrich = await enrichEpcsByCatalog(pool, auth.tenantId, epcsToResolve);
      const byEpc = new Map(enrich.map((r) => [r.epc, r] as const));
      const empty = (v: unknown) => v == null || String(v).trim() === "";
      const pick = <T,>(incoming: T | null | undefined, fromCatalog: T | null) =>
        parsed.data.overrideCatalog
          ? (fromCatalog ?? incoming ?? null)
          : (empty(incoming) ? (fromCatalog ?? null) : (incoming ?? null));

      enrichedRows = parsed.data.rows.map((r) => {
        const epcUp = (r.epc ?? "").trim().toUpperCase();
        const hit = byEpc.get(epcUp);
        if (!hit) return r;
        return {
          ...r,
          system_id: pick(r.system_id, hit.sku_ls_system_id),
          custom_sku: pick(r.custom_sku, hit.sku),
          item_name: pick(r.item_name, hit.name),
          color: pick(r.color, hit.color),
          size: pick(r.size, hit.size),
          retail_price: pick(r.retail_price, hit.retail_price),
          bin: pick(r.bin, hit.bin_code),
        };
      });
    } catch (e) {
      // Enrichment is best-effort. If the catalog query fails we still
      // archive whatever the mobile uploaded — a CSV with empty metadata
      // is better than a 500.
      console.error("[reports/count-sessions POST] catalog enrich failed:", e);
    }
  }

  const csv = suppliedCsv ?? buildCsvFromRows(enrichedRows);
  const filename = buildFilename(parsed.data.activity, whenDate);

  try {
    const inserted = await insertCountSessionReport(pool, {
      tenantId: auth.tenantId,
      activity: parsed.data.activity,
      uploadedAt: whenDate,
      uploadedBy: auth.userId,
      deviceId: auth.deviceId,
      overrideCatalog: parsed.data.overrideCatalog,
      rowCount: enrichedRows.length,
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
