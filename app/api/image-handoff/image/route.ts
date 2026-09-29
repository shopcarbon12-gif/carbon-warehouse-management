import { findHandoffImage } from "@/lib/image-handoff-store";
import { downloadStorageObject } from "@/lib/storageProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Display proxy for a phone-hand-off image. The uploaded photo lives in R2 at
 * the authenticated S3 endpoint (not browser-fetchable), so the desktop shows
 * it through here. Public but scoped: only serves an image that belongs to a
 * hand-off session (looked up by session id + image id).
 *
 * GET ?s=<sessionId>&i=<imageId>
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const s = url.searchParams.get("s") || "";
  const i = url.searchParams.get("i") || "";
  let img;
  try {
    img = await findHandoffImage(s, i);
  } catch {
    return new Response("Database unavailable", { status: 503 });
  }
  if (!img) return new Response("Not found", { status: 404 });
  try {
    const { body, contentType } = await downloadStorageObject(img.path);
    const type = (contentType || "image/jpeg").split(";")[0].trim().toLowerCase();
    return new Response(Buffer.from(body), {
      status: 200,
      headers: {
        "Content-Type": /^image\/(jpeg|jpg|png|webp|gif|avif|heic|heif)$/.test(type) ? type : "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=600",
      },
    });
  } catch {
    return new Response("Image unavailable", { status: 502 });
  }
}
