import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { binActorFrom, canChangeBins, revertBinChanges } from "@/lib/server/bin-engine";
import { restoreDeletedBin } from "@/lib/server/overview-locations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const home = z.object({
  bin: z.string().uuid().nullable(),
  extra: z.array(z.string().uuid()).max(64),
});

const Body = z.object({
  /** The `changes` an assign / clean / remove / delete response returned. */
  changes: z
    .array(z.object({ epc: z.string().min(1).max(64), before: home, after: home }))
    .max(20000),
  /** Undo of a Delete bin: bring this archived bin back first. */
  restoreBinId: z.string().uuid().nullish(),
  deviceId: z.string().max(256).nullish(),
});

/**
 * POST /api/locations/bins/revert — exact Undo for any bin change.
 *
 * Every tag goes back to its `before` home, but only if it still looks
 * exactly like `after`; tags changed since (sold, moved by someone else) are
 * left alone and reported as `skipped`. The handheld's Undo buttons used to
 * re-ADD the product instead, which also binned unassigned stock and added
 * the bin as a second bin to stock sitting in other bins.
 */
async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const need = parsed.data.restoreBinId ? "delete" : "assign";
  if (!(await canChangeBins(pool, session, need))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let restoredCode: string | null = null;
    if (parsed.data.restoreBinId) {
      restoredCode = (await restoreDeletedBin(client, session.tid, session.lid, parsed.data.restoreBinId)).code;
    }
    const { reverted, skipped } = await revertBinChanges(
      client,
      session.tid,
      session.lid,
      parsed.data.changes,
      binActorFrom(req, session, parsed.data.deviceId),
    );
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, reverted: reverted.length, skipped, restoredCode });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : "Undo failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[locations/bins/revert]", e);
    return NextResponse.json({ error: "Undo failed" }, { status: 500 });
  } finally {
    client.release();
  }
}

export const POST = withActivity("locations/bins/revert", POST_handler);
