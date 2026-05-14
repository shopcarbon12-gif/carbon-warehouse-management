import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { getSession } from "@/lib/server/rfid-cycle-count-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cycle count → Manual Items popup.
 *
 *   GET  → List every manual SKU at the session's location, with
 *          expected_qty (snapshot of catalog manual_item_qty.current_qty
 *          at first save, or current value if no draft yet) and any
 *          existing draft entry's count_qty + state.
 *
 *   PUT  → Save drafts. Body: { entries: [{ customSkuId, countQty }] }.
 *          Upserts cycle_count_manual_drafts rows with state='draft'.
 *          Snapshot expected_qty_at_save on first insert; preserve on update.
 *          countQty=null clears the entry.
 */

type Ctx = { params: Promise<{ id: string }> };

const putSchema = z.object({
  entries: z.array(
    z.object({
      customSkuId: z.string().uuid(),
      countQty: z.number().int().min(0).max(999).nullable(),
    }),
  ).min(1).max(2000),
});

export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await params;
  const detail = await getSession(pool, session.tid, id);
  if (!detail) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  const r = await pool.query<{
    custom_sku_id: string;
    matrix_id: string;
    matrix_ls_system_id: string | null;
    sku_ls_system_id: string | null;
    sku: string;
    upc: string | null;
    name: string;
    color: string | null;
    size: string | null;
    catalog_qty: number | null;
    draft_count_qty: number | null;
    draft_expected_qty_at_save: number | null;
    draft_state: string | null;
  }>(
    `SELECT
       cs.id::text AS custom_sku_id,
       m.id::text AS matrix_id,
       m.ls_system_id::text AS matrix_ls_system_id,
       cs.ls_system_id::text AS sku_ls_system_id,
       cs.sku,
       COALESCE(cs.upc, m.upc) AS upc,
       m.description AS name,
       cs.color_code AS color,
       cs.size,
       (SELECT current_qty FROM manual_item_qty miq
         WHERE miq.custom_sku_id = cs.id
           AND miq.location_id = $2::uuid) AS catalog_qty,
       d.count_qty AS draft_count_qty,
       d.expected_qty_at_save AS draft_expected_qty_at_save,
       d.state AS draft_state
     FROM custom_skus cs
     INNER JOIN matrices m ON m.id = cs.matrix_id
     LEFT JOIN cycle_count_manual_drafts d
       ON d.session_id = $1::uuid AND d.custom_sku_id = cs.id
     WHERE m.is_manual_only = TRUE
       AND cs.archived = FALSE
     ORDER BY m.description ASC NULLS LAST, cs.sku ASC`,
    [id, detail.location_id],
  );

  const rows = r.rows.map((row) => {
    const catalogQty = Number(row.catalog_qty ?? 0);
    /* expected_qty: snapshot at first save if a draft exists; otherwise the
     * live catalog qty. Operators see a stable +N/-N delta even if LS sync
     * runs in another tab while they're counting. */
    const expectedQty = row.draft_expected_qty_at_save != null
      ? Number(row.draft_expected_qty_at_save)
      : catalogQty;
    return {
      custom_sku_id: row.custom_sku_id,
      matrix_id: row.matrix_id,
      matrix_ls_system_id: row.matrix_ls_system_id,
      sku_ls_system_id: row.sku_ls_system_id,
      sku: row.sku,
      upc: row.upc,
      name: row.name,
      color: row.color,
      size: row.size,
      expected_qty: expectedQty,
      count_qty: row.draft_count_qty == null ? null : Number(row.draft_count_qty),
      state: row.draft_state ?? "pending",
    };
  });

  return NextResponse.json(
    { rows, count: rows.length, session_status: detail.status },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await params;
  const detail = await getSession(pool, session.tid, id);
  if (!detail) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (detail.status === "committed" || detail.status === "canceled") {
    return NextResponse.json(
      { error: "Session is closed; manual items can no longer be edited" },
      { status: 409 },
    );
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = putSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let saved = 0;
    let cleared = 0;
    for (const e of parsed.data.entries) {
      if (e.countQty == null) {
        const del = await client.query(
          `DELETE FROM cycle_count_manual_drafts
            WHERE session_id = $1::uuid
              AND custom_sku_id = $2::uuid
              AND state = 'draft'`,
          [id, e.customSkuId],
        );
        cleared += del.rowCount ?? 0;
        continue;
      }
      /* Snapshot the catalog qty at first save; never overwrite once set. */
      const cur = await client.query<{ current_qty: number }>(
        `SELECT COALESCE(current_qty, 0) AS current_qty
           FROM manual_item_qty
          WHERE custom_sku_id = $1::uuid AND location_id = $2::uuid`,
        [e.customSkuId, detail.location_id],
      );
      const expectedSnap = Number(cur.rows[0]?.current_qty ?? 0);

      const up = await client.query(
        `INSERT INTO cycle_count_manual_drafts
           (session_id, custom_sku_id, expected_qty_at_save, count_qty, state, saved_by_user_id, saved_at)
         VALUES ($1::uuid, $2::uuid, $3::int, $4::int, 'draft', $5::uuid, now())
         ON CONFLICT (session_id, custom_sku_id) DO UPDATE
           SET count_qty = EXCLUDED.count_qty,
               saved_by_user_id = EXCLUDED.saved_by_user_id,
               saved_at = now()
           WHERE cycle_count_manual_drafts.state = 'draft'`,
        [id, e.customSkuId, expectedSnap, e.countQty, session.sub],
      );
      saved += up.rowCount ?? 0;
    }

    await client.query("COMMIT");
    return NextResponse.json({ ok: true, saved, cleared });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[cycle-counts/manual-items PUT]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Save failed" },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}
