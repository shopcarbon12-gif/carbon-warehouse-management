import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import { finalizeScanSession } from "@/lib/server/scan-finalize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/handheld/scan-finalize
 *
 * Unified entry point for SAVE / UPLOAD on both Count and Add-On Count.
 * Phase 3c lock: this is the shared pipeline. Existing /api/inventory/upload
 * stays in place for backwards compat until 4c flips Count over.
 *
 * Body:
 *   intent:           'save' | 'upload'
 *   screen:           'count_inventory' | 'count_inventory_override' | 'add_on_count'
 *   overrideCatalog:  bool (Count only — Q21 lock; ignored for add_on_count)
 *   rows:             [{ epc, system_id, custom_sku, ... }]   (full audit row set)
 *   deviceId:         optional (auth path)
 *   addOnSourceType?: 'mobile_count' | 'cycle_count' | 'csv_import'
 *   addOnSourceId?:   string  (uuid for mobile_count/cycle_count; int-as-string for csv_import)
 *   addOnSessionId?:  string  (uuid)
 */

const rowSchema = z
  .object({
    epc: z.string().nullable().optional(),
    system_id: z.union([z.number(), z.string()]).nullable().optional(),
    custom_sku: z.string().nullable().optional(),
    item_name: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    size: z.string().nullable().optional(),
    retail_price: z.union([z.number(), z.string()]).nullable().optional(),
    bin: z.string().nullable().optional(),
    seen_count: z.union([z.number(), z.string()]).nullable().optional(),
    first_seen_iso: z.string().nullable().optional(),
    last_seen_iso: z.string().nullable().optional(),
  })
  .passthrough();

const bodySchema = z.object({
  intent: z.enum(["save", "upload"]),
  screen: z.enum(["count_inventory", "count_inventory_override", "add_on_count"]),
  overrideCatalog: z.boolean().optional().default(false),
  rows: z.array(rowSchema).min(1).max(50_000),
  deviceId: z.string().min(1).max(256).optional(),
  /** Operator-friendly device name (e.g. "Samsung S938U", "Chainway C72E
   *  HC720A211200582"). Used for the cycle-count workspace source filter
   *  so each handheld shows up individually. Falls back to "mobile" when
   *  missing — keeps legacy callers working. */
  deviceName: z.string().min(1).max(128).optional(),
  addOnSourceType: z.enum(["mobile_count", "cycle_count", "csv_import"]).optional(),
  addOnSourceId: z.string().min(1).max(64).optional(),
  addOnSessionId: z.string().min(1).max(64).optional(),
  /** When auth is edge-key + addOnSourceType missing, locationId is required. */
  locationId: z.string().min(1).max(64).optional(),
});

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
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const auth = await resolveTenantOrError(req, pool, parsed.data.deviceId);
  if (auth instanceof Response) return auth;

  // Need a locationId. Prefer session.lid; fall back to the device's location;
  // accept body-supplied locationId only when neither is available.
  const session = await import("@/lib/get-session-from-request").then((m) =>
    m.getSessionFromRequest(req),
  );
  let locationId: string | null = session?.lid ?? null;
  if (!locationId && auth.deviceId) {
    const r = await pool.query<{ location_id: string }>(
      `SELECT location_id::text FROM devices WHERE id = $1 LIMIT 1`,
      [auth.deviceId],
    );
    locationId = r.rows[0]?.location_id ?? null;
  }
  if (!locationId) locationId = parsed.data.locationId ?? null;
  if (!locationId) {
    return NextResponse.json(
      { error: "locationId could not be resolved" },
      { status: 400 },
    );
  }

  try {
    const result = await finalizeScanSession(pool, {
      tenantId: auth.tenantId,
      locationId,
      userId: auth.userId,
      deviceId: auth.deviceId,
      intent: parsed.data.intent,
      screen: parsed.data.screen,
      overrideCatalog: parsed.data.overrideCatalog,
      rows: parsed.data.rows,
      addOnSourceType: parsed.data.addOnSourceType,
      addOnSourceId: parsed.data.addOnSourceId,
      addOnSessionId: parsed.data.addOnSessionId,
      deviceName: parsed.data.deviceName,
    });
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (e) {
    console.error("[handheld/scan-finalize POST]", e);
    return NextResponse.json({ error: "Finalize failed" }, { status: 500 });
  }
}
