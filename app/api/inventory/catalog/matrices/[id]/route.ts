import { NextResponse } from "next/server";
import { z } from "zod";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";

/**
 * Matrix detail + bulk operations — powers the Lightspeed-style matrix
 * popup in the catalog. The popup needs ONE round-trip for both the
 * matrix header (description / brand / category / etc.) and every variant
 * under it with full pricing/cost/UPC, so the GET returns both.
 *
 * GET    → { matrix, variants[] } at the operator's active location.
 *          active_epc_count is filtered to the active location only.
 * PATCH  → any of:
 *            archived: boolean           — flips archived on every variant
 *            description, brand, vendor, — matrix-header attribute edits
 *            category, subcategory_1, upc
 *          Admin-only. Lightspeed is being retired and the WMS is now the
 *          source of truth, so matrix attributes are editable here (they
 *          were read-only before only because LS sync would overwrite them).
 *          Per-variant attribute edits go through
 *          /api/inventory/catalog/custom-skus/[id].
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;

type MatrixHeader = {
  id: string;
  ls_system_id: string | null;
  description: string;
  brand: string | null;
  vendor: string | null;
  category: string | null;
  subcategory_1: string | null;
  upc: string | null;
  archived: boolean;
};

type MatrixVariant = {
  id: string;
  sku: string;
  ls_system_id: string | null;
  color: string | null;
  size: string | null;
  upc: string | null;
  retail_price: string | null;
  default_cost: string | null;
  archived: boolean;
  active_epc_count: number;
};

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid matrix id" }, { status: 400 });
  }

  const m = await pool.query<MatrixHeader & { all_archived: boolean }>(
    `SELECT
       m.id::text                  AS id,
       m.ls_system_id::text        AS ls_system_id,
       m.description               AS description,
       m.brand                     AS brand,
       m.vendor                    AS vendor,
       m.category                  AS category,
       m.subcategory_1             AS subcategory_1,
       m.upc                       AS upc,
       COALESCE(bool_and(cs.archived), FALSE) AS all_archived
     FROM matrices m
     LEFT JOIN custom_skus cs ON cs.matrix_id = m.id
     WHERE m.id = $1::uuid
     GROUP BY m.id`,
    [id],
  );
  if (m.rowCount === 0) {
    return NextResponse.json({ error: "Matrix not found" }, { status: 404 });
  }
  const head = m.rows[0];

  const v = await pool.query<{
    id: string;
    sku: string;
    ls_system_id: string | null;
    color: string | null;
    size: string | null;
    upc: string | null;
    retail_price: string | null;
    default_cost: string | null;
    archived: boolean;
    active_epc_count: string;
  }>(
    `SELECT
       cs.id::text             AS id,
       cs.sku                  AS sku,
       cs.ls_system_id::text   AS ls_system_id,
       cs.color_code           AS color,
       cs.size                 AS size,
       cs.upc                  AS upc,
       cs.retail_price::text   AS retail_price,
       cs.default_cost::text   AS default_cost,
       cs.archived             AS archived,
       (
         SELECT COUNT(*)::text
         FROM items i
         WHERE i.custom_sku_id = cs.id
           AND i.location_id   = $2::uuid
           AND i.status        = 'in-stock'
       ) AS active_epc_count
     FROM custom_skus cs
     WHERE cs.matrix_id = $1::uuid
     ORDER BY cs.color_code NULLS LAST, cs.size NULLS LAST, cs.sku ASC`,
    [id, session.lid],
  );

  return NextResponse.json({
    matrix: {
      id: head.id,
      ls_system_id: head.ls_system_id,
      description: head.description,
      brand: head.brand,
      vendor: head.vendor,
      category: head.category,
      subcategory_1: head.subcategory_1,
      upc: head.upc,
      archived: head.all_archived,
    },
    variants: v.rows.map<MatrixVariant>((r) => ({
      id: r.id,
      sku: r.sku,
      ls_system_id: r.ls_system_id,
      color: r.color,
      size: r.size,
      upc: r.upc,
      retail_price: r.retail_price,
      default_cost: r.default_cost,
      archived: r.archived,
      active_epc_count: Number(r.active_epc_count ?? 0),
    })),
  });
}

/** Trimmed string that becomes null when empty (for nullable text columns). */
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === "" ? null : s))
    .nullable()
    .optional();

const patchSchema = z
  .object({
    archived: z.boolean().optional(),
    description: z.string().trim().min(1).max(500).optional(),
    brand: nullableText(200),
    vendor: nullableText(200),
    category: nullableText(200),
    subcategory_1: nullableText(200),
    upc: nullableText(100),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "No fields to update" });

export async function PATCH(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid matrix id" }, { status: 400 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }
  const d = parsed.data;
  let updated = 0;

  /* Archive is bulk: touch every variant in this matrix in one statement.
     The WHERE archived <> $2 means re-archiving only counts rows that changed. */
  if (d.archived !== undefined) {
    const r = await pool.query(
      `UPDATE custom_skus
          SET archived = $2
        WHERE matrix_id = $1::uuid
          AND archived <> $2`,
      [id, d.archived],
    );
    updated += r.rowCount ?? 0;
  }

  // Matrix-header attribute edits — only the fields the caller sent.
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const add = (col: string, val: unknown) => {
    vals.push(val);
    sets.push(`${col} = $${vals.length}`);
  };
  if (d.description !== undefined) add("description", d.description);
  if (d.brand !== undefined) add("brand", d.brand);
  if (d.vendor !== undefined) add("vendor", d.vendor);
  if (d.category !== undefined) add("category", d.category);
  if (d.subcategory_1 !== undefined) add("subcategory_1", d.subcategory_1);
  if (d.upc !== undefined) add("upc", d.upc);

  if (sets.length > 0) {
    const r = await pool.query(
      `UPDATE matrices SET ${sets.join(", ")} WHERE id = $1::uuid`,
      vals,
    );
    if (r.rowCount === 0) {
      return NextResponse.json({ error: "Matrix not found" }, { status: 404 });
    }
    updated += r.rowCount ?? 0;
  }

  return NextResponse.json({ ok: true, updated });
}
