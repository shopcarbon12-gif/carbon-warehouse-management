import type { Pool } from "pg";
import { resolveShopContext, setMetafields } from "@/lib/server/shopify-write";

/**
 * Model profiles — the people in CARBON's product photos (migration 0108).
 *
 * Each product records which model is in its photos and a line for the product
 * page: `Model is 5'8" and wears size S`. The line goes to Shopify as the
 * metafield custom.model_info and the measurements as custom.model_measurements.
 * Neither is rendered by the theme yet (owner, 2026-10-11: publish it hidden;
 * the size worn is refined once each item's own measurements exist).
 *
 * Sources of the assignment (matrices.model_source):
 *   studio   — set when Studio publishes images it generated with that model
 *   photos   — backfilled from face matching over the live product photos
 *   manual   — chosen in Matrix → Matrix tab
 */

export type ModelProfile = {
  id: string;
  code: string;
  label: string;
  kind: "ai" | "real";
  studio_model_name: string | null;
  gender: "female" | "male";
  height: string;
  height_cm: number;
  bust_or_chest_in: string | null;
  waist_in: string | null;
  hips_in: string | null;
  size: string | null;
  jeans_waist: string | null;
  height_source: string;
  photos_being_replaced: boolean;
};

const COLS = `id::text, code, label, kind, studio_model_name, gender, height, height_cm,
  bust_or_chest_in::text, waist_in::text, hips_in::text, size, jeans_waist, height_source, photos_being_replaced`;

export async function listModelProfiles(pool: Pool): Promise<ModelProfile[]> {
  const r = await pool.query<ModelProfile>(`SELECT ${COLS} FROM model_profiles ORDER BY gender, code`);
  return r.rows;
}

export async function profileById(pool: Pool, id: string): Promise<ModelProfile | null> {
  const r = await pool.query<ModelProfile>(`SELECT ${COLS} FROM model_profiles WHERE id = $1::uuid`, [id]);
  return r.rows[0] ?? null;
}

/** The profile for a Studio model by its name ("Latina", "Rico"…), if one exists. */
export async function profileForStudioModel(pool: Pool, name: string): Promise<ModelProfile | null> {
  const n = String(name || "").trim();
  if (!n) return null;
  const r = await pool.query<ModelProfile>(
    `SELECT ${COLS} FROM model_profiles WHERE lower(studio_model_name) = lower($1) LIMIT 1`,
    [n],
  );
  return r.rows[0] ?? null;
}

/**
 * The size worn, as a single size. A profile's usual size can be a range
 * ("XS–S", "S–M"); a product line needs one size, so the smaller of the two is
 * used until the item's measurements say otherwise.
 */
export function sizeWorn(profile: ModelProfile): string {
  const s = String(profile.size || "").trim();
  return s.split(/[–-]/)[0]?.trim() || s;
}

export function modelLine(profile: ModelProfile, size?: string | null): string {
  const worn = String(size || "").trim() || sizeWorn(profile);
  return worn ? `Model is ${profile.height} and wears size ${worn}` : `Model is ${profile.height}`;
}

/** The measurements, as the JSON stored in custom.model_measurements. */
export function measurementsJson(profile: ModelProfile): Record<string, string> {
  const inch = (v: string | null) => (v ? `${Number(v)}"` : "");
  const out: Record<string, string> = { height: profile.height };
  const bc = inch(profile.bust_or_chest_in);
  if (bc) out[profile.gender === "female" ? "bust" : "chest"] = bc;
  const w = inch(profile.waist_in);
  if (w) out.waist = w;
  const h = inch(profile.hips_in);
  if (h) out.hips = h;
  if (profile.size) out.usual_size = profile.size;
  return out;
}

/**
 * Record the model on a matrix and push the hidden metafields to its Shopify
 * product. The size worn is kept when it was already refined for this matrix
 * and the model did not change.
 */
export async function setMatrixModel(
  pool: Pool,
  matrixId: string,
  profile: ModelProfile,
  source: "studio" | "photos" | "manual",
  opts: { sizeWorn?: string | null; push?: boolean } = {},
): Promise<{ line: string; pushed: boolean; warning?: string }> {
  const cur = await pool.query<{ model_profile_id: string | null; model_size_worn: string | null; shopify_product_id: string | null }>(
    `SELECT model_profile_id::text, model_size_worn, shopify_product_id FROM matrices WHERE id = $1::uuid`,
    [matrixId],
  );
  const row = cur.rows[0];
  if (!row) return { line: "", pushed: false, warning: "matrix not found" };
  const keepSize = row.model_profile_id === profile.id && row.model_size_worn;
  const size = String(opts.sizeWorn || "").trim() || (keepSize ? String(row.model_size_worn) : sizeWorn(profile));
  const line = modelLine(profile, size);
  await pool.query(
    `UPDATE matrices SET model_profile_id = $2::uuid, model_size_worn = $3, model_line = $4, model_source = $5 WHERE id = $1::uuid`,
    [matrixId, profile.id, size, line, source],
  );
  if (opts.push === false || !row.shopify_product_id) return { line, pushed: false };
  const pushed = await pushModelMetafields(row.shopify_product_id, line, measurementsJson(profile));
  return { line, pushed: pushed.ok, warning: pushed.error };
}

/** Write custom.model_info and custom.model_measurements. Not rendered by the theme. */
export async function pushModelMetafields(
  productId: string,
  line: string,
  measurements: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveShopContext();
  if (!ctx) return { ok: false, error: "Shop not connected" };
  const gid = productId.startsWith("gid://") ? productId : `gid://shopify/Product/${productId}`;
  const res = await setMetafields(ctx, [
    { ownerId: gid, namespace: "custom", key: "model_info", type: "single_line_text_field", value: line },
    { ownerId: gid, namespace: "custom", key: "model_measurements", type: "json", value: JSON.stringify(measurements) },
  ]);
  if (!res.ok) return { ok: false, error: res.error };
  if (res.warnings?.length) return { ok: false, error: res.warnings.join("; ") };
  return { ok: true };
}
