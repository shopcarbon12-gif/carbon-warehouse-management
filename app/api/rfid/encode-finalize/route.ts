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
 *   2. The old EPC's items row DELETED entirely (2026-05-30 hardened).
 *      Previously we only set `defective_acknowledged_at = now()`, but
 *      that left the row in 'tag_killed' status — every cycle-count
 *      session, every "DEFECTIVE" KPI, every catalog audit kept
 *      seeing the row. The operator's intent for a successful
 *      re-encode is unambiguous: that chip ID is gone forever and the
 *      new chip ID has replaced it. Hard-DELETE the row; the audit
 *      trail (encode_events) preserves the old→new mapping.
 *
 * Body: { newEpc, oldEpc? }  (24-hex each)
 * Reply: { ok, livePromoted: bool, defectiveDeleted: bool }
 *
 * Auth: session JWT only (this is the same boundary `encode-claim` uses).
 * Tenant/location scope is taken from the session — we never trust client
 * payload for tenant routing.
 */
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  newEpc: z.string().regex(/^[0-9A-Fa-f]{24}$/u, "newEpc must be 24 hex chars"),
  oldEpc: z.string().regex(/^[0-9A-Fa-f]{24}$/u, "oldEpc must be 24 hex chars").optional(),
  // When false, the new EPC is LEFT at status='unknown' so the operator picks
  // the final status from the post-encode dropdown (Encode + Encode & Print
  // screens). Defaults true to keep the auto-LIVE behaviour the Re-Encode flow
  // relies on. The old-EPC delete happens regardless.
  promoteNew: z.boolean().optional().default(true),
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
  const promoteNew = parsed.data.promoteNew;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Promote the new EPC from 'unknown' → 'in-stock' for this tenant +
    // active location. Scoped to status='unknown' so a later state change
    // (e.g. operator manually flipped to TAG KILLED via the post-encode
    // dropdown) wins over the auto-promotion. tenant_id check via the
    // join prevents cross-tenant promotion if the EPC happens to collide.
    let livePromoted = false;
    if (promoteNew) {
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
      livePromoted = (livePromote.rowCount ?? 0) > 0;
    }

    // Is the NEW EPC live for this tenant+location right now? True when we
    // just promoted it, OR when a previous finalize already did (idempotent
    // retry). The old EPC is only retired when the replacement is provably
    // live — this is the safety gate that keeps a FAILED write (where the
    // new EPC never went live) from deleting the still-good old chip's row.
    const newLiveR = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM items i
         JOIN locations l ON l.id = i.location_id
        WHERE l.tenant_id = $1::uuid
          AND i.location_id = $2::uuid
          AND i.epc = $3
          AND i.status = 'in-stock'`,
      [session.tid, session.lid, newEpc],
    );
    const newIsLive = Number(newLiveR.rows[0]?.n ?? 0) > 0;

    // DELETE the old EPC's items row entirely, but ONLY once the new EPC is
    // confirmed live (newIsLive). After a confirmed re-encode the old chip
    // ID is replaced — the row is obsolete; encode_events keeps the old→new
    // mapping for audit. The status is no longer gated on 'tag_killed'
    // because, as of 2026-06-05, claim no longer pre-kills the old row;
    // it stays 'in-stock' until this point. We exclude 'sold' so a chip
    // that was sold mid-flight is never silently deleted. Hard-DELETE;
    // items has no FK children. Tenant+location scoped.
    let defectiveDeleted = false;
    if (oldEpc && oldEpc !== newEpc && newIsLive) {
      const del = await client.query(
        `DELETE FROM items i
          USING locations l
          WHERE i.location_id = l.id
            AND l.tenant_id = $1::uuid
            AND i.location_id = $2::uuid
            AND i.epc = $3
            AND i.status <> 'sold'`,
        [session.tid, session.lid, oldEpc],
      );
      defectiveDeleted = (del.rowCount ?? 0) > 0;
    }

    // Promote the matching 'pending' audit row to 'ok' so the Re-Encode
    // report reflects the confirmed write. Only the newest pending row for
    // this new EPC is touched.
    if (newIsLive) {
      await client.query(
        `UPDATE encode_events
            SET status = 'ok', encoded_at = now()
          WHERE ctid IN (
            SELECT ctid FROM encode_events
             WHERE new_epc = $1 AND status = 'pending'
             ORDER BY created_at DESC
             LIMIT 1
          )`,
        [newEpc],
      );
    }

    await client.query("COMMIT");
    return NextResponse.json({
      ok: true,
      livePromoted,
      defectiveDeleted,
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
