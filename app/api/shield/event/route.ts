import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/shield/event — what a visitor does between page views, for
 * Shopify → Visitors: cart adds, checkout starts and a "still here" ping
 * every minute while the tab is open (snippets/carbon-shield.liquid).
 *
 * Public (proxy.ts), CORS for the storefront only, text/plain JSON body (a
 * "simple" request — sendBeacon works). Only visitors a real page view
 * already recorded are updated, so bots that skip the page check add nothing.
 * Always answers 204 — the store never waits on it.
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { recordVisitorEvent } from "@/lib/server/visitors/record";

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
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://shopcarbon.com",
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

// At most 30 events a minute per visitor (a person adds to cart a few times at most).
const hits = new Map<string, { n: number; at: number }>();
function tooMany(vid: string): boolean {
  const now = Date.now();
  const h = hits.get(vid);
  if (!h || now - h.at > 60_000) {
    hits.set(vid, { n: 1, at: now });
    if (hits.size > 20_000) hits.clear();
    return false;
  }
  return ++h.n > 30;
}

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : "");
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() && Number.isFinite(Number(x)) ? Number(x) : null);

async function POST_handler(req: Request) {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);
  const done = new NextResponse(null, { status: 204, headers });
  if (origin && !ALLOWED_ORIGINS.has(origin)) return done;
  const pool = getPool();
  if (!pool) return done;
  try {
    const text = await req.text();
    if (text.length > 3000) return done;
    const b = JSON.parse(text || "{}") as Record<string, unknown>;
    const visitorId = clip(b.v, 64);
    const kind = b.k === "cart_add" || b.k === "checkout" || b.k === "ping" ? b.k : null;
    if (!visitorId || !kind || tooMany(visitorId)) return done;
    const d = (b.d && typeof b.d === "object" ? b.d : {}) as Record<string, unknown>;
    const detail =
      kind === "cart_add"
        ? {
            title: clip(d.title, 200) || null,
            variant: clip(d.variant, 120) || null,
            variantId: clip(String(d.variantId ?? ""), 30) || null,
            qty: num(d.qty),
            price: num(d.price),
            handle: clip(d.handle, 200) || null,
          }
        : kind === "checkout"
          ? { items: num(d.items), total: num(d.total) }
          : null;
    await recordVisitorEvent(pool, { visitorId, kind, path: clip(b.p, 300) || null, detail });
  } catch (e) {
    console.warn("[visitors] event failed:", e instanceof Error ? e.message : e);
  }
  return done;
}

export const POST = withActivity("shield/event", POST_handler);
