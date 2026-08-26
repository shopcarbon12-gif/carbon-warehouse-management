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

const MAX_REFS = 6;
const TIMEOUT_MS = 90_000;

function text(v: unknown) {
  return typeof v === "string" ? v.trim() : "";
}
/** Array of strings OR objects → readable phrases (objects are flattened to
 *  their values, e.g. {item:"rivets",count:4,finish:"black",location:"…"} →
 *  "rivets ×4, black, corners of front pockets"). */
function list(v: unknown, max = 20): string[] {
  if (!Array.isArray(v)) return [];
  const flat = (x: unknown): string => {
    if (typeof x === "string") return x.trim();
    if (!x || typeof x !== "object") return "";
    const o = x as Record<string, unknown>;
    const parts: string[] = [];
    const name = text(o.item ?? o.type ?? o.name ?? o.description);
    const count = o.count != null && String(o.count).trim() && String(o.count) !== "1" ? `×${String(o.count).trim()}` : "";
    if (name) parts.push([name, count].filter(Boolean).join(" "));
    for (const [k, val] of Object.entries(o)) {
      if (["item", "type", "name", "description", "count"].includes(k)) continue;
      const s = typeof val === "string" ? val.trim() : val != null ? String(val).trim() : "";
      if (s) parts.push(s);
    }
    return parts.join(", ");
  };
  return v.map(flat).filter(Boolean).slice(0, max);
}
const NONE = /^(none|no|n\/a|not visible|not applicable|-)\.?$/i;

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

type TextItem = { text?: string; placement?: string; style?: string; color?: string };
type GraphicItem = { description?: string; placement?: string; colors?: string };

/** Deterministic, prompt-ready numbered lock list built from the JSON spec. */
function buildLockText(spec: any): string {
  const lines: string[] = [];
  const push = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    if (t) lines.push(t.length > 220 ? `${t.slice(0, 217)}…` : t);
  };
  const g = text(spec?.garment_type);
  const cw = text(spec?.colorway);
  if (g || cw) push(`Garment: ${[g, cw].filter(Boolean).join(" — ")}.`);
  for (const t of (Array.isArray(spec?.text) ? spec.text : []) as TextItem[]) {
    const w = text(t?.text);
    if (!w) continue;
    push(
      `TEXT (exact spelling, case and letterforms): "${w}"${t.placement ? ` at ${text(t.placement)}` : ""}${t.style ? `, ${text(t.style)}` : ""}${t.color ? `, ${text(t.color)}` : ""}. Reproduce verbatim — never paraphrase, translate, drop, or add letters.`,
    );
  }
  for (const gr of (Array.isArray(spec?.graphics_prints) ? spec.graphics_prints : []) as GraphicItem[]) {
    const d = text(gr?.description);
    if (!d) continue;
    push(`GRAPHIC/PRINT: ${d}${gr.placement ? ` at ${text(gr.placement)}` : ""}${gr.colors ? ` (${text(gr.colors)})` : ""} — same artwork, scale, position and colours.`);
  }
  for (const s of list(spec?.labels_patches)) push(`LABEL/PATCH: ${s}.`);
  for (const s of list(spec?.hardware)) push(`HARDWARE: ${s}.`);
  const st = text(spec?.stitching);
  if (st) push(`STITCHING: ${st}.`);
  for (const s of list(spec?.pockets)) push(`POCKET: ${s}.`);
  const cl = text(spec?.closures);
  if (cl) push(`CLOSURE: ${cl}.`);
  const mt = text(spec?.materials_texture);
  if (mt) push(`MATERIAL/TEXTURE: ${mt}.`);
  const wf = text(spec?.wash_finish);
  if (wf) push(`WASH/FINISH: ${wf}.`);
  const ds = text(spec?.distressing);
  if (ds && !NONE.test(ds)) push(`DISTRESSING: ${ds} — exact placement and extent, no more, no less.`);
  else if (ds) push("DISTRESSING: none — clean, undistressed fabric everywhere; do not add rips, fading, or whiskering.");
  const sp = text(spec?.seams_panels);
  if (sp) push(`SEAMS/PANELS: ${sp}.`);
  const tr = text(spec?.trims_hems_cuffs_collar);
  if (tr) push(`TRIMS/HEMS/CUFFS/COLLAR: ${tr}.`);
  const fit = text(spec?.fit_silhouette);
  if (fit) push(`FIT/SILHOUETTE: ${fit}.`);
  for (const s of list(spec?.other_details)) push(`DETAIL: ${s}.`);
  const unc = list(spec?.uncertain);
  if (unc.length) push(`NOT CLEARLY VISIBLE (do not invent): ${unc.join("; ")}.`);
  return lines.slice(0, 40).map((l, i) => `${i + 1}. ${l}`).join("\n");
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({}));
    const refs = (Array.isArray(body?.itemRefs) ? body.itemRefs : []).map(text).filter(Boolean).slice(0, MAX_REFS);
    const itemType = text(body?.itemType) || "apparel item";
    if (!refs.length) return NextResponse.json({ error: "itemRefs required" }, { status: 400 });

    const apiKey = text(getOpenAiApiKey());
    if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });

    const resolved = await Promise.allSettled(refs.map((r: string) => toDataUrl(r)));
    const images = resolved.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled" && !!r.value).map((r) => r.value);
    if (!images.length) {
      return NextResponse.json({ error: "None of the item reference images could be loaded." }, { status: 400 });
    }

    const model = (process.env.ITEM_SPEC_MODEL || "gpt-4o").trim() || "gpt-4o";
    const instruction = [
      `You are a garment technologist documenting a "${itemType}" for an exact-reproduction photo shoot. Inspect EVERY reference image at maximum detail and record ONLY what is clearly visible. Never guess; list unclear items under "uncertain".`,
      "Return STRICT JSON with these keys:",
      '{ "garment_type": string, "colorway": string, "materials_texture": string, "wash_finish": string, "distressing": string,',
      '  "hardware": string[] (each: item, count, finish/colour, exact location — buttons, rivets, zips, eyelets, snaps, buckles, D-rings),',
      '  "stitching": string (thread colour(s), single/double/triple topstitch, bar tacks, decorative stitching, where),',
      '  "pockets": string[] (type, count, placement, details), "closures": string, "seams_panels": string,',
      '  "text": [{ "text": exact characters as printed (keep case, punctuation, spacing), "placement": string, "style": string, "color": string }] — include EVERY word, number, logo wordmark, label text, embroidery and print lettering; transcribe letter-by-letter,',
      '  "graphics_prints": [{ "description": string, "placement": string, "colors": string }] — logos, prints, patterns, embroidery, appliqués,',
      '  "labels_patches": string[], "trims_hems_cuffs_collar": string, "fit_silhouette": string, "other_details": string[], "uncertain": string[] }',
      "Be exhaustive and specific (measurable where possible: e.g. 'five copper rivets on front pockets', 'contrast orange double topstitch on outseam'). Ignore any person, background, or styling in the photos — describe the product only.",
    ].join("\n");

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
                ...images.map((url) => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } })),
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
    const lockText = buildLockText(spec);
    if (!lockText) return NextResponse.json({ error: "Item analysis found nothing to lock. Add clearer item photos." }, { status: 422 });
    return NextResponse.json({ spec, lockText, imagesAnalyzed: images.length, model });
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "Item analysis timed out." : e?.message || "Item analysis failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
