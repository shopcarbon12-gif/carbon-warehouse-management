import { carbonBooksConfig, carbonBooksVisible, signCarbonBooksHandoff } from "@/lib/carbonbooks";
import { getSession } from "@/lib/get-session";

/**
 * GET /carbonbooks/open — the sidebar's CarbonBooks item. Signed-out visitors are sent to /login
 * by the proxy and come back here. Users without CarbonBooks access get a plain 404.
 * The pass is POSTed (not put in the address bar) to books.shopcarbon.com/handoff.
 */
export async function GET() {
  const session = await getSession();
  const cfg = carbonBooksConfig();
  if (!session || !cfg || !(await carbonBooksVisible(session.sub))) {
    return new Response("Not found", { status: 404 });
  }
  const token = await signCarbonBooksHandoff(session, cfg.secret);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Opening CarbonBooks…</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui,sans-serif;background:#F6F1E9;color:#2B2620}button{min-height:48px;padding:0 20px;border:0;border-radius:8px;background:#A84C2B;color:#fff;font:inherit;font-weight:600;cursor:pointer}</style></head>
<body><form method="post" action="${esc(cfg.url)}/handoff"><input type="hidden" name="t" value="${esc(token)}"><p>Opening CarbonBooks…</p><noscript><button type="submit">Continue to CarbonBooks</button></noscript></form>
<script>document.forms[0].submit()</script></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
