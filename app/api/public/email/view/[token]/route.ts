/**
 * GET /api/public/email/view/<token> — one AI Designer version as a web page,
 * for the owner's phone (a link pasted into WhatsApp). Public (proxy.ts) but
 * unguessable (18 random bytes), read-only, sample name and code only.
 */
import { getPool } from "@/lib/db";
import { PREVIEW_CSP, versionPreview } from "@/lib/server/email/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ token: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return new Response("Not found", { status: 404 });
  const pool = getPool();
  if (!pool) return new Response("Unavailable", { status: 503 });
  const html = await versionPreview(pool, "", { shareToken: token }).catch(() => null);
  if (!html) return new Response("Not found", { status: 404 });
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PREVIEW_CSP, "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" },
  });
}
