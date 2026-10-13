import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listCutGroups } from "@/lib/server/grading-app";
import { PROFILE_BY_ID } from "@/lib/size-grading/grading-app-profiles";

/**
 * Cut groups — products that share a pattern, built by the owner (never
 * proposed from suppliers). One garment measured per cut and size covers every
 * product in the cut.
 *
 * GET            → all groups with progress
 * GET ?search=q  → products matching a name / UPC / SKU, with the group each is in
 * POST {name, profile?, note?} → new group
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const q = (new URL(req.url).searchParams.get("search") ?? "").trim();
  if (q) {
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const r = await pool.query(
      `SELECT m.id AS matrix_id, m.description AS name, m.upc, m.vendor, m.category, m.subcategory_1,
              m.shopify_featured_image_url AS image, mm.cut_group_id, g.name AS cut_group,
              (SELECT count(*) FROM custom_skus cs WHERE cs.matrix_id = m.id AND cs.archived = false) AS skus
         FROM matrices m
         LEFT JOIN size_grading_cut_group_members mm ON mm.matrix_id = m.id
         LEFT JOIN size_grading_cut_groups g ON g.id = mm.cut_group_id
        WHERE (m.description ILIKE $1 OR m.upc = $2
               OR EXISTS (SELECT 1 FROM custom_skus cs WHERE cs.matrix_id = m.id AND (upper(cs.sku) = upper($2) OR cs.upc = $2)))
          AND EXISTS (SELECT 1 FROM custom_skus cs WHERE cs.matrix_id = m.id AND cs.archived = false)
        ORDER BY (m.shopify_product_id IS NOT NULL) DESC, m.description
        LIMIT 40`,
      [like, q],
    );
    return NextResponse.json({ products: r.rows });
  }
  return NextResponse.json({ groups: await listCutGroups(pool) });
}

const Create = z.object({
  name: z.string().trim().min(1).max(120),
  profile: z.string().refine((p) => p in PROFILE_BY_ID, "Unknown garment type").nullish(),
  note: z.string().max(500).nullish(),
});

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const parsed = Create.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  const r = await pool.query<{ id: string }>(
    `INSERT INTO size_grading_cut_groups (name, profile, note, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [parsed.data.name, parsed.data.profile ?? null, parsed.data.note ?? null, session.sub ?? null],
  );
  return NextResponse.json({ ok: true, id: r.rows[0].id });
}

export const POST = withActivity("grading-app/cut-groups", POST_handler);
