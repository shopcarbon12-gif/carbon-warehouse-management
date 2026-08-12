/**
 * Pre-publish validation for WMS→Shopify (M1/P1.2).
 *
 * Blocks a publish that would create a wrong or conflicting Shopify product:
 *  - at least one active variant
 *  - every active variant has a SKU and a price
 *  - Color/Size option values are non-null (Shopify rejects null option values)
 *  - no duplicate active SKU within the matrix
 *  - no active SKU collision with a DIFFERENT matrix (the Leroy/Jacob class —
 *    a shared SKU would map two WMS products onto one Shopify variant key)
 */
import type { Pool } from "pg";

export type PublishValidation = { ok: boolean; errors: string[]; warnings: string[] };

export type PublishVariantRow = {
  id: string;
  sku: string | null;
  color_code: string | null;
  size: string | null;
  retail_price: string | null;
};

export async function validateMatrixForPublish(
  pool: Pool,
  matrixId: string,
  variants: PublishVariantRow[],
): Promise<PublishValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const active = variants;
  if (!active.length) {
    errors.push("No active variants to publish.");
    return { ok: false, errors, warnings };
  }

  const seen = new Map<string, number>();
  for (const v of active) {
    const sku = (v.sku || "").trim();
    if (!sku) errors.push(`A variant (${v.color_code ?? "?"} / ${v.size ?? "?"}) has no SKU.`);
    else seen.set(sku.toLowerCase(), (seen.get(sku.toLowerCase()) || 0) + 1);
    if (!(Number(v.retail_price) > 0)) {
      errors.push(`SKU ${sku || "(missing)"} has no price.`);
    }
    // Shopify requires non-null option values when an option exists.
    if (!(v.color_code || "").trim() && active.some((x) => (x.color_code || "").trim())) {
      errors.push(`SKU ${sku || "?"} is missing its Color option value.`);
    }
    if (!(v.size || "").trim() && active.some((x) => (x.size || "").trim())) {
      errors.push(`SKU ${sku || "?"} is missing its Size option value.`);
    }
  }
  for (const [sku, n] of seen) {
    if (n > 1) errors.push(`Duplicate active SKU within this product: ${sku} (${n}×).`);
  }

  // Cross-matrix active SKU collision (Shopify variant key must be unique).
  const skus = active.map((v) => (v.sku || "").trim()).filter(Boolean);
  if (skus.length) {
    const r = await pool.query<{ sku: string }>(
      `SELECT DISTINCT cs.sku
         FROM custom_skus cs
        WHERE cs.archived = FALSE
          AND cs.matrix_id <> $1::uuid
          AND lower(cs.sku) = ANY($2::text[])`,
      [matrixId, skus.map((s) => s.toLowerCase())],
    );
    for (const row of r.rows) {
      errors.push(
        `SKU ${row.sku} is also used by another active product — resolve the duplicate before publishing.`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
