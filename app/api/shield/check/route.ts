import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/shield/check — Carbon Shield's verdict for one storefront page view.
 *
 * Called by the theme snippet (snippets/carbon-shield.liquid) from shoppers'
 * browsers on shopcarbon.com, so it is public (proxy.ts) and answers CORS for
 * the storefront origins only. The body is sent as text/plain JSON so the
 * browser makes a "simple" request with no preflight round-trip.
 *
 * Fails open: any problem answers "allow".
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { extractPublicIp } from "@/lib/server/request-public-ip";
import { runShieldCheck, type CheckBody } from "@/lib/server/shield/check";

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

const ALLOW = { action: "allow", mode: "off", ttl: 30, silence: false } as const;

async function POST_handler(req: Request) {
  const headers = corsHeaders(req.headers.get("origin"));
  const pool = getPool();
  if (!pool) return NextResponse.json(ALLOW, { headers });
  let body: CheckBody = {};
  try {
    const text = await req.text();
    if (text.length > 4000) return NextResponse.json(ALLOW, { headers });
    const parsed = JSON.parse(text || "{}") as unknown;
    if (parsed && typeof parsed === "object") body = parsed as CheckBody;
  } catch {
    /* unreadable body — still scored on IP and user agent */
  }
  try {
    /* Traefik (Coolify) sets x-real-ip to the connecting address; prefer it over
       the client-editable left end of x-forwarded-for. */
    const ip = req.headers.get("x-real-ip")?.trim() || extractPublicIp(req);
    const answer = await runShieldCheck(pool, ip, req.headers.get("user-agent") ?? "", body);
    return NextResponse.json(answer, { headers });
  } catch (e) {
    console.warn("[shield] check failed:", e instanceof Error ? e.message : e);
    return NextResponse.json(ALLOW, { headers });
  }
}

export const POST = withActivity("shield/check", POST_handler);
