import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/storefront/welcome-signup — the email popup on shopcarbon.com
 * (snippets/carbon-welcome-popup.liquid). A shopper's email → subscribed in
 * Shopify + one unique, single-use code (lib/server/welcome/signup.ts).
 *
 * Called from shoppers' browsers, so it is public (proxy.ts) and answers CORS
 * for the storefront origins only. text/plain JSON body: a "simple" request,
 * no preflight. The code email is sent after the answer.
 */
import { NextResponse, after } from "next/server";
import { getPool } from "@/lib/db";
import { extractPublicIp } from "@/lib/server/request-public-ip";
import { deliverWelcomeEmail, runWelcomeSignup } from "@/lib/server/welcome/signup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ORIGINS = new Set(
  [
    "https://shopcarbon.com",
    "https://www.shopcarbon.com",
    process.env.SHOPIFY_SHOP_DOMAIN ? `https://${process.env.SHOPIFY_SHOP_DOMAIN}` : "",
  ].filter(Boolean),
);

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://shopcarbon.com";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

async function POST_handler(req: Request) {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);
  // A browser always says where it is; another site's page is not our popup.
  if (origin && !ALLOWED_ORIGINS.has(origin)) return NextResponse.json({ ok: false, error: "try_again" }, { status: 403, headers });
  const pool = getPool();
  if (!pool) return NextResponse.json({ ok: false, error: "server" }, { status: 503, headers });

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.length > 2000) return NextResponse.json({ ok: false, error: "try_again" }, { status: 400, headers });
    const parsed = JSON.parse(text || "{}") as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "try_again" }, { status: 400, headers });
  }

  /* Traefik (Coolify) sets x-real-ip to the connecting address; prefer it over
     the client-editable left end of x-forwarded-for. */
  const ip = req.headers.get("x-real-ip")?.trim() || extractPublicIp(req);
  const answer = await runWelcomeSignup(pool, {
    email: body.email,
    honeypot: body.hp,
    openMs: body.t,
    path: body.p,
    locale: body.l,
    ip,
    ua: req.headers.get("user-agent") ?? "",
  });

  if (answer.ok && (answer.status === "created" || answer.status === "existing") && answer.emailing) {
    const kind = answer.status === "created" ? "first" : "resend";
    const id = answer.id;
    after(() => deliverWelcomeEmail(pool, id, kind));
  }
  const shown: Record<string, unknown> = { ...answer };
  delete shown.id; // the row id stays on the server
  return NextResponse.json(shown, { status: answer.ok ? 200 : answer.error === "server" ? 500 : 200, headers });
}

export const POST = withActivity("storefront/welcome-signup", POST_handler);
