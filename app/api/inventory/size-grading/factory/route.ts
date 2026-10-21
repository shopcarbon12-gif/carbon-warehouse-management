import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

/**
 * A product's factory size sheet, one size at a time (owner, 2026-10-20).
 *
 * GET  ?customSkuId=<uuid>  → { size, pointsCm, note, updatedAt } for that SKU's product and size
 * POST { customSkuId, pointsCm, note? } → saves it for the product and size (every colour)
 *
 * It is the factory's target, not a measurement: nothing here is written to the
 * items. CarbonGradingAI compares each new scan with it and flags a point that
 * is far off (lib/server/grading-app.ts › factoryDiffs).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function skuOf(pool: NonNullable<ReturnType<typeof getPool>>, id: string) {
  const r = await pool.query<{ matrix_id: string; size: string | null }>(`SELECT matrix_id, size FROM custom_skus WHERE id = $1::uuid`, [id]);
  return r.rows[0] ?? null;
}

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const id = new URL(req.url).searchParams.get("customSkuId") ?? "";
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "customSkuId required" }, { status: 400 });
  const sku = await skuOf(pool, id);
  if (!sku) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!sku.size) return NextResponse.json({ size: null, pointsCm: null });
  const r = await pool.query<{ points_cm: Record<string, number>; note: string | null; updated_at: string }>(
    `SELECT points_cm, note, updated_at FROM size_grading_factory_specs WHERE matrix_id = $1::uuid AND upper(trim(size)) = upper(trim($2))`,
    [sku.matrix_id, sku.size],
  );
  const row = r.rows[0];
  return NextResponse.json({ size: sku.size, pointsCm: row?.points_cm ?? null, note: row?.note ?? null, updatedAt: row?.updated_at ?? null });
}

const Body = z.object({
  customSkuId: z.string().regex(UUID_RE),
  pointsCm: z.record(z.string().max(40), z.number().finite().positive().max(400)),
  note: z.string().trim().max(300).nullish(),
});

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  const sku = await skuOf(pool, parsed.data.customSkuId);
  if (!sku) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!sku.size) return NextResponse.json({ error: "This SKU has no size." }, { status: 400 });
  await pool.query(
    `INSERT INTO size_grading_factory_specs (matrix_id, size, points_cm, note, updated_by)
     VALUES ($1::uuid, upper(trim($2)), $3::jsonb, $4, $5)
     ON CONFLICT (matrix_id, upper(trim(size)))
     DO UPDATE SET points_cm = EXCLUDED.points_cm, note = EXCLUDED.note, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [sku.matrix_id, sku.size, JSON.stringify(parsed.data.pointsCm), parsed.data.note ?? null, session.sub ?? null],
  );
  return NextResponse.json({ ok: true });
}

export const POST = withActivity("inventory/size-grading/factory", POST_handler);
