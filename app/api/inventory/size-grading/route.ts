import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

/**
 * Size Grading: the sizes a product comes in, and the measurements taken on one.
 *
 * GET  ?matrixId=<uuid>   → { item: { matrixId, upc, name, vendor }, sizes: [...] }
 *      ?upc=<code>        → the same, found by UPC (what a scan gives us)
 *      ?customSkuId=<uuid> → { measurement } — the latest reading for one size,
 *                            which is what the item card shows and edits
 * POST { customSkuId, garmentType, pointsCm, pxPerCm, typeOverridden, view, note }
 *      → saves the measurement against EVERY colour of that size, for one side
 *        of the garment (front or back).
 *
 * A garment's flat measurements come from the pattern, and the pattern does not
 * change with the dye: a size 38 in teal and a size 38 in purple are cut from
 * the same pieces. Measuring one and leaving the other blank would mean
 * measuring the same garment again for no reason, so one reading is written to
 * every colour in that size — which is what the owner asked for, and is also
 * the only version that stays consistent.
 *
 * Scope is the matrix the operator picked, not every matrix sharing the UPC:
 * colours were deliberately split into separate products this week (Karina /
 * Christy / Brandi all carry 2521402 but are different garments), so crossing
 * that boundary would put one garment's measurements on another's.
 *
 * Deliberately NOT admin-only. Measuring a garment is floor work, and the whole
 * point of the page is that whoever is holding the garment can do it. It reads
 * the catalogue and appends a measurement; it cannot change an item, a price or
 * stock, so an operator's session is enough.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { searchParams } = new URL(req.url);
  const customSkuId = (searchParams.get("customSkuId") ?? "").trim();
  if (customSkuId) {
    if (!UUID_RE.test(customSkuId)) {
      return NextResponse.json({ error: "customSkuId must be a uuid" }, { status: 400 });
    }
    /* The latest of each side, not the latest overall: measuring the back
       must not make the front reading disappear from the card. */
    const latest = await pool.query<{
      id: string;
      garment_type: string;
      points_cm: Record<string, number>;
      measured_at: string;
      note: string | null;
      view: string;
    }>(
      `SELECT DISTINCT ON (view) id, garment_type, points_cm, measured_at, note, view
         FROM size_grading_measurements
        WHERE custom_sku_id = $1::uuid
        ORDER BY view, measured_at DESC`,
      [customSkuId],
    );
    const front = latest.rows.find((r) => r.view === "front") ?? null;
    const back = latest.rows.find((r) => r.view === "back") ?? null;
    // `measurement` stays for anything still reading the old shape.
    return NextResponse.json({ measurement: front ?? back, front, back });
  }

  const matrixId = (searchParams.get("matrixId") ?? "").trim();
  const upc = (searchParams.get("upc") ?? "").trim();
  if (!matrixId && !upc) {
    return NextResponse.json({ error: "matrixId or upc required" }, { status: 400 });
  }
  if (matrixId && !UUID_RE.test(matrixId)) {
    return NextResponse.json({ error: "matrixId must be a uuid" }, { status: 400 });
  }

  /* By UPC, a code can land on either level: the matrix carries one and so does
     every SKU. Both are accepted because a scan does not know the difference —
     the operator just pointed the camera at a label. */
  const found = await pool.query<{
    id: string; upc: string | null; description: string | null; vendor: string | null;
    category: string | null; subcategory_1: string | null;
  }>(
    matrixId
      ? `SELECT id, upc, description, vendor, category, subcategory_1 FROM matrices WHERE id = $1::uuid`
      : `SELECT m.id, m.upc, m.description, m.vendor, m.category, m.subcategory_1
           FROM matrices m
          WHERE m.upc = $1
             OR EXISTS (SELECT 1 FROM custom_skus cs
                         WHERE cs.matrix_id = m.id AND cs.archived = false AND cs.upc = $1)
          ORDER BY (m.upc = $1) DESC
          LIMIT 1`,
    [matrixId || upc],
  );
  const item = found.rows[0];
  if (!item) return NextResponse.json({ error: "No item with that code." }, { status: 404 });

  const sizes = await pool.query<{
    custom_sku_id: string;
    sku: string;
    size: string | null;
    color_code: string | null;
    upc: string | null;
    sort_order: number | null;
    last_measured_at: string | null;
  }>(
    `SELECT cs.id AS custom_sku_id, cs.sku, cs.size, cs.color_code, cs.upc, cs.sort_order,
            (SELECT max(measured_at) FROM size_grading_measurements g WHERE g.custom_sku_id = cs.id)
              AS last_measured_at
       FROM custom_skus cs
      WHERE cs.matrix_id = $1::uuid AND cs.archived = false
      ORDER BY cs.sort_order NULLS LAST, cs.size, cs.sku`,
    [item.id],
  );

  return NextResponse.json({
    /* The category travels with the item so the page can start on the right
       garment family instead of inferring it from the silhouette and being
       corrected — the catalogue already knows this product is a pair of pants. */
    item: {
      matrixId: item.id, upc: item.upc, name: item.description, vendor: item.vendor,
      category: item.category, subcategory: item.subcategory_1,
    },
    sizes: sizes.rows,
  });
}

const Body = z.object({
  customSkuId: z.string().regex(UUID_RE),
  garmentType: z.string().min(1).max(32),
  /** Point of measure → centimetres. */
  pointsCm: z.record(z.string(), z.number().finite().positive()),
  pxPerCm: z.number().finite().positive().optional(),
  typeOverridden: z.boolean().optional(),
  /** Which side of the garment was photographed. */
  view: z.enum(["front", "back"]).optional(),
  note: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }
  const b = parsed.data;
  if (!Object.keys(b.pointsCm).length) {
    return NextResponse.json({ error: "No measurements to save." }, { status: 400 });
  }

  const sku = await pool.query<{ id: string; matrix_id: string; size: string | null }>(
    `SELECT id, matrix_id, size FROM custom_skus WHERE id = $1::uuid AND archived = false`,
    [b.customSkuId],
  );
  const picked = sku.rows[0];
  if (!picked) return NextResponse.json({ error: "That size no longer exists." }, { status: 404 });

  /* Every colour of this size on this product. A null size matches only itself
     — a SKU with no size recorded cannot be grouped with anything safely. */
  const targets = await pool.query<{ id: string; color_code: string | null }>(
    picked.size === null
      ? `SELECT id, color_code FROM custom_skus WHERE id = $1::uuid`
      : `SELECT id, color_code FROM custom_skus
          WHERE matrix_id = $2::uuid AND archived = false
            AND size IS NOT DISTINCT FROM $3`,
    picked.size === null ? [picked.id] : [picked.id, picked.matrix_id, picked.size],
  );

  /* Appended, never updated: a garment remeasured after a production change is
     a new fact about a new garment, not a correction of the old reading. */
  const ids = targets.rows.map((r) => r.id);
  const saved = await pool.query<{ measured_at: string }>(
    `INSERT INTO size_grading_measurements
       (custom_sku_id, garment_type, points_cm, px_per_cm, type_overridden, measured_by, note, view)
     SELECT unnest($1::uuid[]), $2, $3::jsonb, $4, $5, $6, $7, $8
     RETURNING measured_at`,
    [
      ids,
      b.garmentType,
      JSON.stringify(b.pointsCm),
      b.pxPerCm ?? null,
      b.typeOverridden ?? false,
      session.sub ?? null,
      b.note ?? null,
      b.view ?? "front",
    ],
  );

  return NextResponse.json({
    ok: true,
    measuredAt: saved.rows[0]?.measured_at ?? new Date().toISOString(),
    view: b.view ?? "front",
    size: picked.size,
    appliedTo: ids.length,
    colors: targets.rows.map((r) => r.color_code).filter(Boolean),
  });
}
