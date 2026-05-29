import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

/**
 * Phase 3 — operator-confirmed re-encode finalisation.
 *
 * The atomic `encode-claim` endpoint runs BEFORE the chip is actually
 * written: it allocates a fresh serial, INSERTs the new EPC's items row
 * with status='unknown' (we don't yet know if the chip committed), and
 * marks the old EPC's items row 'tag_killed' so it stops counting toward
 * inventory. After the handheld reports `writeEpcTag = true` we know the
 * physical write landed — at that point the operator wants:
 *
 *   1. The new EPC promoted from 'unknown' to 'in-stock' (LIVE) so the
 *      tag counts as sellable stock immediately.
 *   2. The old EPC silenced in the Defective EPCs modal — the operator's
 *      desktop coworkers shouldn't see it lingering. Implemented as a
 *      `defective_acknowledged_at = now()` stamp (same mechanism the
 *      desktop dismiss button uses), so a re-scan of the killed tag
 *      can still bring it back if something's wrong.
 *
 * Body: { newEpc, oldEpc? }  (24-hex each)
 * Reply: { ok, livePromoted: bool, defectiveDismissed: bool }
 *
 * Auth: session JWT only (this is the same boundary `encode-claim` uses).
 * Tenant/location scope is taken from the session — we never trust client
 * payload for tenant routing.
 */
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  newEpc: z.string().regex(/^[0-9A-Fa-f]{24}$/u, "newEpc must be 24 hex chars"),
  oldEpc: z.string().regex(/^[0-9A-Fa-f]{24}$/u, "oldEpc must be 24 hex chars").optional(),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const newEpc = parsed.data.newEpc.toUpperCase();
  const oldEpc = parsed.data.oldEpc?.toUpperCase();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Promote the new EPC from 'unknown' → 'in-stock' for this tenant +
    // active location. Scoped to status='unknown' so a later state change
    // (e.g. operator manually flipped to TAG KILLED via the post-encode
    // dropdown) wins over the auto-promotion. tenant_id check via the
    // join prevents cross-tenant promotion if the EPC happens to collide.
    const livePromote = await client.query(
      `UPDATE items i
          SET status = 'in-stock'
         FROM locations l
        WHERE i.location_id = l.id
          AND l.tenant_id = $1::uuid
          AND i.location_id = $2::uuid
          AND i.epc = $3
          AND i.status = 'unknown'`,
      [session.tid, session.lid, newEpc],
    );
    const livePromoted = (livePromote.rowCount ?? 0) > 0;

    // Dismiss the old EPC from the Defective EPCs modal — same mechanism
    // the desktop dismiss button uses. We don't touch its status (it
    // stays 'tag_killed'), only set the acknowledgement timestamp so the
    // modal's `last_seen_at > defective_acknowledged_at` filter hides it
    // unless it gets re-scanned afterwards.
    let defectiveDismissed = false;
    if (oldEpc && oldEpc !== newEpc) {
      const dismiss = await client.query(
        `UPDATE items i
            SET defective_acknowledged_at = now()
           FROM locations l
          WHERE i.location_id = l.id
            AND l.tenant_id = $1::uuid
            AND i.location_id = $2::uuid
            AND i.epc = $3
            AND i.status = 'tag_killed'`,
        [session.tid, session.lid, oldEpc],
      );
      defectiveDismissed = (dismiss.rowCount ?? 0) > 0;
    }

    await client.query("COMMIT");
    return NextResponse.json({
      ok: true,
      livePromoted,
      defectiveDismissed,
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[rfid/encode-finalize]", e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  } finally {
    client.release();
  }
}
