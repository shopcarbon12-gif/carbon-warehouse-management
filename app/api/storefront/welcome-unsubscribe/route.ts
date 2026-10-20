import { withActivity } from "@/lib/server/activity-log";
/**
 * /api/storefront/welcome-unsubscribe?t=<token> — the unsubscribe link in the
 * email-popup welcome email (lib/server/welcome/email.ts).
 *
 *  GET  → a small page with an Unsubscribe button (link scanners that open
 *         every link in an email must not unsubscribe anyone by themselves).
 *  POST → unsubscribes: the form button, and mail apps' one-click unsubscribe
 *         (List-Unsubscribe-Post, RFC 8058). Sets the Shopify customer's email
 *         marketing to unsubscribed.
 *
 * Public (proxy.ts); the random token is the key.
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { unsubscribeWelcome } from "@/lib/server/welcome/signup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function page(title: string, body: string, status = 200): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="margin:0;background:#fff;color:#111;font:16px/1.5 Helvetica,Arial,sans-serif">
<main style="max-width:440px;margin:12vh auto;padding:0 20px;text-align:center">
<p style="font-weight:700;letter-spacing:8px;font-size:18px;margin:0 0 28px">CARBON</p>${body}
<p style="margin-top:32px"><a href="https://shopcarbon.com" style="color:#111">shopcarbon.com</a></p>
</main></body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function tokenOf(req: Request): string {
  return (new URL(req.url).searchParams.get("t") ?? "").trim().slice(0, 100);
}

export async function GET(req: Request) {
  const t = tokenOf(req);
  if (!t) return page("Link not valid", `<h1 style="font-size:22px">This link isn't valid</h1>`, 400);
  return page(
    "Unsubscribe",
    `<h1 style="font-size:22px;margin:0 0 12px">Unsubscribe from Carbon emails?</h1>
<p style="color:#444;margin:0 0 24px">You'll stop getting marketing emails from Carbon. Your welcome code still works.</p>
<form method="post" action="?t=${encodeURIComponent(t)}">
<button type="submit" style="background:#111;color:#fff;border:0;padding:14px 28px;font:700 15px Helvetica,Arial,sans-serif;letter-spacing:2px;text-transform:uppercase;cursor:pointer">Unsubscribe</button>
</form>`,
  );
}

async function POST_handler(req: Request) {
  const t = tokenOf(req);
  const pool = getPool();
  if (!t || !pool) return page("Link not valid", `<h1 style="font-size:22px">This link isn't valid</h1>`, 400);
  const r = await unsubscribeWelcome(pool, t).catch(() => ({ ok: false as const, email: undefined }));
  if (!r.ok && !r.email) return page("Link not valid", `<h1 style="font-size:22px">This link isn't valid</h1>`, 404);
  if (!r.ok) {
    return page(
      "Try again",
      `<h1 style="font-size:22px">Something went wrong</h1><p style="color:#444">Please try again in a moment, or email support@shopcarbon.com.</p>`,
      500,
    );
  }
  return page(
    "Unsubscribed",
    `<h1 style="font-size:22px;margin:0 0 12px">You're unsubscribed</h1><p style="color:#444;margin:0">${esc(r.email ?? "")} won't get marketing emails from Carbon anymore.</p>`,
  );
}

export const POST = withActivity("storefront/welcome-unsubscribe", POST_handler);
