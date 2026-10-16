import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { ORDER_HOLD_STATUS } from "@/lib/server/order-hold-status";

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

async function POST_handler(req: Request) {
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
    // Re-encoding a tag that an online order is holding (owner, 2026-10-13):
    // the hold moves to the new chip ID. The old EPC is listed in the order's
    // shopify_sale_events.detail and was neither released (LIVE again) nor
    // shipped (SOLD) — it may already be TAG KILLED by the operator. The new
    // EPC then takes the hold status instead of going LIVE, and the order's
    // record points at the new EPC, so the order still holds one unit.
    let heldBy: string[] = [];
    if (promoteNew && oldEpc && oldEpc !== newEpc) {
      const h = await client.query<{ order_id: string }>(
        `SELECT s.order_id
           FROM shopify_sale_events s
           JOIN items i ON i.epc = $1
           JOIN locations l ON l.id = i.location_id AND l.tenant_id = $2::uuid
          WHERE i.status NOT IN ('in-stock', 'sold')
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.detail) = 'array' THEN s.detail ELSE '[]'::jsonb END) e,
                     jsonb_array_elements_text(CASE WHEN jsonb_typeof(e->'epcs') = 'array' THEN e->'epcs' ELSE '[]'::jsonb END) x
               WHERE upper(x) = $1
            )`,
        [oldEpc, session.tid],
      );
      heldBy = h.rows.map((r) => r.order_id);
    }

    let livePromoted = false;
    if (promoteNew) {
      const livePromote = await client.query(
        `UPDATE items i
            SET status = $4
           FROM locations l
          WHERE i.location_id = l.id
            AND l.tenant_id = $1::uuid
            AND i.location_id = $2::uuid
            AND i.epc = $3
            AND i.status = 'unknown'`,
        [session.tid, session.lid, newEpc, heldBy.length ? ORDER_HOLD_STATUS : "in-stock"],
      );
      livePromoted = (livePromote.rowCount ?? 0) > 0;
    }

    if (heldBy.length && oldEpc) {
      for (const orderId of heldBy) {
        await client.query(
          `UPDATE shopify_sale_events s
              SET detail = (
                SELECT jsonb_agg(
                         CASE WHEN jsonb_typeof(e.v->'epcs') = 'array'
                              THEN jsonb_set(e.v, '{epcs}', (
                                     SELECT COALESCE(jsonb_agg(CASE WHEN upper(x.t) = $2 THEN to_jsonb($3::text) ELSE to_jsonb(x.t) END ORDER BY x.n), '[]'::jsonb)
                                       FROM jsonb_array_elements_text(e.v->'epcs') WITH ORDINALITY x(t, n)))
                              ELSE e.v END
                         ORDER BY e.n)
                  FROM jsonb_array_elements(s.detail) WITH ORDINALITY e(v, n))
            WHERE s.order_id = $1 AND jsonb_typeof(s.detail) = 'array'`,
          [orderId, oldEpc, newEpc],
        );
      }
      if (livePromoted) {
        await client.query(
          `INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
           VALUES ($1::uuid, 'STATUS_CHANGE', 'EPC', $2, 'unknown', $3, $4, NULL, $5::uuid, NULL)`,
          [session.tid, newEpc, ORDER_HOLD_STATUS, `re-encode of ${oldEpc}: order hold moved to the new tag`, session.sub ?? null],
        );
      }
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
          AND i.status = $4`,
      [session.tid, session.lid, newEpc, heldBy.length ? ORDER_HOLD_STATUS : "in-stock"],
    );
    // "Live" here means the replacement row is in its final state: LIVE, or
    // held for the order it inherited.
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
      // Same garment, new tag: its assigned zone (Zone Management) follows it
      // to the new number before the old row goes.
      await client.query(
        `UPDATE items n
            SET assigned_zone_id = o.assigned_zone_id,
                zone_assigned_at = o.zone_assigned_at,
                zone_assigned_by = o.zone_assigned_by
           FROM items o
          WHERE o.epc = $2 AND o.location_id = $3::uuid AND o.assigned_zone_id IS NOT NULL
            AND n.epc = $1 AND n.location_id = $3::uuid AND n.status = 'in-stock'
            AND n.assigned_zone_id IS NULL`,
        [newEpc, oldEpc, session.lid],
      );
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

    /* Promote the matching 'pending' audit row to 'ok' so the Re-Encode
       report reflects the confirmed write. Only the newest pending row for
       this new EPC is touched.

       NOT gated on `newIsLive`: reaching finalize already means the chip
       write was verified — that is the only thing this row records. Whether
       the operator ALSO wanted the tag promoted to in-stock is a separate
       decision (`promoteNew: false` leaves it 'unknown' so they can pick the
       status themselves). Gating the two together meant a promoteNew:false
       caller could never close out its own claim, leaving a successful
       encode looking unconfirmed forever. The old-EPC delete above stays
       gated on newIsLive — that one really does need the replacement live. */
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

export const POST = withActivity("rfid/encode-finalize", POST_handler);
