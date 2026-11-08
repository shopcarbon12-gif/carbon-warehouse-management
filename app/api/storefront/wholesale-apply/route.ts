import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/storefront/wholesale-apply — a copy of a Wholesale page application
 * (theme section carbon-wholesale-after-dark). The page still submits the form
 * to Shopify (emailed to the store contact address); this copy feeds
 * Shopify → Wholesale and the "Wholesale applications" alert
 * (lib/server/wholesale/applications.ts).
 *
 * Called from the applicant's browser, so it is public (proxy.ts) and answers
 * CORS for the storefront origins only — like the email popup's signup.
 * text/plain JSON body: a "simple" request, no preflight, sent with keepalive
 * while the page moves on to Shopify.
 */
import { NextResponse, after } from "next/server";
import { getPool } from "@/lib/db";
import { extractPublicIp } from "@/lib/server/request-public-ip";
import { MAX_CERTIFICATE_BYTES, alertNewApplication, submitApplication, submitDetailedApplication } from "@/lib/server/wholesale/applications";

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
  if (origin && !ALLOWED_ORIGINS.has(origin)) return NextResponse.json({ ok: false, error: "try_again" }, { status: 403, headers });
  const pool = getPool();
  if (!pool) return NextResponse.json({ ok: false, error: "server" }, { status: 503, headers });

  // Traefik (Coolify) sets x-real-ip to the connecting address; prefer it over x-forwarded-for.
  const ipEarly = req.headers.get("x-real-ip")?.trim() || extractPublicIp(req);

  // The detailed form (owner 2026-11-08): multipart with the resale certificate.
  // multipart/form-data is a CORS "simple" request, so no preflight either.
  if ((req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_CERTIFICATE_BYTES + 200_000) {
      return NextResponse.json({ ok: false, error: "invalid", field: "certificate" }, { status: 413, headers });
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ ok: false, error: "invalid", field: "form" }, { status: 400, headers });
    }
    const fields: Record<string, unknown> = {};
    let file: { name: string; bytes: Uint8Array } | null = null;
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") fields[k] = v.slice(0, 4000);
      else if (k === "certificate" && v.size > 0) file = { name: v.name, bytes: new Uint8Array(await v.arrayBuffer()) };
    }
    try {
      const answer = await submitDetailedApplication(pool, { fields, file, ip: ipEarly, ua: req.headers.get("user-agent") ?? "" });
      if (answer.ok && answer.isNew && answer.id) {
        const id = answer.id;
        after(() => alertNewApplication(pool, id));
      }
      if (answer.ok) return NextResponse.json({ ok: true }, { headers });
      return NextResponse.json(answer, { status: answer.error === "invalid" ? 400 : 429, headers });
    } catch (e) {
      console.error("[wholesale-apply detailed]", e);
      return NextResponse.json({ ok: false, error: "server" }, { status: 500, headers });
    }
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.length > 6000) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400, headers });
    const parsed = JSON.parse(text || "{}") as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400, headers });
  }

  // Traefik (Coolify) sets x-real-ip to the connecting address; prefer it over x-forwarded-for.
  const ip = req.headers.get("x-real-ip")?.trim() || extractPublicIp(req);
  try {
    const answer = await submitApplication(pool, {
      businessName: body.b,
      contactName: body.n,
      email: body.e,
      phone: body.ph,
      cityState: body.c,
      website: body.w,
      storeType: body.s,
      message: body.m,
      honeypot: body.hp,
      openMs: body.t,
      path: body.p,
      ip,
      ua: req.headers.get("user-agent") ?? "",
    });
    if (answer.ok && answer.isNew && answer.id) {
      const id = answer.id;
      after(() => alertNewApplication(pool, id));
    }
    return NextResponse.json({ ok: answer.ok, ...(answer.ok ? {} : { error: answer.error }) }, { headers });
  } catch (e) {
    console.error("[wholesale-apply]", e);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500, headers });
  }
}

export const POST = withActivity("storefront/wholesale-apply", POST_handler);
