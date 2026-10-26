import { withActivity } from "@/lib/server/activity-log";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { writeAltTexts } from "@/lib/seo/alt-text";
import {
  assertDataUrlSize,
  fetchRemoteImageBytes,
  getImageFetchMaxBytes,
  getImageFetchTimeoutMs,
  normalizeRemoteImageUrl,
} from "@/lib/remoteImage";
import { downloadStorageObject, tryGetStoragePathFromUrl } from "@/lib/storageProvider";

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function clampAltLength(text: string) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 125) return trimmed;
  return `${trimmed.slice(0, 122).trimEnd()}...`;
}

async function toModelImageUrl(rawUrl: string) {
  const url = normalizeText(rawUrl);
  if (!url) return "";
  if (url.startsWith("data:image/")) {
    assertDataUrlSize(url, getImageFetchMaxBytes());
    return url;
  }

  const safeUrl = normalizeRemoteImageUrl(url);
  try {
    const { bytes, contentType } = await fetchRemoteImageBytes(safeUrl, {
      timeoutMs: getImageFetchTimeoutMs(),
      maxBytes: getImageFetchMaxBytes(),
    });
    return `data:${normalizeText(contentType) || "image/png"};base64,${bytes.toString("base64")}`;
  } catch (firstErr: any) {
    // Shopify CDN variants can return 400 for some transformed URLs; retry without query string.
    try {
      const parsed = new URL(safeUrl);
      const host = parsed.hostname.toLowerCase();
      if (
        (host === "cdn.shopify.com" || host.endsWith(".cdn.shopify.com") || host === "cdn.shopifycdn.net") &&
        parsed.search
      ) {
        const retryUrl = `${parsed.origin}${parsed.pathname}`;
        const { bytes, contentType } = await fetchRemoteImageBytes(retryUrl, {
          timeoutMs: getImageFetchTimeoutMs(),
          maxBytes: getImageFetchMaxBytes(),
        });
        return `data:${normalizeText(contentType) || "image/png"};base64,${bytes.toString("base64")}`;
      }
    } catch {
      // Ignore retry parsing errors and throw original.
    }
    throw firstErr;
  }
}

async function toModelImageUrlFromStoragePath(rawPath: string) {
  const path = normalizeText(rawPath);
  if (!path) return "";
  const { body, contentType } = await downloadStorageObject(path);
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (bytes.length > getImageFetchMaxBytes()) {
    throw new Error(`Image too large (${bytes.length} bytes).`);
  }
  return `data:${normalizeText(contentType) || "image/png"};base64,${bytes.toString("base64")}`;
}

async function POST_handler(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const authPool = getPool();
  if (!authPool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(authPool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({}));
    const imageUrl = normalizeText(body?.imageUrl);
    const storagePathRaw = normalizeText(body?.storagePath);
    const storagePath = storagePathRaw || (imageUrl ? tryGetStoragePathFromUrl(imageUrl) : "");
    const itemType = normalizeText(body?.itemType) || "apparel item";
    if (!imageUrl && !storagePath) {
      return NextResponse.json({ error: "Missing imageUrl or storagePath" }, { status: 400 });
    }

    // The product name lets the alt text follow the store format ("<Name> in <Colour> – <view>").
    let productName = normalizeText(body?.productTitle);
    const matrixId = normalizeText(body?.matrixId);
    if (!productName && /^[0-9a-f-]{36}$/i.test(matrixId)) {
      const r = await authPool.query<{ description: string | null }>(`SELECT description FROM matrices WHERE id = $1::uuid`, [matrixId]).catch(() => null);
      productName = normalizeText(r?.rows[0]?.description);
    }

    let modelImageUrl = "";
    try {
      modelImageUrl = storagePath ? await toModelImageUrlFromStoragePath(storagePath) : await toModelImageUrl(imageUrl);
    } catch (err: any) {
      return NextResponse.json(
        { error: err?.message || "Invalid or blocked image URL." },
        { status: 400 }
      );
    }
    // One alt-text standard for the shop and Social (lib/seo/alt-text.ts), owner 2026-10-26.
    const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(modelImageUrl);
    const alts = await writeAltTexts({
      kind: "shop",
      images: [m ? { id: "1", base64: { mediaType: m[1], data: m[2] } } : { id: "1", url: imageUrl }],
      productName: productName || null,
      colour: normalizeText(body?.colour) || null,
      context: `Item type: ${itemType}.`,
    });
    const rawAlt = alts.get("1") || "";
    if (!rawAlt) {
      return NextResponse.json({ error: "Alt generation returned empty content." }, { status: 500 });
    }

    const altText = clampAltLength(rawAlt);
    return NextResponse.json({ altText });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Failed to generate image alt text." },
      { status: 500 }
    );
  }
}

export const POST = withActivity("openai/image-alt", POST_handler);
