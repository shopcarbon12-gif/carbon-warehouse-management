/**
 * WMS → Shopify image push (M2). "Gap-fill" per your decision: an image is
 * pushed only when the target has no Shopify image yet (unless `force`).
 * Bytes are staged on Shopify (staged uploads), turned into product media,
 * attached to the colour's variant, and the final Shopify CDN url is stored on
 * the WMS row. Nothing is kept locally.
 *
 * Requires the product + variant to already exist on Shopify (i.e. published
 * via M1) — media attaches to a product/variant.
 */
import type { Pool } from "pg";
import {
  resolveShopContext,
  stageImageUpload,
  createProductMedia,
  appendMediaToVariant,
} from "@/lib/server/shopify-write";

export type ImagePushResult = { ok: boolean; imageUrl?: string; skipped?: boolean; error?: string };

export async function pushVariantImage(
  pool: Pool,
  args: {
    matrixId: string;
    customSkuId: string;
    bytes: Uint8Array;
    mimeType: string;
    filename: string;
    alt?: string;
    force?: boolean;
  },
): Promise<ImagePushResult> {
  const row = await pool.query<{
    shopify_product_id: string | null;
    shopify_variant_id: string | null;
    shopify_image_url: string | null;
    description: string | null;
    color_code: string | null;
  }>(
    `SELECT m.shopify_product_id, cs.shopify_variant_id, cs.shopify_image_url,
            m.description, cs.color_code
       FROM custom_skus cs
       JOIN matrices m ON m.id = cs.matrix_id
      WHERE cs.id = $1::uuid AND cs.matrix_id = $2::uuid`,
    [args.customSkuId, args.matrixId],
  );
  const r = row.rows[0];
  if (!r) return { ok: false, error: "Variant not found." };
  if (!r.shopify_product_id || !r.shopify_variant_id) {
    return { ok: false, error: "Publish the product to Shopify first (no Shopify product/variant id)." };
  }
  // Gap-fill: skip if the variant already has a Shopify image.
  if (r.shopify_image_url && !args.force) {
    return { ok: true, imageUrl: r.shopify_image_url, skipped: true };
  }

  const ctx = await resolveShopContext();
  if (!ctx) return { ok: false, error: "Shopify not connected." };

  const staged = await stageImageUpload(ctx, args.filename, args.mimeType, args.bytes);
  if (!staged.ok) return { ok: false, error: staged.error };

  const alt =
    (args.alt || "").trim() ||
    [r.description, r.color_code].filter(Boolean).join(" — ") ||
    args.filename;

  const media = await createProductMedia(ctx, r.shopify_product_id, staged.resourceUrl, alt);
  if (!media.ok) return { ok: false, error: media.error };

  const attach = await appendMediaToVariant(
    ctx,
    r.shopify_product_id,
    r.shopify_variant_id,
    media.mediaId,
  );
  // Non-fatal: the media exists on the product even if variant-append fails.
  const warn = attach.ok ? "" : ` (variant attach warning: ${attach.error})`;

  await pool.query(
    `UPDATE custom_skus
        SET shopify_image_url = $2, shopify_media_id = $3, shopify_images_synced_at = now()
      WHERE id = $1::uuid`,
    [args.customSkuId, media.imageUrl, media.mediaId],
  );

  return { ok: true, imageUrl: media.imageUrl, skipped: false, error: warn.trim() || undefined };
}
