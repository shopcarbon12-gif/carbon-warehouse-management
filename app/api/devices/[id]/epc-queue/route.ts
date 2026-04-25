import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { extractEdgeApiKey, verifyEdgeApiKey } from "@/lib/auth/edge-auth";
import { resolveEdgeDeviceCached } from "@/lib/server/edge-device-cache";
import { getPool } from "@/lib/db";
import {
  consumePendingEpcsForDevice,
  enqueueEpcsForDevice,
  peekPendingEpcsForDevice,
} from "@/lib/queries/device-epc-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;

const postBodySchema = z.object({
  epcs: z.array(z.string().min(4).max(64)).min(1).max(5000),
});

/**
 * POST: Web "Send to handheld" — session auth required; enqueues EPCs for the
 * named handheld. Validates that the device belongs to the caller's tenant.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const { id: deviceId } = await ctx.params;
  if (!UUID_RE.test(deviceId)) {
    return NextResponse.json({ error: "Invalid device id" }, { status: 400 });
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

  /* Tenant-scope check: the device must belong to this tenant + be authorized + handheld. */
  const dev = await pool.query<{ ok: boolean }>(
    `SELECT TRUE AS ok FROM devices
     WHERE id = $1::uuid
       AND tenant_id = $2::uuid
       AND device_type = 'handheld_reader'
       AND COALESCE(is_authorized, FALSE) = TRUE
     LIMIT 1`,
    [deviceId, session.tid],
  );
  if (!dev.rows[0]) {
    return NextResponse.json(
      { error: "Device not found or not an authorized handheld for this tenant" },
      { status: 404 },
    );
  }

  try {
    const result = await enqueueEpcsForDevice(pool, {
      tenantId: session.tid,
      deviceId,
      epcs: parsed.data.epcs,
      enqueuedBy: session.sub,
    });
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (e) {
    console.error("[devices/[id]/epc-queue POST]", e);
    return NextResponse.json({ error: "Enqueue failed" }, { status: 500 });
  }
}

/**
 * GET: Mobile poller — edge-key OR session auth.
 * `?peek=1` returns pending without consuming (web preview);
 * default behavior consumes and returns pending rows once.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const { id: deviceId } = await ctx.params;
  if (!UUID_RE.test(deviceId)) {
    return NextResponse.json({ error: "Invalid device id" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const peek = searchParams.get("peek") === "1";

  /* Auth: session OR edge api key. Tenant scope enforced via `devices.tenant_id`. */
  const session = await getSessionFromRequest(req);
  let tenantIdGuard: string | null = null;
  if (session) {
    tenantIdGuard = session.tid;
  } else {
    const apiKey = extractEdgeApiKey(req);
    if (!verifyEdgeApiKey(apiKey)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    /* For edge auth, verify the device is registered (no separate tenant claim). */
    const hintedDeviceId =
      searchParams.get("deviceId") ?? deviceId; /* allow alias lookup */
    const dev = await resolveEdgeDeviceCached(pool, hintedDeviceId);
    if (!dev) {
      return NextResponse.json({ error: "Device not registered" }, { status: 403 });
    }
    tenantIdGuard = dev.tenantId;
  }

  /* Cross-check the device row tenant matches what the auth path resolved. */
  const dev = await pool.query<{ ok: boolean }>(
    `SELECT TRUE AS ok FROM devices
     WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [deviceId, tenantIdGuard],
  );
  if (!dev.rows[0]) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const rows = peek
      ? await peekPendingEpcsForDevice(pool, deviceId)
      : await consumePendingEpcsForDevice(pool, deviceId);
    return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[devices/[id]/epc-queue GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
