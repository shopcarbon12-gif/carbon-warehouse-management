/**
 * GET /api/public/email-media/designs/<designId>/v-<stamp>/<file> — the
 * pictures inside sent emails (mail apps fetch them). Public (proxy.ts);
 * only paths under email/designs/<uuid>/v-…/ are served, never attachments.
 */
import { downloadStorageObject } from "@/lib/storageProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ path: string[] }> };

const OK = /^designs\/[0-9a-f-]{36}\/v-[a-z0-9]+\/[A-Za-z0-9._-]+\.(jpg|png)$/;

export async function GET(_req: Request, { params }: Ctx) {
  const { path } = await params;
  const rel = path.join("/");
  if (!OK.test(rel)) return new Response("Not found", { status: 404 });
  try {
    const obj = await downloadStorageObject(`email/${rel}`);
    return new Response(obj.body, {
      headers: {
        "Content-Type": rel.endsWith(".png") ? "image/png" : "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
