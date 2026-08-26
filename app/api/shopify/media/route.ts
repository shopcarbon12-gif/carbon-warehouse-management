import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import {
  resolveShopContext,
  listProductMedia,
  deleteProductMedia,
  updateMediaAlt,
  reorderProductMedia,
  createProductMedia,
  stageImageUpload,
  appendMediaToVariants,
  createProductMediaBatch,
  detachMediaFromVariants,
  listVariantMedia,
  stageImageUploads,
  type StagedFile,
} from "@/lib/server/shopify-write";
import { syncShopifyImagesForMatrix } from "@/lib/server/shopify-catalog-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

/**
 * Carbon Studio media manager (matches carbon-gen's Publish step).
 *
 * GET  ?matrixId=  → { media: [{ id, url, alt }] }  (current Shopify media)
 *
 * POST { matrixId, items:[ {kind:"existing",mediaId,alt} | {kind:"new",b64,alt} ],
 *        heroVariantId? }
 *   Declarative: `items` is the DESIRED final ordered gallery (index 0 = hero).
 *   Creates new images, deletes existing ones you removed, updates alt text,
 *   reorders to match, and (optionally) sets the hero as the colour's variant
 *   image. Quantity/price/etc. are never touched.
 */
type Item =
  | { kind: "existing"; mediaId: string; alt?: string; variantId?: string; variantIds?: string[] }
  | { kind: "new"; b64: string; alt?: string; variantId?: string; variantIds?: string[] };

/** Detect the real image type from magic bytes so Shopify staging isn't told
 * "image/png" for a JPEG/WebP (mislabeled uploads can fail to ingest). */
function sniffImage(bytes: Uint8Array): { mime: string; ext: string } {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return { mime: "image/webp", ext: "webp" };
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return { mime: "image/gif", ext: "gif" };
  return { mime: "image/png", ext: "png" };
}

async function resolveProductId(pool: ReturnType<typeof getPool>, matrixId: string) {
  const r = await pool!.query<{ shopify_product_id: string | null }>(
    `SELECT shopify_product_id FROM matrices WHERE id = $1::uuid`,
    [matrixId],
  );
  return r.rows[0]?.shopify_product_id || null;
}

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const matrixId = new URL(req.url).searchParams.get("matrixId")?.trim();
  if (!matrixId) return NextResponse.json({ error: "matrixId required" }, { status: 400 });
  const productId = await resolveProductId(pool, matrixId);
  if (!productId) return NextResponse.json({ media: [] });
  const ctx = await resolveShopContext();
  if (!ctx) return NextResponse.json({ error: "Shop not connected." }, { status: 401 });
  return NextResponse.json({ media: await listProductMedia(ctx, productId) });
}

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as {
    matrixId?: string;
    items?: Item[];
    heroVariantId?: string;
  };
  const matrixId = body.matrixId?.trim();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!matrixId) return NextResponse.json({ error: "matrixId required" }, { status: 400 });

  const productId = await resolveProductId(pool, matrixId);
  if (!productId) return NextResponse.json({ error: "Publish the product to Shopify first." }, { status: 422 });
  const ctx = await resolveShopContext();
  if (!ctx) return NextResponse.json({ error: "Shop not connected." }, { status: 401 });

  const warnings: string[] = [];
  const current = await listProductMedia(ctx, productId);

  // 1) Create ALL new media in one pass — one stagedUploadsCreate, parallel
  //    byte uploads, one productCreateMedia, one status poll per round —
  //    instead of stage→create→poll per image in series (was 3-5 s × N).
  //    Warning prefixes ("stage:" / "create:") are contractual: the client
  //    classifies them as hard failures vs benign notes.
  const finalOrder: string[] = [];
  const variantAssignments: Array<{ mediaId: string; variantId: string }> = [];
  const keptExisting = new Set<string>();
  const newMediaIdByIndex = new Map<number, string>();
  {
    const toStage: Array<{ index: number; file: StagedFile; alt: string }> = [];
    const stamp = Date.now();
    items.forEach((it, index) => {
      if (it.kind !== "new") return;
      const bytes = new Uint8Array(Buffer.from(it.b64, "base64"));
      if (!bytes.byteLength) {
        warnings.push("create: empty image data");
        return;
      }
      const sniff = sniffImage(bytes);
      toStage.push({ index, file: { filename: `studio-${stamp}-${index}.${sniff.ext}`, mimeType: sniff.mime, bytes }, alt: it.alt || "" });
    });
    const staged = await stageImageUploads(ctx, toStage.map((t) => t.file));
    const toCreate: Array<{ index: number; source: string; alt: string }> = [];
    staged.forEach((s, i) => {
      if (s.ok) toCreate.push({ index: toStage[i].index, source: s.resourceUrl, alt: toStage[i].alt });
      else warnings.push(`stage: ${s.error}`);
    });
    const created = await createProductMediaBatch(ctx, productId, toCreate.map((c) => ({ source: c.source, alt: c.alt })));
    created.forEach((c, i) => {
      if (c.ok) newMediaIdByIndex.set(toCreate[i].index, c.mediaId);
      else warnings.push(`create: ${c.error}`);
    });
  }
  for (const [index, it] of items.entries()) {
    let mediaId = "";
    if (it.kind === "existing") {
      mediaId = it.mediaId;
      keptExisting.add(it.mediaId);
    } else {
      mediaId = newMediaIdByIndex.get(index) || "";
      if (!mediaId) continue; // failed stage/create — warning already recorded
    }
    finalOrder.push(mediaId);
    // Per-image variant assignment. `variantIds` (all sizes of one colour) takes
    // precedence over the legacy single `variantId`.
    const vids =
      it.variantIds && it.variantIds.length ? it.variantIds : it.variantId ? [it.variantId] : [];
    for (const vid of vids) variantAssignments.push({ mediaId, variantId: vid });
  }

  // 2) Delete existing media the user removed.
  const toDelete = current.filter((m) => !keptExisting.has(m.id)).map((m) => m.id);
  if (toDelete.length) {
    const d = await deleteProductMedia(ctx, productId, toDelete);
    if (!d.ok) warnings.push(`delete: ${d.error}`);
  }

  // 3) Alt updates for kept existing media.
  const altUpdates = items
    .filter((i): i is Extract<Item, { kind: "existing" }> => i.kind === "existing" && typeof i.alt === "string")
    .map((i) => ({ id: i.mediaId, alt: i.alt || "" }));
  if (altUpdates.length) {
    const a = await updateMediaAlt(ctx, productId, altUpdates);
    if (!a.ok) warnings.push(`alt: ${a.error}`);
  }

  // 4) Reorder to the desired order (hero first).
  if (finalOrder.length > 1) {
    const r = await reorderProductMedia(ctx, productId, finalOrder);
    if (!r.ok) warnings.push(`reorder: ${r.error}`);
  }

  // 5) Variant images: per-image assignments, plus the hero→heroVariant
  //    (backward-compatible with Carbon Studio).
  const assigns = [...variantAssignments];
  if (body.heroVariantId && finalOrder[0] && !assigns.some((a) => a.mediaId === finalOrder[0])) {
    assigns.push({ mediaId: finalOrder[0], variantId: body.heroVariantId });
  }
  // A Shopify variant holds at most ONE media, and productVariantAppendMedia
  // rejects a variant that already has one — which is exactly the state after
  // the first publish (hero attached). Without a detach the operator's pick of
  // a different image silently stayed a warning and Shopify/WMS never changed.
  // Now: skip when unchanged, detach the current media first when different.
  const currentVariantMedia = assigns.length ? await listVariantMedia(ctx, productId) : new Map<string, string | null>();
  const asVariantGid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id}`);
  // Batched: ONE detach call + ONE append call for every variant that changes
  // (was one round-trip per variant, i.e. per size).
  const detaches: Array<{ variantId: string; mediaId: string }> = [];
  const appends: Array<{ variantId: string; mediaId: string }> = [];
  for (const a of assigns) {
    const cur = currentVariantMedia.get(asVariantGid(a.variantId)) ?? currentVariantMedia.get(a.variantId) ?? null;
    if (cur === a.mediaId) continue;
    if (cur) detaches.push({ variantId: a.variantId, mediaId: cur });
    appends.push({ variantId: a.variantId, mediaId: a.mediaId });
  }
  if (detaches.length) {
    const dt = await detachMediaFromVariants(ctx, productId, detaches);
    if (!dt.ok) warnings.push(`variant image (detach old): ${dt.error}`);
  }
  if (appends.length) {
    const av = await appendMediaToVariants(ctx, productId, appends);
    if (!av.ok) warnings.push(`variant image: ${av.error}`);
  }

  // Auto-writeback: pull the just-published Shopify links back into WMS —
  // matrix gallery (matrices.shopify_image_urls) + per-variant colour image
  // (custom_skus.shopify_image_url). No manual "sync images" step needed.
  let imageWriteback: { variantsMatched: number; galleryCount: number } | null = null;
  try {
    const sync = await syncShopifyImagesForMatrix(pool, matrixId, productId);
    if (sync.ok) {
      imageWriteback = { variantsMatched: sync.variantsMatched, galleryCount: sync.galleryCount };
    } else {
      warnings.push(`image writeback: ${sync.reason ?? "skipped"}`);
    }
  } catch (e) {
    warnings.push(`image writeback: ${e instanceof Error ? e.message : "failed"}`);
  }

  return NextResponse.json({
    ok: true,
    media: await listProductMedia(ctx, productId),
    warnings,
    imageWriteback,
  });
}
