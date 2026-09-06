import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { resolveShopContext } from "@/lib/server/shopify-write";
import { runShopifyGraphql } from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Storefront wishlist sync — persists a logged-in customer's saved items.
 *
 * The wishlist itself lives in the browser (assets/carbon-wishlist.js in the
 * theme), which is what makes it work for guests. This route is the sync layer:
 * it copies a logged-in customer's list into their `carbon.wishlist` customer
 * metafield so it follows them from phone to laptop.
 *
 * Why this route exists at all: a Shopify storefront cannot write customer
 * metafields on its own — that needs the Admin API and an access token, which
 * must never reach a browser. So the theme posts here and this route does the
 * write with the shop's admin token.
 *
 * Trusting the caller: the browser cannot simply claim a customer id, or anyone
 * could overwrite anyone's wishlist. Instead the theme renders, server-side in
 * Liquid, an HMAC of the logged-in customer's id signed with a shared secret
 * (CARBON_WISHLIST_SECRET, also in snippets/carbon-wishlist-sync.liquid). Only
 * Shopify can mint that signature, because only Shopify knows who is logged in
 * and the secret never leaves the Liquid source. This route re-computes it and
 * refuses anything that does not match.
 *
 * Reads do not come through here: Liquid renders the saved list straight into
 * the page, so loading a wishlist costs no request at all.
 *
 * Public route (no WMS session) — see isPublicPath() in proxy.ts.
 */

/** Signed ids older than this are refused, to bound replay of a leaked page. */
const MAX_SIGNATURE_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Matches the LIMIT in the theme's store; keeps the metafield well under Shopify's size cap. */
const MAX_ITEMS = 250;

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
    Vary: "Origin",
  };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

/** Constant-time compare; length mismatch is rejected before timingSafeEqual, which throws on it. */
function signatureMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

type Item = { v: string; p: string; h: string; t: number };

/**
 * Keep only what the theme actually stores, and re-shape it here rather than
 * trusting the request body: this value is written straight into a customer
 * record, so an oversized or malformed list must never reach Shopify.
 */
function sanitiseItems(raw: unknown): Item[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Item[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_ITEMS * 2)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const v = String(e.v ?? "").trim();
    const h = String(e.h ?? "").trim();
    if (!/^\d{1,20}$/.test(v)) continue;
    if (!h || h.length > 255) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push({
      v,
      p: /^\d{1,20}$/.test(String(e.p ?? "")) ? String(e.p) : "",
      h,
      t: Number.isFinite(Number(e.t)) ? Number(e.t) : Date.now(),
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

export async function POST(req: Request) {
  const cors = corsHeaders(req.headers.get("origin"));
  const json = (body: unknown, status = 200) =>
    NextResponse.json(body, { status, headers: cors });

  const secret = (process.env.CARBON_WISHLIST_SECRET || "").trim();
  if (!secret) {
    // Unconfigured rather than broken: fail closed and say so in the logs only.
    console.error("[wishlist] CARBON_WISHLIST_SECRET is not set; refusing writes");
    return json({ ok: false, error: "not configured" }, 503);
  }

  let body: { customerId?: unknown; ts?: unknown; sig?: unknown; items?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }

  const customerId = String(body.customerId ?? "").trim();
  const ts = String(body.ts ?? "").trim();
  const sig = String(body.sig ?? "").trim();
  if (!/^\d{1,20}$/.test(customerId) || !/^\d{1,20}$/.test(ts) || !/^[a-f0-9]{64}$/.test(sig)) {
    return json({ ok: false, error: "bad request" }, 400);
  }

  const age = Math.floor(Date.now() / 1000) - Number(ts);
  if (age > MAX_SIGNATURE_AGE_SECONDS || age < -300) {
    return json({ ok: false, error: "stale" }, 401);
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${customerId}.${ts}`)
    .digest("hex");
  if (!signatureMatches(expected, sig)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const items = sanitiseItems(body.items);
  if (!items) return json({ ok: false, error: "bad items" }, 400);

  const ctx = await resolveShopContext();
  if (!ctx) return json({ ok: false, error: "shopify not configured" }, 503);

  const res = await runShopifyGraphql<{
    metafieldsSet: { metafields: Array<{ id: string }>; userErrors: Array<{ message: string }> };
  }>({
    shop: ctx.shop,
    token: ctx.token,
    apiVersion: ctx.apiVersion,
    query: `mutation($m:[MetafieldsSetInput!]!){
      metafieldsSet(metafields:$m){ metafields{ id } userErrors{ field message } }
    }`,
    variables: {
      m: [
        {
          ownerId: `gid://shopify/Customer/${customerId}`,
          namespace: "carbon",
          key: "wishlist",
          type: "json",
          value: JSON.stringify(items),
        },
      ],
    },
  });

  const errs = (res as { data?: { metafieldsSet?: { userErrors?: Array<{ message: string }> } } })
    ?.data?.metafieldsSet?.userErrors;
  if (errs && errs.length) {
    console.error("[wishlist] metafieldsSet rejected:", JSON.stringify(errs).slice(0, 300));
    return json({ ok: false, error: "write rejected" }, 502);
  }

  return json({ ok: true, saved: items.length });
}
