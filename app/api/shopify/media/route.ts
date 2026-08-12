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
  appendMediaToVariant,
} from "@/lib/server/shopify-write";

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

  // 1) Create new media (stage → createProductMedia) and build the final order
  //    + per-image variant assignments.
  const finalOrder: string[] = [];
  const variantAssignments: Array<{ mediaId: string; variantId: string }> = [];
  const keptExisting = new Set<string>();
  for (const it of items) {
    let mediaId = "";
    if (it.kind === "existing") {
      mediaId = it.mediaId;
      keptExisting.add(it.mediaId);
    } else {
      const bytes = new Uint8Array(Buffer.from(it.b64, "base64"));
      const staged = await stageImageUpload(ctx, `studio-${Date.now()}.png`, "image/png", bytes);
      if (!staged.ok) {
        warnings.push(`stage: ${staged.error}`);
        continue;
      }
      const media = await createProductMedia(ctx, productId, staged.resourceUrl, it.alt || "");
      if (!media.ok) {
        warnings.push(`create: ${media.error}`);
        continue;
      }
      mediaId = media.mediaId;
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
  for (const a of assigns) {
    const av = await appendMediaToVariant(ctx, productId, a.variantId, a.mediaId);
    if (!av.ok) warnings.push(`variant image: ${av.error}`);
  }

  return NextResponse.json({ ok: true, media: await listProductMedia(ctx, productId), warnings });
}
