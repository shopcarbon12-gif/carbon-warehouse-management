import { NextResponse } from "next/server";
import { z } from "zod";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";

/**
 * Single-variant catalog operations. Edits the WMS-owned custom_skus row:
 * archive plus the variant attributes surfaced in the item-details popup
 * (sku, color, size, upc, retail_price, default_cost). Matrix-level fields
 * (name/description, brand, category, subcategory_1, matrix upc) live on the
 * matrices row — edit those via /api/inventory/catalog/matrices/[id].
 *
 * Lightspeed is being retired and the WMS is now the source of truth, so
 * these are first-class editable fields (the prior read-only posture existed
 * only because LS sync would overwrite them). Admin-only.
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;

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
    sku: z.string().trim().min(1).max(100).optional(),
    color_code: nullableText(100),
    size: nullableText(50),
    upc: nullableText(100),
    retail_price: z.number().nonnegative().max(1_000_000).nullable().optional(),
    default_cost: z.number().nonnegative().max(1_000_000).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "No fields to update" });

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid custom_sku id" }, { status: 400 });
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

  // Build the SET clause from only the provided fields. $1 is always the id.
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const add = (col: string, val: unknown, cast = "") => {
    vals.push(val);
    sets.push(`${col} = $${vals.length}${cast}`);
  };

  if (d.archived !== undefined) add("archived", d.archived);
  if (d.sku !== undefined) add("sku", d.sku);
  if (d.color_code !== undefined) add("color_code", d.color_code);
  if (d.size !== undefined) add("size", d.size);
  if (d.upc !== undefined) add("upc", d.upc);
  if (d.retail_price !== undefined) add("retail_price", d.retail_price, "::numeric");
  if (d.default_cost !== undefined) add("default_cost", d.default_cost, "::numeric");

  if (sets.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  try {
    const r = await pool.query(
      `UPDATE custom_skus SET ${sets.join(", ")} WHERE id = $1::uuid`,
      vals,
    );
    if (r.rowCount === 0) {
      return NextResponse.json({ error: "Custom SKU not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, updated: r.rowCount });
  } catch (e) {
    // 23505 = unique_violation, i.e. custom_skus_sku_active_uq: only one
    // UNARCHIVED row may hold a given SKU. Unarchiving trips it whenever another
    // product already has that SKU live, which happens because two matrices can
    // share a UPC and a SKU is UPC + colour code + size. Name the product holding
    // it — otherwise the operator sees a dead end with nothing to act on.
    if ((e as { code?: string })?.code === "23505") {
      const conflict = await pool
        .query<{ sku: string; product: string | null }>(
          `SELECT mine.sku, mx.description AS product
             FROM custom_skus mine
             JOIN custom_skus other
               ON other.sku = mine.sku AND other.archived = FALSE AND other.id <> mine.id
             LEFT JOIN matrices mx ON mx.id = other.matrix_id
            WHERE mine.id = $1::uuid
            LIMIT 1`,
          [id],
        )
        .catch(() => null);
      const hit = conflict?.rows[0];
      return NextResponse.json(
        {
          error: hit
            ? `SKU ${hit.sku} is already active on "${hit.product ?? "another product"}". Both products share the same UPC, so they produce the same SKU. Archive it there first, or give this product its own UPC.`
            : "That SKU is already in use by another item.",
        },
        { status: 409 },
      );
    }
    console.error("[custom-skus PATCH]", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
