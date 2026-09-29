/**
 * Display proxy for a stored item-reference photo. Uploads live in R2 at the
 * authenticated S3 endpoint, which the browser cannot load directly — so a
 * reference restored from studio_matrix_state on reload had no thumbnail.
 * Admin-only, and only for URLs that resolve to an object in our bucket.
 *
 * GET ?u=<stored reference url>
 */
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { downloadStorageObject, tryGetStoragePathFromUrl } from "@/lib/storageProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const pool = getPool();
  if (!pool) return new Response("Database unavailable", { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const u = String(new URL(req.url).searchParams.get("u") || "").trim();
  const path = u ? tryGetStoragePathFromUrl(u) : "";
  // Only the two prefixes item references are ever written under — this
  // tenant's desktop uploads and phone hand-off photos — never the bucket at
  // large (model photos, other tenants' references).
  const allowed =
    !!path &&
    (path.startsWith(`carbon-studio/item-refs/${session.tid}/`) || path.startsWith("carbon-studio/handoff/"));
  if (!allowed) return new Response("Not a stored reference", { status: 400 });
  try {
    const { body, contentType } = await downloadStorageObject(path);
    const type = (contentType || "image/jpeg").split(";")[0].trim().toLowerCase();
    // Raster images only: an SVG served inline from this origin would run script.
    if (!/^image\/(jpeg|jpg|png|webp|gif|avif|heic|heif)$/.test(type)) {
      return new Response("Unsupported image type", { status: 415 });
    }
    return new Response(Buffer.from(body), {
      status: 200,
      headers: {
        "Content-Type": type,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("Image unavailable", { status: 502 });
  }
}
