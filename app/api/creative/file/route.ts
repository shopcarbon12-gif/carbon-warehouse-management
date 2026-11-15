/**
 * GET /api/creative/file?p=creative/… — a Creative file for the app (admin session only). Radar
 * media (other brands' ads) is private research and is only ever served here, never on a public
 * link. Supports Range for video scrubbing.
 */
import { guard } from "@/lib/server/creative/http";
import { getFile, servedHeaders } from "@/lib/server/creative/storage";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  const url = new URL(req.url);
  const p = url.searchParams.get("p") ?? "";
  // creative/… files, and the cast models' pictures (models/…, shared by Creative and Studio).
  if (!/^(creative|models)\/[\w./\-: ()]+$/.test(p) || p.includes("..")) return new Response("Not found", { status: 404 });
  // Tenant scoping (review 2026-11-15): every tenant-keyed folder must be this tenant's, and a project's files
  // only open for the tenant that owns the project.
  const m = /^creative\/(radar|twins|audio|brand|ideas|locations|voices)\/([0-9a-f-]{36})\//.exec(p);
  if (m && m[2] !== g.session.tid) return new Response("Not found", { status: 404 });
  const proj = /^creative\/projects\/([0-9a-f-]{36})\//.exec(p);
  if (proj) {
    const pool = getPool();
    const own = pool ? await pool.query(`SELECT 1 FROM creative_projects WHERE id = $1::uuid AND tenant_id = $2::uuid`, [proj[1], g.session.tid]).catch(() => ({ rows: [] })) : { rows: [] };
    if (!own.rows[0]) return new Response("Not found", { status: 404 });
  }
  try {
    const f = await getFile(p);
    const total = f.bytes.length;
    const base = { ...servedHeaders(f.contentType), "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" } as Record<string, string>;
    // ?download=name → saved with a real file name instead of "file".
    const dl = url.searchParams.get("download");
    if (dl) base["Content-Disposition"] = `attachment; filename="${dl.replace(/[^\w.\- ]+/g, "").slice(0, 80) || "carbon"}"`;
    const range = req.headers.get("range");
    if (range) {
      // bytes=a-b · bytes=a- · bytes=-n (last n bytes); out of range → 416.
      const r = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!r || (!r[1] && !r[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
      let start = r[1] ? Number(r[1]) : Math.max(0, total - Number(r[2]));
      let end = r[1] ? (r[2] ? Math.min(Number(r[2]), total - 1) : total - 1) : total - 1;
      if (start >= total || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
      start = Math.max(0, start);
      end = Math.max(start, end);
      return new Response(new Uint8Array(f.bytes.subarray(start, end + 1)), {
        status: 206,
        headers: { ...base, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(end - start + 1) },
      });
    }
    return new Response(new Uint8Array(f.bytes), { headers: base });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
