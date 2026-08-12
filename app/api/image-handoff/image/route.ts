import { findHandoffImage } from "@/lib/image-handoff-store";
import { downloadStorageObject } from "@/lib/storageProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Display proxy for a phone-hand-off image. The uploaded photo lives in R2 at
 * the authenticated S3 endpoint (not browser-fetchable), so the desktop shows
 * it through here. Public but scoped: only serves an image that belongs to a
 * live hand-off session (looked up by session id + image id).
 *
 * GET ?s=<sessionId>&i=<imageId>
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const s = url.searchParams.get("s") || "";
  const i = url.searchParams.get("i") || "";
  const img = findHandoffImage(s, i);
  if (!img) return new Response("Not found", { status: 404 });
  try {
    const { body, contentType } = await downloadStorageObject(img.path);
    return new Response(Buffer.from(body), {
      status: 200,
      headers: { "Content-Type": contentType || "image/jpeg", "Cache-Control": "private, max-age=600" },
    });
  } catch {
    return new Response("Image unavailable", { status: 502 });
  }
}
