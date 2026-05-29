import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import { dismissEpcsForDevice, listPendingEpcsForDevice } from "@/lib/queries/device-epc-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mobile-facing poll endpoint for the Cloud + Geiger screen.
 *
 * Dual-auth via `resolveTenantOrError` — matches the rest of
 * `/api/handheld/*`. Session JWT (mobile login) OR edge api key (firehose
 * use). The deviceId hint comes from `x-wms-device-id` header or
 * `?deviceId=` query (name / config alias / android_id / uuid). The device
 * row is then tenant-scoped to the resolved tenant so a session token from
 * tenant A can never drain another tenant's queue.
 */
export async function GET(req: Request) {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const url = new URL(req.url);
  const headerHint = req.headers.get("x-wms-device-id")?.trim() || null;
  const queryHint = url.searchParams.get("deviceId")?.trim() || null;
  const hint = headerHint || queryHint;
  if (!hint) {
    return NextResponse.json(
      { error: "deviceId required (x-wms-device-id header or ?deviceId= query)" },
      { status: 400 },
    );
  }

  const auth = await resolveTenantOrError(req, pool, hint);
  if (auth instanceof Response) return auth;

  const dev = await pool.query<{ id: string }>(
    `SELECT d.id::text
     FROM devices d
     WHERE d.tenant_id = $1::uuid
       AND (
         lower(trim(d.name)) = lower(trim($2::text))
         OR lower(trim(d.config->>'deviceId')) = lower(trim($2::text))
         OR lower(trim(d.config->>'edgeDeviceId')) = lower(trim($2::text))
         OR lower(trim(coalesce(d.android_id, ''))) = lower(trim($2::text))
         OR d.id::text = trim($2::text)
       )
       AND d.device_type = 'handheld_reader'
       AND COALESCE(d.is_authorized, FALSE) = TRUE
     LIMIT 1`,
    [auth.tenantId, hint],
  );
  const row = dev.rows[0];
  if (!row) {
    return NextResponse.json({ error: "Device not registered or not authorized" }, { status: 403 });
  }

  try {
    const rows = await listPendingEpcsForDevice(pool, row.id);
    return NextResponse.json(
      { deviceUuid: row.id, epcs: rows.map((r) => r.epc), count: rows.length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[handheld/epc-queue]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}

/**
 * Dismiss one or more EPCs for this handheld's Cloud + Geiger queue.
 * Called by the mobile screen when the operator slide-deletes a row OR
 * when a Take-an-Action flow resolves the EPC (re-encode success,
 * status change commit on the same EPC, etc.). Idempotent — re-
 * submitting already-consumed EPCs returns dismissed=0.
 *
 * Body: { epcs: [...] }
 * Reply: { ok: true, dismissed: number }
 */
export async function POST(req: Request) {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const headerHint = req.headers.get("x-wms-device-id")?.trim() || null;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = (raw ?? {}) as Record<string, unknown>;
  const bodyHint = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  const hint = headerHint || bodyHint || null;
  if (!hint) {
    return NextResponse.json(
      { error: "deviceId required (x-wms-device-id header or body.deviceId)" },
      { status: 400 },
    );
  }
  const epcs = Array.isArray(body.epcs)
    ? body.epcs.filter((e): e is string => typeof e === "string")
    : [];
  if (epcs.length === 0) {
    return NextResponse.json({ error: "epcs array required" }, { status: 400 });
  }

  const auth = await resolveTenantOrError(req, pool, hint);
  if (auth instanceof Response) return auth;

  const dev = await pool.query<{ id: string }>(
    `SELECT d.id::text
     FROM devices d
     WHERE d.tenant_id = $1::uuid
       AND (
         lower(trim(d.name)) = lower(trim($2::text))
         OR lower(trim(d.config->>'deviceId')) = lower(trim($2::text))
         OR lower(trim(d.config->>'edgeDeviceId')) = lower(trim($2::text))
         OR lower(trim(coalesce(d.android_id, ''))) = lower(trim($2::text))
         OR d.id::text = trim($2::text)
       )
       AND d.device_type = 'handheld_reader'
       AND COALESCE(d.is_authorized, FALSE) = TRUE
     LIMIT 1`,
    [auth.tenantId, hint],
  );
  const row = dev.rows[0];
  if (!row) {
    return NextResponse.json({ error: "Device not registered or not authorized" }, { status: 403 });
  }

  try {
    const r = await dismissEpcsForDevice(pool, row.id, epcs);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    console.error("[handheld/epc-queue POST]", e);
    return NextResponse.json({ error: "Dismiss failed" }, { status: 500 });
  }
}
