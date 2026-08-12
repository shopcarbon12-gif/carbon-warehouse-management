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
  shopify_product_id: string | null;
  shopify_sync_status: string | null;
  /** Full Shopify product gallery (ordered cdn.shopify.com URLs) for the matrix window. */
  image_urls: string[];
  /** Shopify featured image (or gallery[0]); convenience for a hero/thumbnail. */
  featured_image_url: string | null;
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
  shopify_variant_id: string | null;
  shopify_image_url: string | null;
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

  const m = await pool.query<
    Omit<MatrixHeader, "image_urls" | "featured_image_url"> & {
      all_archived: boolean;
      image_urls: string[] | null;
      featured_image_url: string | null;
    }
  >(
    `SELECT
       m.id::text                  AS id,
       m.ls_system_id::text        AS ls_system_id,
       m.description               AS description,
       m.brand                     AS brand,
       m.vendor                    AS vendor,
       m.category                  AS category,
       m.subcategory_1             AS subcategory_1,
       m.upc                       AS upc,
       m.shopify_product_id        AS shopify_product_id,
       m.shopify_sync_status       AS shopify_sync_status,
       m.shopify_image_urls        AS image_urls,
       m.shopify_featured_image_url AS featured_image_url,
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
    shopify_variant_id: string | null;
    shopify_image_url: string | null;
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
       cs.shopify_variant_id   AS shopify_variant_id,
       cs.shopify_image_url    AS shopify_image_url,
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
      shopify_product_id: head.shopify_product_id ?? null,
      shopify_sync_status: head.shopify_sync_status ?? null,
      image_urls: Array.isArray(head.image_urls) ? head.image_urls : [],
      featured_image_url: head.featured_image_url ?? null,
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
      shopify_variant_id: r.shopify_variant_id,
      shopify_image_url: r.shopify_image_url,
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

/**
 * POST → create ONE new variant (custom_sku) under this matrix. Used by the
 * matrix editor when the operator adds a new color/size combination. New rows
 * are WMS-native: they get a negative ls_system_id (the manual/CSV space, kept
 * out of Lightspeed's positive range) so a stray LS sync can't collide. SKU is
 * required and unique. Admin-only.
 */
const createVariantSchema = z.object({
  sku: z.string().trim().min(1).max(100),
  color_code: nullableText(100),
  size: nullableText(50),
  upc: nullableText(100),
  retail_price: z.number().nonnegative().max(1_000_000).nullable().optional(),
  default_cost: z.number().nonnegative().max(1_000_000).nullable().optional(),
});

export async function POST(req: Request, { params }: Ctx) {
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
  const parsed = createVariantSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }
  const d = parsed.data;

  // Confirm the matrix exists (FK would catch it, but a clean 404 is nicer).
  const m = await pool.query(`SELECT 1 FROM matrices WHERE id = $1::uuid`, [id]);
  if (m.rowCount === 0) {
    return NextResponse.json({ error: "Matrix not found" }, { status: 404 });
  }

  // Next free negative ls_system_id — mirrors lib/server/catalog-manual.ts.
  const lsRow = await pool.query<{ n: string }>(
    `SELECT (COALESCE(MIN(ls_system_id), 0) - 1)::text AS n
       FROM custom_skus WHERE ls_system_id < 0`,
  );
  let lsId = Number(lsRow.rows[0]?.n);
  if (!Number.isFinite(lsId) || lsId >= 0) lsId = -1_000_000_000_000_000;

  try {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO custom_skus
         (matrix_id, sku, ls_system_id, color_code, size, retail_price, default_cost, upc, archived)
       VALUES ($1::uuid, $2, $3::bigint, $4, $5, $6::numeric, $7::numeric, $8, FALSE)
       RETURNING id::text`,
      [
        id,
        d.sku,
        lsId,
        d.color_code ?? null,
        d.size ?? null,
        d.retail_price ?? null,
        d.default_cost ?? null,
        d.upc ?? null,
      ],
    );
    return NextResponse.json({ ok: true, id: r.rows[0]?.id });
  } catch (e) {
    if ((e as { code?: string })?.code === "23505") {
      return NextResponse.json(
        { error: `SKU "${d.sku}" is already in use by another item.` },
        { status: 409 },
      );
    }
    console.error("[matrices POST variant]", e);
    return NextResponse.json({ error: "Create failed" }, { status: 500 });
  }
}
