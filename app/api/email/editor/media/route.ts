import { withActivity } from "@/lib/server/activity-log";
/**
 * GET  /api/email/editor/media — pictures for the image picker: uploads, the CARBON logo, the
 *      store photos and the brand pictures from Shopify Files.
 * POST /api/email/editor/media — upload a picture (multipart "file", 10 MB max).
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { imageLibrary, uploadImage } from "@/lib/server/email/editor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  return NextResponse.json({ images: await imageLibrary(g.pool, g.session.tid) });
}

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const form = await req.formData().catch(() => null);
  const f = form?.get("file");
  if (!f || typeof f === "string") return NextResponse.json({ error: "Choose a picture" }, { status: 400 });
  if (f.size > 10 * 1024 * 1024) return NextResponse.json({ error: "The picture is over 10 MB" }, { status: 400 });
  try {
    const img = await uploadImage(g.pool, g.session.tid, g.session.email ?? null, { name: f.name, bytes: Buffer.from(await f.arrayBuffer()) });
    return NextResponse.json({ image: img });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const POST = withActivity("email/editor/media", POST_handler);
