import { withActivity } from "@/lib/server/activity-log";
/**
 * Bulk Studio: is this photo a Carbon hang tag? If so, which product?
 *
 * A photo of the tag (barcode + custom SKU printed under it) dropped on an
 * empty item must load that product exactly as scanning the tag would, and
 * the tag photo must not become a garment reference (owner, 2026-10-20).
 * Chrome on Windows has no BarcodeDetector, so the printed SKU is read by one
 * small vision call; the SKU then resolves to the product here.
 *
 * POST { image: "data:image/…;base64,…" } | { url: <a phone-camera photo in our storage> } | { code }
 * → { isTag: false } | { isTag: true, sku, upc, matches: [{ matrixId, name, upc }] }
 */
import OpenAI from "openai";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { assertDataUrlSize, getImageFetchMaxBytes } from "@/lib/remoteImage";
import { downloadStorageObject, tryGetStoragePathFromUrl } from "@/lib/storageProvider";
import { readTagPhoto, resolveTagCode } from "@/lib/server/hang-tag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 30_000;
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

async function POST_handler(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { image?: unknown; code?: unknown; url?: unknown };
  /* A code already decoded in the browser (BarcodeDetector) skips the vision call. */
  let sku = s(body.code).toUpperCase().replace(/\s+/g, "");
  let upc = "";
  if (!sku) {
    let image = s(body.image);
    /* A phone-camera photo is already in our storage: read it from there. */
    const storagePath = !image && s(body.url) ? tryGetStoragePathFromUrl(s(body.url)) : null;
    if (storagePath) {
      try {
        const { body: bytes0, contentType } = await downloadStorageObject(storagePath);
        const bytes = Buffer.isBuffer(bytes0) ? bytes0 : Buffer.from(bytes0);
        image = `data:${s(contentType) || "image/jpeg"};base64,${bytes.toString("base64")}`;
      } catch {
        return NextResponse.json({ error: "Could not read that photo" }, { status: 400 });
      }
    }
    if (!image.startsWith("data:image/")) return NextResponse.json({ error: "image required" }, { status: 400 });
    try {
      assertDataUrlSize(image, getImageFetchMaxBytes());
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Image too large" }, { status: 400 });
    }
    const apiKey = s(getOpenAiApiKey());
    if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
    const client = new OpenAI({ apiKey });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const t = await readTagPhoto(client, (process.env.ITEM_SPEC_MODEL || "gpt-4o").trim() || "gpt-4o", image, ac.signal);
      if (!t.isTag) return NextResponse.json({ isTag: false });
      sku = t.sku;
      upc = t.upc;
    } catch (e) {
      const msg = e instanceof Error && e.name === "AbortError" ? "Reading the tag timed out." : e instanceof Error ? e.message : "Reading the tag failed.";
      return NextResponse.json({ error: msg }, { status: 502 });
    } finally {
      clearTimeout(timer);
    }
  }
  if (!sku && !upc) return NextResponse.json({ isTag: true, sku: "", upc: "", matches: [] });

  const matches = await resolveTagCode(pool, sku, upc);
  return NextResponse.json({
    isTag: true,
    sku,
    upc,
    matches,
  });
}

export const POST = withActivity("studio/read-tag", POST_handler);
