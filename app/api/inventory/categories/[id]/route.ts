import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Single category (parent OR subcategory) for the /inventory/categories popup.
 *
 *   PATCH  → rename. (Save Changes in the parent/subcategory form.)
 *   DELETE → remove. Deleting a parent cascades to its subcategories via the
 *            FK ON DELETE CASCADE on categories.parent_id.
 *
 * Both are tenant-scoped: the row must belong to the caller's tenant or it's a
 * 404. Edits never touch items or Lightspeed.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await params;

  let body: { name?: string };
  try {
    body = (await req.json()) as { name?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Category name is required" }, { status: 400 });
  if (name.length > 128)
    return NextResponse.json({ error: "Category name is too long (max 128)" }, { status: 400 });

  try {
    const upd = await pool.query<{ id: string; name: string }>(
      `UPDATE categories
          SET name = $1, updated_at = now()
        WHERE id = $2::uuid AND tenant_id = $3::uuid
      RETURNING id::text, name`,
      [name, id, session.tid],
    );
    if (upd.rows.length === 0)
      return NextResponse.json({ error: "Category not found" }, { status: 404 });
    return NextResponse.json({ category: upd.rows[0] });
  } catch (e) {
    if ((e as { code?: string })?.code === "23505") {
      return NextResponse.json({ error: "A category with that name already exists" }, { status: 409 });
    }
    console.error("[inventory/categories PATCH]", e);
    return NextResponse.json({ error: "Failed to rename category" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await params;

  const del = await pool.query(
    `DELETE FROM categories WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, session.tid],
  );
  if (del.rowCount === 0)
    return NextResponse.json({ error: "Category not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
