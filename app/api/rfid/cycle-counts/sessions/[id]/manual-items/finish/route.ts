import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { getSession } from "@/lib/server/rfid-cycle-count-sessions";
import {
  applyManualItemOverride,
  lookupUserNameForHistory,
} from "@/lib/server/manual-item-qty";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cycle count → Manual Items popup → Finish.
 *
 * Commits every draft entry under this session that has a count_qty set:
 *   - Calls applyManualItemOverride (writes manual_item_qty.current_qty +
 *     a manual_item_qty_history row, source='cycle_count', attributed to
 *     the user who clicks Finish).
 *   - Marks the draft row state='committed', stamps committed_at + history_id.
 *
 * The cycle count session itself is NOT closed by this — the existing RFID
 * commit flow stays in charge of session lifecycle. Manual entries commit
 * independently per the operator's choice.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await params;
  const detail = await getSession(pool, session.tid, id);
  if (!detail) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (detail.status === "committed" || detail.status === "canceled") {
    return NextResponse.json(
      { error: "Session is closed; manual items can no longer be committed" },
      { status: 409 },
    );
  }

  const userName = await lookupUserNameForHistory(pool, session.sub);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const drafts = await client.query<{
      id: string;
      custom_sku_id: string;
      count_qty: number;
    }>(
      `SELECT id::text, custom_sku_id::text, count_qty
         FROM cycle_count_manual_drafts
        WHERE session_id = $1::uuid
          AND state = 'draft'
          AND count_qty IS NOT NULL
        FOR UPDATE`,
      [id],
    );

    let committed = 0;
    for (const d of drafts.rows) {
      const result = await applyManualItemOverride(client, {
        customSkuId: d.custom_sku_id,
        locationId: detail.location_id,
        newQty: Number(d.count_qty),
        source: "cycle_count",
        changedByUserId: session.sub,
        changedByUserName: userName,
        notes: `Cycle count session ${detail.name}`,
        referenceId: id,
      });

      await client.query(
        `UPDATE cycle_count_manual_drafts
            SET state = 'committed',
                committed_at = now(),
                history_id = $2::uuid
          WHERE id = $1::uuid`,
        [d.id, result.historyId],
      );
      committed += 1;
    }

    await client.query("COMMIT");
    return NextResponse.json({ ok: true, committed });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[cycle-counts/manual-items/finish]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Finish failed" },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}
