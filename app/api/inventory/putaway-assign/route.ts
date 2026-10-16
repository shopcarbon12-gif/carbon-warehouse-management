import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { assignItemsToBinBySkuScan } from "@/lib/queries/putaway-assign";
import { authorizeHandheldDeviceRequest } from "@/lib/server/handheld-request-auth";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { binActorFrom, canChangeBins } from "@/lib/server/bin-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  deviceId: z.string().min(1).max(256),
  binCode: z.string().min(1).max(64),
  skuScanned: z.string().min(1).max(256),
  scope: z.enum(["all_colors", "single_color_all_sizes"]),
  /**
   * The product the handheld resolved the scan to. Optional for older
   * clients, but without it a SKU prefix shared by two matrices (migration
   * 0092) sweeps both products into the bin.
   */
  matrixId: z.string().uuid().nullish(),
  // Optional. Defaults to homeless_only for backwards compat with older clients.
  // "all" lets the mobile flow rebin items currently sitting in another bin
  // (used when the operator picks MOVE in the multi-bin prompt).
  mode: z.enum(["homeless_only", "all"]).optional(),
});

async function POST_handler(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const auth = await authorizeHandheldDeviceRequest(pool, req, parsed.data.deviceId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // The bin list, contents, clean and remove on the same screen all use the
  // session's location; the assign used the phone's registered location, so
  // after a location switch it looked up the bin somewhere else.
  const session = await getSessionFromRequest(req);
  if (session && !(await canChangeBins(pool, session, "assign"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const locationId = session?.lid || auth.device.locationId;
  const tenantId = session?.tid || auth.device.tenantId;

  try {
    const { updated, changes, binId } = await assignItemsToBinBySkuScan(
      pool,
      tenantId,
      locationId,
      parsed.data.binCode,
      parsed.data.skuScanned,
      parsed.data.scope,
      parsed.data.mode ?? "homeless_only",
      parsed.data.matrixId ?? null,
      binActorFrom(req, session, parsed.data.deviceId),
    );
    return NextResponse.json({ ok: true, updated, binId, changes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[putaway-assign]", e);
    return NextResponse.json({ error: "Putaway failed" }, { status: 500 });
  }
}

export const POST = withActivity("inventory/putaway-assign", POST_handler);
