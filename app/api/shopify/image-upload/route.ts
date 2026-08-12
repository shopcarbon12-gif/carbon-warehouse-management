import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { pushVariantImage } from "@/lib/server/shopify-image-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Upload a product image for a variant and push it to Shopify (M2).
 * Gap-fill: only pushes when the variant has no Shopify image (unless force=1).
 * The image is staged on Shopify and its CDN url stored on the WMS row —
 * nothing is kept locally.
 *
 * multipart/form-data: matrixId, customSkuId, [alt], [force=1], file
 * 200: { imageUrl, skipped }
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const matrixId = String(form.get("matrixId") || "").trim();
  const customSkuId = String(form.get("customSkuId") || "").trim();
  const alt = String(form.get("alt") || "").trim();
  const force = String(form.get("force") || "") === "1";
  const file = form.get("file");

  if (!matrixId || !customSkuId) {
    return NextResponse.json({ error: "matrixId and customSkuId required" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  const mimeType = file.type || "image/jpeg";
  if (!/^image\//.test(mimeType)) {
    return NextResponse.json({ error: "file must be an image" }, { status: 400 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "empty file" }, { status: 400 });
  }

  const result = await pushVariantImage(pool, {
    matrixId,
    customSkuId,
    bytes,
    mimeType,
    filename: file.name || "image.jpg",
    alt,
    force,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error || "Image push failed" }, { status: 422 });
  }
  return NextResponse.json({ imageUrl: result.imageUrl, skipped: !!result.skipped });
}
