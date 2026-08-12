/* eslint-disable @typescript-eslint/no-explicit-any */
import OpenAI from "openai";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
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
  if (trimmed.length <= 120) return trimmed;
  return `${trimmed.slice(0, 117).trimEnd()}...`;
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

export async function POST(req: NextRequest) {
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

    const apiKey = normalizeText(getOpenAiApiKey());
    if (!apiKey) {
      return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
    }

    const client = new OpenAI({ apiKey });
    const prompt = [
      "Act as an SEO specialist and accessibility expert.",
      "Analyze the product image and write optimized alt text based only on what is visually present.",
      "Do not use the product name.",
      "Write one natural-sounding sentence (80-120 characters).",
      "Include relevant descriptive keywords but avoid repetition or stuffing.",
      'Do not use promotional language like "best", "cheap", or "high quality".',
      "Return only the alt text.",
      `Item type context: ${itemType}.`,
    ].join("\n");

    let modelImageUrl = "";
    try {
      modelImageUrl = storagePath ? await toModelImageUrlFromStoragePath(storagePath) : await toModelImageUrl(imageUrl);
    } catch (err: any) {
      return NextResponse.json(
        { error: err?.message || "Invalid or blocked image URL." },
        { status: 400 }
      );
    }
    let rawAlt = "";
    try {
      const response = await client.responses.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_output_tokens: 180,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: modelImageUrl || imageUrl, detail: "auto" },
            ],
          },
        ],
      });
      rawAlt = normalizeText(response.output_text || "");
    } catch {
      rawAlt = "";
    }

    if (!rawAlt) {
      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: modelImageUrl || imageUrl } },
            ],
          },
        ],
      });
      rawAlt = normalizeText(completion.choices?.[0]?.message?.content || "");
    }

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
