import type { Pool } from "pg";
import { profileForStudioModel } from "@/lib/server/model-profiles";
import {
  chooseSizeFit,
  runFitIntent,
  heightToInches,
  specFitLine,
  type GarmentKind,
  type MeasuredSize,
  type ModelBody,
  type SizeFit,
} from "@/lib/studio-size-fit";

/**
 * The size a Studio model wears for a product, from the product's CarbonGradingAI
 * measurements (lib/studio-size-fit.ts has the rules). null when the product has
 * no measured size or the model has no profile. Remembered per product + model
 * so the Shopify push can record the size worn (studio_size_fits).
 */
export async function studioSizeFit(
  pool: Pool,
  input: { matrixId: string; modelName: string; itemSpec?: string; instruction?: string; itemType?: string; productName?: string },
): Promise<SizeFit | null> {
  const profile = await profileForStudioModel(pool, input.modelName);
  if (!profile) return null;
  /* The newest measurement of each size (all colours of a size share a pattern). */
  const rows = await pool.query<{ size: string | null; garment_type: string; points_cm: Record<string, number>; source: string | null }>(
    `SELECT DISTINCT ON (upper(btrim(c.size))) c.size, m.garment_type, m.points_cm, m.source
       FROM size_grading_measurements m
       JOIN custom_skus c ON c.id = m.custom_sku_id
      WHERE c.matrix_id = $1::uuid AND coalesce(btrim(c.size), '') <> ''
        AND coalesce(m.view, 'front') = 'front'
      -- The product's own numbers (app / graded / web) before a copied size guide.
      ORDER BY upper(btrim(c.size)), (m.source = 'guide') ASC, m.measured_at DESC`,
    [input.matrixId],
  );
  const sizes: MeasuredSize[] = rows.rows
    .filter((r) => ["top", "trousers", "shorts"].includes(r.garment_type) && r.points_cm && typeof r.points_cm === "object")
    .map((r) => ({
      size: String(r.size).trim(),
      kind: r.garment_type as GarmentKind,
      source: r.source ?? undefined,
      cm: Object.fromEntries(Object.entries(r.points_cm).filter(([, v]) => typeof v === "number" && v > 0)) as Record<string, number>,
    }));
  if (!sizes.length) return null;
  const num = (v: string | null) => (v == null || v === "" ? null : Number(v));
  const body: ModelBody = {
    name: profile.studio_model_name || profile.label,
    gender: profile.gender,
    height: profile.height,
    heightIn: heightToInches(profile.height, profile.height_cm),
    chestIn: num(profile.bust_or_chest_in),
    waistIn: num(profile.waist_in),
    hipsIn: num(profile.hips_in),
    inseamIn: num(profile.inseam_in),
    shoulderIn: num(profile.shoulder_in),
    size: profile.size,
    jeansWaist: profile.jeans_waist,
  };
  const fit = chooseSizeFit({
    sizes,
    body,
    intent: runFitIntent(input.instruction, specFitLine(input.itemSpec), input.productName, input.itemType),
    instruction: input.instruction,
    spec: input.itemSpec,
  });
  if (!fit) return null;
  await pool
    .query(
      `INSERT INTO studio_size_fits (matrix_id, model_name, size, basis, summary, computed_at)
       VALUES ($1::uuid, $2, $3, $4, $5, now())
       ON CONFLICT (matrix_id, model_name) DO UPDATE
         SET size = EXCLUDED.size, basis = EXCLUDED.basis, summary = EXCLUDED.summary, computed_at = now()`,
      [input.matrixId, body.name, fit.size, fit.basis, fit.summary],
    )
    .catch(() => {});
  return fit;
}

/** The size a product was last generated in for this model (Shopify push). */
export async function lastStudioSize(pool: Pool, matrixId: string, modelName: string): Promise<string | null> {
  const r = await pool
    .query<{ size: string }>(`SELECT size FROM studio_size_fits WHERE matrix_id = $1::uuid AND lower(model_name) = lower($2)`, [matrixId, modelName])
    .catch(() => ({ rows: [] as { size: string }[] }));
  return r.rows[0]?.size ?? null;
}
