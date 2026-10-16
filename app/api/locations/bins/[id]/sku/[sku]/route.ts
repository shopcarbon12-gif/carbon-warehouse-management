import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { binActorFrom, canChangeBins } from "@/lib/server/bin-engine";
import { cleanBinContents } from "@/lib/queries/clean-bin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sku: string }> };

/**
 * DELETE /api/locations/bins/:binCodeOrId/sku/:skuPrefix
 *
 * Removes one custom-SKU (matrix+colour prefix, all sizes) from a bin —
 * the inverse of the putaway assign. Used by the Bin Assign screen's
 * remove / undo action. Pre-existing bug: the mobile called this path but
 * no route existed, so every remove returned 404.
 *
 * `:id` accepts EITHER the bin UUID or the bin CODE (mobile ships the dashed
 * display code, e.g. "1-A-01-L"); we normalise both sides like the putaway
 * endpoints. `:skuPrefix` is the matrix+colour prefix (e.g. 122224804) — we
 * match every size via `sku LIKE '<prefix>%'`, the same filter the assign uses.
 *
 * `?matrixId=<uuid>` pins it to one product. Two matrices may share a UPC
 * (migration 0092), so the prefix alone can match a second product's variants
 * and evict them from the bin too. Optional, for older handhelds.
 *
 * Effect (shared bin engine, same as Clean): every tag of that product that
 * lists this bin loses it; a tag whose primary bin this was gets its first
 * live extra bin promoted. Returns before → after per EPC for an exact Undo.
 * Active-location scoped.
 */
async function DELETE_handler(req: Request, ctx: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, sku } = await ctx.params;
  const binKey = (id ?? "").trim();
  const skuPrefix = (sku ?? "").trim();
  const rawMatrixId = new URL(req.url).searchParams.get("matrixId")?.trim() ?? "";
  const matrixId = /^[0-9a-f-]{36}$/i.test(rawMatrixId) ? rawMatrixId : null;
  if (!binKey) return NextResponse.json({ error: "Missing bin" }, { status: 400 });
  // Matrix/colour prefix range — same guard as the clean-bin endpoint.
  if (!/^[A-Za-z0-9]{7,32}$/.test(skuPrefix)) {
    return NextResponse.json({ error: "Invalid SKU" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  // Resolve the bin by UUID or normalised code, scoped to the active location.
  const bin = await pool.query<{ id: string }>(
    `SELECT id::text FROM bins
       WHERE location_id = $1::uuid
         AND archived_at IS NULL
         AND (
           id::text = $2
           OR regexp_replace(upper(code), '[^A-Z0-9]', '', 'g')
              = regexp_replace(upper($2), '[^A-Z0-9]', '', 'g')
         )
       LIMIT 1`,
    [session.lid, binKey],
  );
  const binId = bin.rows[0]?.id;
  if (!binId) return NextResponse.json({ error: "Bin not found" }, { status: 404 });

  if (!(await canChangeBins(pool, session, "assign"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await cleanBinContents(client, session.tid, binId, {
      skuPrefix,
      matrixId,
      actor: binActorFrom(req, session, new URL(req.url).searchParams.get("deviceId")),
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, removed: result.cleared, binId, changes: result.changes });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[bins/:id/sku/:sku DELETE]", e);
    return NextResponse.json({ error: "Remove failed" }, { status: 500 });
  } finally {
    client.release();
  }
}

export const DELETE = withActivity("locations/bins/[id]/sku/[sku]", DELETE_handler);
