/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FLATS (ported from carbon-gen): generate one clean e-commerce flat image of
 * the item — front view left, back view right, pure white background, no
 * person/mannequin — from the item reference photos. The client splits it
 * into two 3:4 crops (front / back) and adds them to the item references so
 * the panel generation (and the pre-generation analysis) work from clean,
 * detail-faithful product views.
 *
 * Same image model / quality env as panel generation (owner: do not change
 * quality). input_fidelity "high" IS used here — there is no person in a flat,
 * so the face-copy regression that keeps it off the panel call doesn't apply.
 * Supports the `x-generate-stream: 1` heartbeat wrapper (idle-connection
 * protection on phones), identical to /api/generate.
 */
import OpenAI, { toFile } from "openai";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import {
  fetchRemoteImageBytes,
  getImageFetchMaxBytes,
  getImageFetchTimeoutMs,
  normalizeRemoteImageUrl,
} from "@/lib/remoteImage";
import { downloadStorageObject, tryGetStoragePathFromUrl } from "@/lib/storageProvider";

const MAX_REFS = 10;

function text(v: unknown) {
  return typeof v === "string" ? v.trim() : "";
}
function extFromContentType(ct: string) {
  const c = ct.toLowerCase();
  if (c.includes("png")) return "png";
  if (c.includes("webp")) return "webp";
  if (c.includes("jpeg") || c.includes("jpg")) return "jpg";
  return "png";
}
function imageTimeoutMs() {
  const n = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS || 0);
  return Number.isFinite(n) && n >= 30_000 ? Math.min(n, 300_000) : 180_000;
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (t) clearTimeout(t);
  });
}

async function downloadReferenceAsFile(url: string, index: number) {
  const storagePath = tryGetStoragePathFromUrl(url);
  let lastError = "";
  try {
    const { bytes, contentType } = await fetchRemoteImageBytes(normalizeRemoteImageUrl(url), {
      timeoutMs: getImageFetchTimeoutMs(),
      maxBytes: getImageFetchMaxBytes(),
    });
    return toFile(bytes, `item-ref-${index + 1}.${extFromContentType(contentType)}`, { type: contentType });
  } catch (e: any) {
    lastError = e?.message || "Image fetch failed";
  }
  if (storagePath) {
    const { body, contentType } = await downloadStorageObject(storagePath);
    const bytes = Buffer.from(body);
    return toFile(bytes, `item-ref-${index + 1}.${extFromContentType(contentType)}`, { type: contentType });
  }
  throw new Error(`Reference image fetch failed at index ${index + 1} (${lastError})`);
}

async function handleFlat(req: NextRequest): Promise<Response> {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({}));
    // Studio sorts item photos into General / Front / Back; the images go to
    // OpenAI in that order so the prompt can bind LEFT (front view) to the
    // FRONT photos and RIGHT (back view) to the BACK photos.
    const listOf = (v: unknown) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);
    const views = body?.itemRefViews && typeof body.itemRefViews === "object" ? body.itemRefViews : null;
    const viewLists = views
      ? { general: listOf(views.general), front: listOf(views.front), back: listOf(views.back) }
      : { general: listOf(body?.itemRefs), front: [] as string[], back: [] as string[] };
    if (!viewLists.general.length && !viewLists.front.length && !viewLists.back.length) {
      viewLists.general = listOf(body?.itemRefs);
    }
    const refs = [...viewLists.general, ...viewLists.front, ...viewLists.back].slice(0, MAX_REFS);
    const itemType = text(body?.itemType) || "apparel item";
    if (!refs.length) return NextResponse.json({ error: "Add item references first — flats are generated from them." }, { status: 400 });

    const apiKey = text(getOpenAiApiKey());
    if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY on server." }, { status: 500 });

    const downloaded = await Promise.allSettled(refs.map((u: string, i: number) => downloadReferenceAsFile(u, i)));
    const files = downloaded
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof downloadReferenceAsFile>>> => r.status === "fulfilled")
      .map((r) => r.value);
    if (!files.length) {
      const errs = downloaded
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => String(r.reason?.message || r.reason || "download failed"))
        .slice(0, 4);
      return NextResponse.json({ error: `Could not download any item reference images. ${errs.join(" | ")}` }, { status: 400 });
    }

    const imageModel = (process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5").trim() || "gpt-image-1.5";
    const imageQuality = (process.env.OPENAI_IMAGE_QUALITY || "high").trim() || "high";
    const isDalle2 = imageModel === "dall-e-2";
    const supportsFidelity = !isDalle2 && !imageModel.startsWith("gpt-image-2");

    // View map for the prompt, computed from the images that actually
    // downloaded (a failed download shifts every index after it).
    const okViews = downloaded
      .map((r, i) =>
        i < viewLists.general.length ? "general" : i < viewLists.general.length + viewLists.front.length ? "front" : "back"
      )
      .filter((_, i) => downloaded[i].status === "fulfilled");
    const nGeneral = okViews.filter((v) => v === "general").length;
    const nFront = okViews.filter((v) => v === "front").length;
    const nBack = okViews.filter((v) => v === "back").length;
    const range = (start: number, count: number) => (count === 1 ? `image ${start}` : `images ${start}–${start + count - 1}`);
    const viewMapLines: string[] = [];
    if (nFront || nBack) {
      const parts: string[] = [];
      let cursor = 1;
      if (nGeneral) {
        parts.push(`${range(cursor, nGeneral)} = general photo(s) (any view)`);
        cursor += nGeneral;
      }
      if (nFront) {
        parts.push(`${range(cursor, nFront)} = the FRONT of the item`);
        cursor += nFront;
      }
      if (nBack) {
        parts.push(`${range(cursor, nBack)} = the BACK of the item`);
        cursor += nBack;
      }
      viewMapLines.push(
        `REFERENCE VIEW MAP (authoritative — the operator sorted the photos): ${parts.join("; ")}.`,
        "The LEFT (front) view must reproduce the FRONT photo(s) exactly; the RIGHT (back) view must reproduce the BACK photo(s) exactly. Never copy back content onto the front view or front content onto the back view."
      );
      if (nFront && !nBack) viewMapLines.push("No BACK photo was supplied: render the back from the general photos if they show it; otherwise keep the back clean in the item colour — never invent a back design.");
      if (nBack && !nFront) viewMapLines.push("No FRONT photo was supplied: render the front from the general photos if they show it; otherwise keep the front clean in the item colour — never invent a front design.");
    }

    const prompt = [
      `Create one ecommerce flat-lay image for a ${itemType}.`,
      "Output must be a side-by-side two-view composition.",
      "Left side: front view. Right side: back view.",
      ...viewMapLines,
      "Keep both views centered, same scale, and fully visible.",
      "No model, no person, no mannequin, no hanger, no hands, no props.",
      "Use clean pure white studio background only.",
      "DETAIL PRIORITY: maximize fidelity to item-reference details above all else.",
      "Match exact garment construction and small elements from references: stitching/topstitching, seam lines, panels, hems, cuffs, ribbing, closures, labels, logos, icons, artwork, graphics, trims, hardware, and fabric texture.",
      "Reproduce every word, number and logo letter-perfect (same spelling, case, letterforms, placement, colour); reproduce every graphic with its real application look — heat-transfer/vinyl, screen print, silicone or high-density raised print, puff print, foil, embroidery, appliqué/patch, embossed/debossed, woven label — matte vs gloss, flat vs raised, exactly as in the references.",
      "Preserve garment color, texture, logos, print placement, trims, and seams from references.",
      "If strings exist (drawstrings, laces, ties, cords), keep them naturally loose and open with relaxed drape; never tight, over-pulled, or fully cinched.",
      "FAIL-STYLE RULE: reject any tight-string styling. No closed knots, no tight bows, no hard cinching at hood, waist, neck, or hem.",
      "If a reference shows strings pulled tight, reinterpret them into a natural open relaxed state while preserving material and color.",
      "Keep silhouette and proportions true to references. Do not simplify or genericize details.",
      "If the back design is unclear in references, keep back clean and consistent with the front garment.",
      "Never invent logos, prints, text, hardware or details that are not clearly present in the references.",
      "Final look: premium flat ecommerce product photography with crisp high-detail rendering.",
    ].join("\n");

    const openai = new OpenAI({ apiKey });
    const request: any = { model: imageModel, image: files, prompt, size: isDalle2 ? "1024x1024" : "1536x1024" };
    if (!isDalle2) {
      request.quality = imageQuality;
      request.moderation = (process.env.OPENAI_IMAGE_MODERATION || "low").trim() || "low";
    }
    if (supportsFidelity) request.input_fidelity = "high";

    const edited: any = await withTimeout(openai.images.edit(request), imageTimeoutMs(), "Flat front/back generation");
    const b64 = text(edited?.data?.[0]?.b64_json);
    if (!b64) return NextResponse.json({ error: "OpenAI returned no image for the flat front/back generation." }, { status: 502 });
    return NextResponse.json({ imageBase64: b64, size: request.size, model: imageModel });
  } catch (e: any) {
    const status = Number(e?.status || e?.statusCode || 0);
    if (status === 400 && /safety|moderation|content policy/i.test(String(e?.message || ""))) {
      return NextResponse.json({ error: "Blocked by safety — check the reference photos and try again." }, { status: 403 });
    }
    return NextResponse.json({ error: e?.message || "Failed to generate the flat front/back image." }, { status: 500 });
  }
}

/** Heartbeat wrapper — see /api/generate for the rationale (phones drop the
 * otherwise-idle 40-90 s connection). Leading whitespace is valid JSON. */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-generate-stream") !== "1") return handleFlat(req);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(" "));
        } catch {
          /* closed */
        }
      }, 10_000);
      try {
        const res = await handleFlat(req);
        const body = await res.text();
        clearInterval(heartbeat);
        controller.enqueue(encoder.encode(body));
      } catch (err) {
        clearInterval(heartbeat);
        controller.enqueue(encoder.encode(JSON.stringify({ error: err instanceof Error ? err.message : "Flat generation failed" })));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
