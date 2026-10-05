import { withActivity } from "@/lib/server/activity-log";
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Pre-generation ITEM ANALYSIS for Carbon Studio.
 *
 * Before a panel is rendered, the item reference photos are inspected by a
 * vision model at HIGH detail and turned into a structured spec of everything
 * that must be reproduced exactly: every visible word/lettering (exact
 * spelling + placement), graphics/prints/logos/patches/labels, materials and
 * texture, wash/finish/distressing, hardware (buttons, rivets, zips, eyelets),
 * stitching (colour, pattern, placement), pockets, closures, seams/panels,
 * trims/hems/cuffs/collar, fit/silhouette. The spec is returned both as JSON
 * and as a deterministic numbered `lockText` that the client injects into the
 * generation prompt as a hard lock (see lib/panelGeneration.ts `itemSpec`).
 *
 * Model: ITEM_SPEC_MODEL (default gpt-4o). Image generation itself is untouched.
 */
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
import { classifyBackView } from "@/lib/studio-item-spec";
import { buildLockText, buildSpecInstruction, isAccessoryItemType, text } from "@/lib/server/item-spec-build";

/* Every photo the operator sorted is analysed. The old cap of 6 silently dropped
   the tail of the list — which, with the general → front → back order, was the
   BACK photos: the spec then said nothing about the back, and the generator
   invented one. Twelve high-detail images is ~13k input tokens on gpt-4o. */
const MAX_REFS = 12;
const TIMEOUT_MS = 90_000;

async function toDataUrl(rawUrl: string): Promise<string> {
  const url = text(rawUrl);
  if (!url) return "";
  if (url.startsWith("data:image/")) {
    assertDataUrlSize(url, getImageFetchMaxBytes());
    return url;
  }
  const storagePath = tryGetStoragePathFromUrl(url);
  if (storagePath) {
    const { body, contentType } = await downloadStorageObject(storagePath);
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (bytes.length > getImageFetchMaxBytes()) throw new Error(`Image too large (${bytes.length} bytes).`);
    return `data:${text(contentType) || "image/png"};base64,${bytes.toString("base64")}`;
  }
  const safeUrl = normalizeRemoteImageUrl(url);
  const { bytes, contentType } = await fetchRemoteImageBytes(safeUrl, {
    timeoutMs: getImageFetchTimeoutMs(),
    maxBytes: getImageFetchMaxBytes(),
  });
  return `data:${text(contentType) || "image/png"};base64,${bytes.toString("base64")}`;
}


async function POST_handler(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({}));
    // Studio sorts item photos into General / Front / Back. When Front/Back are
    // used, each image is labelled with its view so the placement SIDE in the
    // spec comes from the operator's sorting, not from a guess.
    const listOf = (v: unknown) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);
    const views = body?.itemRefViews && typeof body.itemRefViews === "object" ? body.itemRefViews : null;
    const viewLists = views
      ? { general: listOf(views.general), front: listOf(views.front), back: listOf(views.back) }
      : { general: listOf(body?.itemRefs), front: [] as string[], back: [] as string[] };
    if (!viewLists.general.length && !viewLists.front.length && !viewLists.back.length) {
      viewLists.general = listOf(body?.itemRefs);
    }
    // Back first: it is the side the generator most often invents, and the one
    // a cap (MAX_REFS, or the model's own attention) would otherwise lose.
    const entries = [
      ...viewLists.back.map((url) => ({ url, view: "back" as const })),
      ...viewLists.front.map((url) => ({ url, view: "front" as const })),
      ...viewLists.general.map((url) => ({ url, view: "general" as const })),
    ].slice(0, MAX_REFS);
    const droppedRefs = viewLists.back.length + viewLists.front.length + viewLists.general.length - entries.length;
    const refs = entries.map((e) => e.url);
    const sortedViews = entries.some((e) => e.view !== "general");
    const itemType = text(body?.itemType) || "apparel item";
    if (!refs.length) return NextResponse.json({ error: "itemRefs required" }, { status: 400 });

    const apiKey = text(getOpenAiApiKey());
    if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });

    const resolved = await Promise.allSettled(refs.map((r: string) => toDataUrl(r)));
    const loaded = resolved
      .map((r, i) => ({ r, view: entries[i].view }))
      .filter((e): e is { r: PromiseFulfilledResult<string>; view: "general" | "front" | "back" } => e.r.status === "fulfilled" && !!e.r.value)
      .map((e) => ({ url: e.r.value, view: e.view }));
    const images = loaded.map((e) => e.url);
    if (!images.length) {
      return NextResponse.json({ error: "None of the item reference images could be loaded." }, { status: 400 });
    }
    // A photo that failed to load is a photo the analysis never saw. Silent
    // before — the BACK photo could fail, the spec said "not photographed",
    // and the generator then treated the attached back as a verified blank.
    const failedViews = resolved
      .map((r, i) => (r.status === "rejected" ? entries[i].view : null))
      .filter((v): v is "general" | "front" | "back" => v !== null);

    const model = (process.env.ITEM_SPEC_MODEL || "gpt-4o").trim() || "gpt-4o";
    const instruction = buildSpecInstruction(itemType, sortedViews);
    const viewHeading: Record<"general" | "front" | "back", string> = {
      general: "GENERAL reference image(s) — any view (accessories, flats, details):",
      front: "FRONT reference image(s) — this is the FRONT of the garment; everything visible here is on the front:",
      back: "BACK reference image(s) — this is the BACK of the garment; everything visible here is on the back:",
    };
    const imageContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "high" } }> = [];
    for (const view of ["back", "front", "general"] as const) {
      const urls = loaded.filter((e) => e.view === view).map((e) => e.url);
      if (!urls.length) continue;
      if (sortedViews) imageContent.push({ type: "text", text: viewHeading[view] });
      imageContent.push(...urls.map((url) => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } })));
    }

    const client = new OpenAI({ apiKey });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let raw = "";
    try {
      const completion = await client.chat.completions.create(
        {
          model,
          temperature: 0.1,
          max_tokens: 1800,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "You document apparel with forensic precision for exact reproduction. Output valid JSON only." },
            {
              role: "user",
              content: [
                { type: "text", text: instruction },
                ...imageContent,
              ],
            },
          ],
        },
        { signal: ac.signal },
      );
      raw = text(completion.choices?.[0]?.message?.content);
    } finally {
      clearTimeout(timer);
    }

    let spec: any = null;
    try {
      spec = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          spec = JSON.parse(m[0]);
        } catch {
          spec = null;
        }
      }
    }
    if (!spec || typeof spec !== "object") {
      return NextResponse.json({ error: "Item analysis returned no usable result. Please retry." }, { status: 502 });
    }
    const lockText = buildLockText(spec, { accessory: isAccessoryItemType(itemType) });
    if (!lockText) return NextResponse.json({ error: "Item analysis found nothing to lock. Add clearer item photos." }, { status: 422 });
    return NextResponse.json({
      spec,
      lockText,
      backView: classifyBackView(spec?.back_view, spec?.back_state).state,
      imagesAnalyzed: images.length,
      imagesDropped: droppedRefs,
      imagesFailed: failedViews.length,
      failedViews,
      model,
    });
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "Item analysis timed out." : e?.message || "Item analysis failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export const POST = withActivity("openai/item-spec", POST_handler);
