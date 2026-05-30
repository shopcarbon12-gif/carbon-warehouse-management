import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Categories manager (the /inventory/categories "Legacy" popup).
 *
 *   GET  → the full parent→subcategory tree for the tenant.
 *   POST → create a parent (no parentId) or a subcategory (parentId set).
 *
 * Backed by the WMS-owned `categories` table (migration 0087), seeded once
 * from the categories already present on items. Edits here never touch items
 * or Lightspeed.
 */

type SubRow = { id: string; name: string };
type CategoryRow = { id: string; name: string; subcategories: SubRow[] };

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const r = await pool.query<{ id: string; name: string; subcategories: unknown }>(
    `SELECT
       p.id::text AS id,
       p.name     AS name,
       COALESCE(
         json_agg(
           json_build_object('id', s.id::text, 'name', s.name)
           ORDER BY s.name ASC
         ) FILTER (WHERE s.id IS NOT NULL),
         '[]'::json
       ) AS subcategories
     FROM categories p
     LEFT JOIN categories s ON s.parent_id = p.id
     WHERE p.tenant_id = $1::uuid AND p.parent_id IS NULL
     GROUP BY p.id, p.name
     ORDER BY p.name ASC`,
    [session.tid],
  );

  const categories: CategoryRow[] = r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    subcategories: Array.isArray(row.subcategories) ? (row.subcategories as SubRow[]) : [],
  }));

  return NextResponse.json({ categories }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  let body: { name?: string; parentId?: string | null };
  try {
    body = (await req.json()) as { name?: string; parentId?: string | null };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Category name is required" }, { status: 400 });
  if (name.length > 128)
    return NextResponse.json({ error: "Category name is too long (max 128)" }, { status: 400 });
  const parentId = body.parentId ?? null;

  try {
    if (parentId) {
      // Subcategory: parent must exist, belong to this tenant, and itself be a
      // top-level category (no nesting beyond two levels).
      const parent = await pool.query<{ id: string }>(
        `SELECT id FROM categories
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND parent_id IS NULL`,
        [parentId, session.tid],
      );
      if (parent.rows.length === 0)
        return NextResponse.json({ error: "Parent category not found" }, { status: 404 });

      const ins = await pool.query<{ id: string; name: string }>(
        `INSERT INTO categories (tenant_id, parent_id, name)
           VALUES ($1::uuid, $2::uuid, $3)
         RETURNING id::text, name`,
        [session.tid, parentId, name],
      );
      return NextResponse.json({ category: ins.rows[0] }, { status: 201 });
    }

    const ins = await pool.query<{ id: string; name: string }>(
      `INSERT INTO categories (tenant_id, name)
         VALUES ($1::uuid, $2)
       RETURNING id::text, name`,
      [session.tid, name],
    );
    return NextResponse.json({ category: ins.rows[0] }, { status: 201 });
  } catch (e) {
    if ((e as { code?: string })?.code === "23505") {
      return NextResponse.json(
        { error: parentId ? "A subcategory with that name already exists" : "A category with that name already exists" },
        { status: 409 },
      );
    }
    console.error("[inventory/categories POST]", e);
    return NextResponse.json({ error: "Failed to create category" }, { status: 500 });
  }
}
