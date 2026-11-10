/**
 * GET /api/creative/file?p=creative/… — a Creative file for the app (admin session only). Radar
 * media (other brands' ads) is private research and is only ever served here, never on a public
 * link. Supports Range for video scrubbing.
 */
import { guard } from "@/lib/server/creative/http";
import { getFile } from "@/lib/server/creative/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  const p = new URL(req.url).searchParams.get("p") ?? "";
  if (!/^creative\/[\w./\-:]+$/.test(p) || p.includes("..")) return new Response("Not found", { status: 404 });
  // Tenant scoping: tenant-keyed folders must be this tenant's.
  const m = /^creative\/(radar|twins|audio)\/([0-9a-f-]{36})\//.exec(p);
  if (m && m[2] !== g.session.tid) return new Response("Not found", { status: 404 });
  try {
    const f = await getFile(p);
    const range = req.headers.get("range");
    const total = f.bytes.length;
    if (range) {
      const [a, b] = range.replace(/bytes=/, "").split("-");
      const start = Number(a) || 0;
      const end = b ? Math.min(Number(b), total - 1) : total - 1;
      return new Response(new Uint8Array(f.bytes.subarray(start, end + 1)), {
        status: 206,
        headers: { "Content-Type": f.contentType, "Content-Range": `bytes ${start}-${end}/${total}`, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1), "Cache-Control": "private, max-age=3600" },
      });
    }
    return new Response(new Uint8Array(f.bytes), { headers: { "Content-Type": f.contentType, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
