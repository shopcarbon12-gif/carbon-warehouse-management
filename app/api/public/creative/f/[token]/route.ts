/**
 * GET /api/public/creative/f/<signed token> — ONE CARBON file for the AI engines (fal.ai, OpenAI)
 * and the render worker: an HMAC-signed, expiring link (lib/server/creative/storage.ts). Only
 * creative/ and models/ paths, never Radar media (other brands' ads stay private).
 */
import { verifySigned, getFile } from "@/lib/server/creative/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { token } = await params;
  const path = verifySigned(token);
  if (!path) return new Response("Not found", { status: 404 });
  try {
    const f = await getFile(path);
    return new Response(new Uint8Array(f.bytes), { headers: { "Content-Type": f.contentType, "Cache-Control": "private, max-age=600" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
