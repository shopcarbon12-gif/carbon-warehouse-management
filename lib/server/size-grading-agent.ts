/**
 * Size Grading — the AI measures the garment (rebuild, 2026-10-12).
 *
 * The owner's ask: "this time I want AI to control it". The old path cut the
 * garment out on the phone and measured the outline with hand-written rules;
 * every real photo found a new way to break those rules, and the AI was only
 * asked for a few points, read off the whole photo in one go — 1–4 cm off.
 *
 * Here the AI places every end point of every measurement itself, and it is
 * given the one thing that makes that precise: close-ups. It sees the whole
 * squared-up photo with a labelled pixel grid, says where it wants to look
 * closer, and gets each spot back enlarged with tick marks in the SAME
 * full-image coordinates. It repeats until each end sits on the seam or edge,
 * then submits the lines. The arithmetic — pixels to centimetres — is done
 * here from the printed target's exact scale; the AI never computes a length.
 *
 * Provider-neutral on purpose: the same turn protocol (JSON out, pictures in)
 * runs on Claude and on OpenAI, so the two can be compared on the same photo
 * for cost and accuracy (scripts/test-size-grading-agent.ts).
 *
 * The grid digits are drawn as strokes, not text: the production image is
 * Alpine with no fonts, and an SVG <text> there renders as nothing.
 */
import sharp from "sharp";
import OpenAI from "openai";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { POM_LABEL, pomsFor, type GarmentType, type PomKey } from "@/lib/size-grading/garment";
import { LANDMARK_RULES, LANDMARKS, PLAUSIBLE, POM_RULE } from "@/lib/size-grading/pom-definitions";

export type Provider = "claude" | "openai";
type Pt = { x: number; y: number };
export type AgentLine = { a: Pt; b: Pt };

export type AgentInput = {
  /** The squared-up picture (JPEG/PNG bytes) — 1 cm = pxPerCm everywhere in it. */
  image: Buffer;
  pxPerCm: number;
  type: GarmentType | null;
  view: "front" | "back";
  /** Points to measure. Empty with type null = whatever the AI's family uses. */
  keys: PomKey[];
  /**
   * CarbonGradingAI: the points as the phone app defines them (sleeveL,
   * thighR, strap, …), each with its own standard rule. When given, these are
   * measured instead of `keys`, and only these keys are accepted back.
   */
  points?: { key: string; label: string; rule: string }[];
  /** Where the scale came from: the printed target (default) or the phone's depth sensor. */
  scale?: "target" | "depth";
};

export type AgentOptions = {
  provider: Provider;
  model: string;
  /** Close-up rounds before the AI must answer. 0 = one look, no close-ups. */
  maxRounds?: number;
  maxZooms?: number;
  /** OpenAI reasoning effort / Claude thinking budget (tokens, 0 = off). */
  effort?: "none" | "low" | "medium" | "high";
  thinkingBudget?: number;
  deadlineMs?: number;
  log?: (m: string) => void;
};

export type AgentResult = {
  garment: GarmentType | null;
  view: "front" | "back";
  /* Keyed by PomKey on the web page, by the app's own point keys for CarbonGradingAI. */
  lines: Partial<Record<string, AgentLine>>;
  cm: Partial<Record<string, number>>;
  skipped: Partial<Record<string, string>>;
  remarks: string;
  provider: Provider;
  model: string;
  rounds: number;
  zooms: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  ms: number;
};

const FAMILIES: GarmentType[] = ["top", "trousers", "shorts", "dress", "skirt", "onepiece"];

/* USD per million tokens: [input, output, cache read, cache write]. From the
   providers' price pages, 2026-10-12. Unknown models cost NaN, not 0. */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
  "claude-haiku-4-5-20251001": [1, 5, 0.1, 1.25],
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "gpt-5.5": [5, 30, 0.5, 5],
  "gpt-5.4": [2.5, 15, 0.25, 2.5],
  "gpt-5.4-mini": [0.75, 4.5, 0.075, 0.75],
  "gpt-5.6-sol": [4, 20, 0.4, 4],
  "gpt-6-sol": [2, 10, 0.2, 2],
  "gpt-6.1-sol": [2, 10, 0.1, 2],
  "gpt-6-astra": [10, 50, 1, 10],
  "gpt-6-luna": [0.1, 0.5, 0.01, 0.1],
  "claude-opus-5": [5, 25, 0.5, 6.25],
};

function costOf(model: string, u: AgentResult["usage"]): number {
  const p = PRICES[model];
  if (!p) return Number.NaN;
  return (u.input * p[0] + u.output * p[1] + u.cacheRead * p[2] + u.cacheWrite * p[3]) / 1e6;
}

/* ------------------------------------------------------------------ */
/* Pictures: overview grid and close-ups, digits drawn as strokes.     */
/* ------------------------------------------------------------------ */

/* Seven-segment digits on a 4×7 cell: a top, b top-right, c bottom-right,
   d bottom, e bottom-left, f top-left, g middle. */
const SEG: Record<string, string> = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
  "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcdfg", "-": "g",
};
function digitPath(s: string, x: number, y: number, h: number): string {
  const w = h * 0.55, gap = h * 0.32;
  let d = "";
  [...s].forEach((ch, i) => {
    const x0 = x + i * (w + gap), m = y + h / 2, y1 = y + h;
    const segs: Record<string, string> = {
      a: `M${x0},${y}H${x0 + w}`, b: `M${x0 + w},${y}V${m}`, c: `M${x0 + w},${m}V${y1}`,
      d: `M${x0},${y1}H${x0 + w}`, e: `M${x0},${m}V${y1}`, f: `M${x0},${y}V${m}`, g: `M${x0},${m}H${x0 + w}`,
    };
    for (const k of SEG[ch] ?? "") d += segs[k];
  });
  return d;
}
function label(s: string, x: number, y: number, h: number, color: string): string {
  const d = digitPath(s, x, y, h);
  const sw = Math.max(1.6, h / 6);
  // A dark halo under the light digits keeps them readable on any fabric.
  return `<path d="${d}" stroke="#000" stroke-width="${sw * 2.6}" fill="none" stroke-linecap="square" opacity="0.85"/>` +
    `<path d="${d}" stroke="${color}" stroke-width="${sw}" fill="none" stroke-linecap="square"/>`;
}
function labelWidth(s: string, h: number) {
  return s.length * h * 0.55 + (s.length - 1) * h * 0.32;
}

const NICE = [2, 5, 10, 20, 25, 50, 100, 200];

async function overview(img: Buffer, w: number, h: number): Promise<string> {
  const step = 100, lh = Math.max(12, Math.round(Math.min(w, h) / 70));
  let svg = "";
  for (let x = step; x < w; x += step) {
    svg += `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#00b7ff" stroke-width="1" opacity="0.55"/>`;
    svg += label(String(x), x + 3, 4, lh, "#7fe0ff") + label(String(x), x + 3, h - lh - 4, lh, "#7fe0ff");
  }
  for (let y = step; y < h; y += step) {
    svg += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#ff3fd2" stroke-width="1" opacity="0.55"/>`;
    svg += label(String(y), 4, y + 3, lh, "#ffb3f0") + label(String(y), w - labelWidth(String(y), lh) - 4, y + 3, lh, "#ffb3f0");
  }
  const over = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${svg}</svg>`);
  const out = await sharp(img).composite([{ input: over, top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
  return out.toString("base64");
}

type Zoom = { id: string; x: number; y: number; size: number };
const ZOOM_PX = 720;

/* Close-ups are cut from the FULL-resolution picture (f = its pixels per
   overview pixel), while every coordinate stays in the overview's pixels. On
   black fabric a shoulder seam is invisible at the overview's ~10 px/cm and
   visible at the photo's ~25 px/cm — that was the shoulder error on the first
   T-shirt (2026-10-12). */
async function closeUp(img: Buffer, f: number, w: number, h: number, z: Zoom) {
  const size = Math.round(Math.max(40, Math.min(600, z.size || 160)));
  // Shift the window inside the picture rather than pad it: no fake background.
  const left = Math.round(Math.max(0, Math.min(w - size, z.x - size / 2)));
  const top = Math.round(Math.max(0, Math.min(h - size, z.y - size / 2)));
  const sw = Math.min(size, w), shh = Math.min(size, h);
  const k = ZOOM_PX / Math.max(sw, shh);
  const W = Math.round(sw * k), H = Math.round(shh * k);
  const step = NICE.find((s) => sw / s <= 9) ?? 200;
  const lh = 13;
  let svg = "";
  for (let v = Math.ceil(left / step) * step; v <= left + sw; v += step) {
    const px = (v - left) * k;
    svg += `<line x1="${px}" y1="0" x2="${px}" y2="${H}" stroke="#00b7ff" stroke-width="1" opacity="0.6"/>`;
    svg += label(String(v), px + 3, 4, lh, "#7fe0ff");
  }
  for (let v = Math.ceil(top / step) * step; v <= top + shh; v += step) {
    const py = (v - top) * k;
    svg += `<line x1="0" y1="${py}" x2="${W}" y2="${py}" stroke="#ff3fd2" stroke-width="1" opacity="0.6"/>`;
    svg += label(String(v), 4, py + 3, lh, "#ffb3f0");
  }
  // The spot that was asked for, so "where did I look" is never a guess.
  const cx = (z.x - left) * k, cy = (z.y - top) * k;
  svg += `<path d="M${cx - 12},${cy}H${cx - 4}M${cx + 4},${cy}H${cx + 12}M${cx},${cy - 12}V${cy - 4}M${cx},${cy + 4}V${cy + 12}" stroke="#ff2a2a" stroke-width="2"/>`;
  const over = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg}</svg>`);
  const meta = await sharp(img).metadata();
  const X = Math.min(Math.round(left * f), (meta.width ?? 1) - 1), Y = Math.min(Math.round(top * f), (meta.height ?? 1) - 1);
  const out = await sharp(img)
    .extract({
      left: X,
      top: Y,
      width: Math.max(1, Math.min(Math.round(sw * f), (meta.width ?? 1) - X)),
      height: Math.max(1, Math.min(Math.round(shh * f), (meta.height ?? 1) - Y)),
    })
    .resize(W, H, { kernel: "lanczos3" })
    .composite([{ input: over, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
  return {
    b64: out.toString("base64"),
    caption: `Close-up "${z.id}": x ${left}–${left + sw}, y ${top}–${top + shh}; grid every ${step} px (labels are full-image coordinates); red cross = (${Math.round(z.x)}, ${Math.round(z.y)}).`,
  };
}

/* ------------------------------------------------------------------ */
/* The prompt.                                                          */
/* ------------------------------------------------------------------ */

function keysFor(type: GarmentType, view: "front" | "back") {
  return pomsFor(type, view);
}

function buildPrompt(inp: AgentInput, w: number, h: number, maxRounds: number, maxZooms: number): string {
  const cm = inp.pxPerCm;
  const pointList = (keys: PomKey[]) =>
    keys.map((k) => `- "${k}" (${POM_LABEL[k]}): ${POM_RULE[k]}`).join("\n");
  const appList = inp.points?.length
    ? inp.points.map((p) => `- "${p.key}" (${p.label}): ${p.rule}`).join("\n") +
      `\n"L" / "R" in a point name means the sleeve or leg on the LEFT / RIGHT of the photo as you see it.`
    : null;
  const what = inp.type && appList
    ? `The garment is a ${inp.type} (family "${inp.type}"), photographed from the ${inp.view.toUpperCase()}.\n\nMeasure these points:\n${appList}\n\nLandmarks to find first: ${LANDMARKS[inp.type]}`
    : inp.type
    ? `The garment is a ${inp.type} (family "${inp.type}"), photographed from the ${inp.view.toUpperCase()}.\n\nMeasure these points:\n${pointList(inp.keys.length ? inp.keys : keysFor(inp.type, inp.view))}\n\nLandmarks to find first: ${LANDMARKS[inp.type]}`
    : `First decide the garment family — one of ${FAMILIES.join(", ")} — photographed from the ${inp.view.toUpperCase()}. Then measure the points of THAT family:\n` +
      FAMILIES.map((f) => `\nFamily "${f}": ${keysFor(f, inp.view).join(", ")}. Landmarks: ${LANDMARKS[f]}`).join("") +
      `\n\nThe rules for every point:\n${pointList([...new Set(FAMILIES.flatMap((f) => keysFor(f, inp.view)))])}`;
  return `You are a garment technician taking flat measurements of a garment laid on a table, from a photo.

THE PHOTO. ${inp.scale === "depth"
    ? "It has been squared up from the phone's depth sensor (which measured the table plane), so it is as if shot from straight above"
    : "It has been squared up from a printed scale target, so it is as if shot from straight above"}, at one exact scale everywhere: 1 cm = ${cm.toFixed(3)} px (1 inch = ${(cm * 2.54).toFixed(2)} px). It is ${w} × ${h} px. Coordinates are pixels from the top-left corner: x to the right, y down. The overview carries a labelled grid every 100 px (blue = x, pink = y).${inp.scale === "depth" ? "" : " The black-bordered printed card is the scale target — it is never part of the garment and must never be measured."}

${what}

LANDMARK RULES:
${LANDMARK_RULES.map((r) => `- ${r}`).join("\n")}

HOW TO WORK — precision is the whole job; a point 10 px off is ${(10 / cm).toFixed(1)} cm off.
1. Look at the overview. Find the garment and every landmark roughly.
2. Ask for close-ups of the landmarks. A close-up is a square of the photo, centred where you say, enlarged, with grid lines labelled in the SAME full-image pixel coordinates, and a red cross on the spot you asked for. "size" is the square's side in photo pixels (40–600): ~120–200 to place an end point on an edge, larger to see context. You may ask for up to 8 close-ups per reply, ${maxZooms} in total, over at most ${maxRounds} replies.
3. Place each end point exactly ON the garment's outer edge (where fabric meets table) or ON the seam the rule names — read its coordinates off the close-up's grid, interpolating between lines. When a close-up shows your estimate was off, correct it and look again if needed.
4. "Straight across" means a horizontal line (both ends at the same y) when the garment lies upright; "square to the leg" means perpendicular to that leg's centre line, which may be slanted. Vertical lengths are parallel to the garment's centre line.
5. All widths are FLAT — the distance across the garment as it lies. Never double anything.
6. Sanity-check every line against the scale before answering (for example a men's T-shirt chest is usually 45–65 cm across = ${Math.round(45 * cm)}–${Math.round(65 * cm)} px; jeans inseam 70–90 cm).

REPLY FORMAT — JSON only, no prose outside it. Either ask for close-ups:
{"zoom":[{"id":"left armpit","x":412,"y":388,"size":160}], "notes":"what you are checking"}
or give the final answer:
{"final":{"garment":"<family>","view":"${inp.view}","lines":{"<point key>":{"a":[x,y],"b":[x,y]}},"skipped":{"<point key>":"why it cannot be measured on this photo"},"remarks":"anything the operator should know"}}
Every requested point appears in "lines" or "skipped". Coordinates may have one decimal.`;
}

/* ------------------------------------------------------------------ */
/* Providers.                                                           */
/* ------------------------------------------------------------------ */

type Part = { kind: "text"; text: string } | { kind: "image"; b64: string };
type Turn = { send: (parts: Part[]) => Promise<string> };

function parseJson(text: string): Record<string, unknown> | null {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function claudeTurns(model: string, usage: AgentResult["usage"], thinkingBudget: number, signal: AbortSignal): Turn {
  const key = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  type Block = Record<string, unknown>;
  const messages: Array<{ role: "user" | "assistant"; content: Block[] }> = [];
  return {
    async send(parts) {
      // One cache breakpoint, on the newest picture: the whole history before it
      // is read from cache on the next round instead of paid for again.
      for (const m of messages) for (const b of m.content) delete b.cache_control;
      const content: Block[] = parts.map((p) =>
        p.kind === "text"
          ? { type: "text", text: p.text }
          : { type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.b64 } },
      );
      content[content.length - 1].cache_control = { type: "ephemeral" };
      messages.push({ role: "user", content });
      const body: Record<string, unknown> = { model, max_tokens: 6000 + thinkingBudget, messages };
      if (thinkingBudget > 0) body.thinking = { type: "enabled", budget_tokens: thinkingBudget };
      let lastErr = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        const j = (await res.json().catch(() => ({}))) as {
          content?: Block[];
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
          error?: { message?: string };
        };
        if (res.status === 429 || res.status === 529 || res.status >= 500) {
          lastErr = j.error?.message || `Claude HTTP ${res.status}`;
          await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
          continue;
        }
        if (!res.ok) throw new Error(j.error?.message || `Claude HTTP ${res.status}`);
        usage.input += j.usage?.input_tokens ?? 0;
        usage.output += j.usage?.output_tokens ?? 0;
        usage.cacheRead += j.usage?.cache_read_input_tokens ?? 0;
        usage.cacheWrite += j.usage?.cache_creation_input_tokens ?? 0;
        const blocks = j.content ?? [];
        messages.push({ role: "assistant", content: blocks });
        return blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
      }
      throw new Error(lastErr || "Claude did not answer");
    },
  };
}

function openAiTurns(model: string, usage: AgentResult["usage"], effort: AgentOptions["effort"], signal: AbortSignal): Turn {
  const apiKey = getOpenAiApiKey().trim();
  if (!apiKey) throw new Error("No OpenAI key on this server");
  const client = new OpenAI({ apiKey });
  let previous: string | undefined;
  return {
    async send(parts) {
      const res = await client.responses.create(
        {
          model,
          ...(/^(gpt-5|gpt-6|o\d)/.test(model) ? { reasoning: { effort: effort ?? "low" } } : {}),
          text: { format: { type: "json_object" } },
          ...(previous ? { previous_response_id: previous } : {}),
          store: true,
          input: [
            {
              role: "user",
              content: parts.map((p) =>
                p.kind === "text"
                  ? { type: "input_text" as const, text: p.text }
                  : { type: "input_image" as const, image_url: `data:image/jpeg;base64,${p.b64}`, detail: "high" as const },
              ),
            },
          ],
        },
        { signal },
      );
      previous = res.id;
      const cached = res.usage?.input_tokens_details?.cached_tokens ?? 0;
      usage.input += (res.usage?.input_tokens ?? 0) - cached;
      usage.cacheRead += cached;
      usage.output += res.usage?.output_tokens ?? 0;
      return res.output_text ?? "";
    },
  };
}

/* ------------------------------------------------------------------ */
/* The loop.                                                            */
/* ------------------------------------------------------------------ */

function asPt(v: unknown, w: number, h: number): Pt | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = Number(v[0]), y = Number(v[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.max(0, Math.min(w, x)), y: Math.max(0, Math.min(h, y)) };
}

export async function measureWithAgent(inp: AgentInput, opts: AgentOptions): Promise<AgentResult> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const meta = await sharp(inp.image).metadata();
  const W0 = meta.width ?? 0, H0 = meta.height ?? 0;
  if (!W0 || !H0) throw new Error("The picture could not be read");
  /* The AI works on an overview of at most 1400 px; a larger picture is kept
     for the close-ups. Lines come back in the INPUT picture's pixels. */
  const f = Math.max(1, Math.max(W0, H0) / 1400);
  const w = Math.round(W0 / f), h = Math.round(H0 / f);
  const small = f > 1 ? await sharp(inp.image).resize(w, h).jpeg({ quality: 92 }).toBuffer() : inp.image;
  const ovPxPerCm = inp.pxPerCm / f;
  const maxRounds = opts.maxRounds ?? 5;
  const maxZooms = opts.maxZooms ?? 32;
  const deadline = started + (opts.deadlineMs ?? 150_000);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(10_000, deadline - Date.now() + 30_000));
  const turns =
    opts.provider === "claude"
      ? claudeTurns(opts.model, usage, opts.thinkingBudget ?? 0, ac.signal)
      : openAiTurns(opts.model, usage, opts.effort, ac.signal);
  try {
    const ov = await overview(small, w, h);
    let parts: Part[] = [
      { kind: "text", text: buildPrompt({ ...inp, pxPerCm: ovPxPerCm }, w, h, maxRounds, maxZooms) },
      { kind: "image", b64: ov },
    ];
    let zooms = 0, rounds = 0, repaired = false, pushedBack = false, rechecked = false;
    for (;;) {
      const text = await turns.send(parts);
      const j = parseJson(text);
      const final = j?.final as Record<string, unknown> | undefined;
      const ask = Array.isArray(j?.zoom) ? (j!.zoom as Zoom[]) : [];
      const outOfBudget = rounds >= maxRounds + (rechecked ? 1 : 0) || zooms >= maxZooms + (rechecked ? 8 : 0) || Date.now() > deadline - 25_000;
      /* An answer from the overview alone is a guess (Haiku did exactly that:
         thigh 4 cm off). The ends are checked in close-up at least once. */
      if (final && typeof final === "object" && zooms === 0 && maxRounds > 0 && !pushedBack) {
        pushedBack = true;
        parts = [{ kind: "text", text: 'Not yet: no end point has been checked in close-up. Ask for close-ups of the landmarks first ({"zoom":[...]}), then answer.' }];
        continue;
      }
      if (final && typeof final === "object") {
        const garment = FAMILIES.includes(final.garment as GarmentType) ? (final.garment as GarmentType) : inp.type;
        const lines: AgentResult["lines"] = {};
        const cm: AgentResult["cm"] = {};
        const rawLines = (final.lines ?? {}) as Record<string, { a?: unknown; b?: unknown } | null>;
        const allowed = inp.points?.length ? new Set(inp.points.map((p) => p.key)) : null;
        for (const [k, v] of Object.entries(rawLines)) {
          if (!v || !(allowed ? allowed.has(k) : k in POM_RULE)) continue;
          const a = asPt(v.a, w, h), b = asPt(v.b, w, h);
          if (!a || !b) continue;
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          if (len < 2) continue;
          lines[k as PomKey] = { a: { x: a.x * f, y: a.y * f }, b: { x: b.x * f, y: b.y * f } };
          cm[k as PomKey] = Math.round((len / ovPxPerCm) * 10) / 10;
        }
        /* One look again when a number is implausible for its point — the
           AI is told which and why, and keeps its close-up budget. */
        const bad = Object.keys(cm)
          .map((k) => ({ k, p: PLAUSIBLE[k as PomKey], v: cm[k]! }))
          .filter(({ p, v }) => p && p[inp.view] && (v < p[inp.view]![0] || v > p[inp.view]![1]));
        if (bad.length && !rechecked && Date.now() < deadline - 30_000) {
          rechecked = true;
          parts = [{
            kind: "text",
            text:
              bad.map(({ k, v, p }) => `"${k}" came out ${v} cm, outside the usual ${p![inp.view]![0]}–${p![inp.view]![1]} cm: ${p!.why}.`).join(" ") +
              ' Check those points in close-up again ({"zoom":[...]}) and then give the full final answer again.',
          }];
          log(`re-check: ${bad.map((b) => `${b.k} ${b.v}`).join(", ")}`);
          continue;
        }
        const skipped = (final.skipped ?? {}) as AgentResult["skipped"];
        log(`final after ${rounds} rounds, ${zooms} close-ups: ${Object.keys(lines).length} lines`);
        return {
          garment,
          view: inp.view,
          lines,
          cm,
          skipped,
          remarks: String(final.remarks ?? ""),
          provider: opts.provider,
          model: opts.model,
          rounds,
          zooms,
          usage,
          costUsd: costOf(opts.model, usage),
          ms: Date.now() - started,
        };
      }
      if (!ask.length || outOfBudget) {
        if (!j && repaired) throw new Error("The AI's answer could not be read");
        repaired = repaired || !j;
        parts = [{
          kind: "text",
          text: outOfBudget
            ? 'No more close-ups. Give the final answer now, as {"final":{...}} JSON.'
            : 'Reply with JSON only: either {"zoom":[...]} or {"final":{...}}.',
        }];
        rounds++;
        continue;
      }
      const cap = maxZooms + (rechecked ? 8 : 0);
      const take = ask.slice(0, Math.min(8, cap - zooms));
      zooms += take.length;
      rounds++;
      log(`round ${rounds}: ${take.map((z) => z.id).join(", ")}`);
      parts = [];
      for (const z of take) {
        const c = await closeUp(inp.image, f, w, h, { id: String(z.id ?? "spot"), x: Number(z.x), y: Number(z.y), size: Number(z.size) });
        parts.push({ kind: "text", text: c.caption }, { kind: "image", b64: c.b64 });
      }
      const left = cap - zooms;
      parts.push({
        kind: "text",
        text: rounds >= maxRounds + (rechecked ? 1 : 0) || left <= 0
          ? 'That was the last round of close-ups. Give the final answer now, as {"final":{...}} JSON.'
          : `${left} close-ups left. Ask for more, or give the final answer.`,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * CarbonGradingAI's AI assist: its own model setting, so the phone can run on
 * the model that placed the hard points best in the 2026-10-13 test
 * (gpt-6-astra) without changing the desktop page. GRADING_APP_AI_MODEL may be
 * any Claude or OpenAI model name; "off" turns the assist off.
 */
export function gradingAppAgentConfig(): { provider: Provider; model: string; maxRounds: number; thinkingBudget: number; effort: AgentOptions["effort"] } | null {
  const model = (process.env.GRADING_APP_AI_MODEL || "gpt-6-astra").trim();
  if (!model || model === "off") return null;
  const provider: Provider = model.startsWith("claude") ? "claude" : "openai";
  if (provider === "claude" && !(process.env.ANTHROPIC_API_KEY || "").trim()) return agentConfig();
  if (provider === "openai" && !getOpenAiApiKey().trim()) return agentConfig();
  return {
    provider,
    model,
    maxRounds: Number(process.env.GRADING_APP_AI_ROUNDS || process.env.SIZE_GRADING_ROUNDS || 5),
    thinkingBudget: Number(process.env.SIZE_GRADING_THINKING || 0),
    effort: ((process.env.GRADING_APP_AI_EFFORT || process.env.SIZE_GRADING_AI_EFFORT || "low").trim() as AgentOptions["effort"]),
  };
}

/** Which provider and model the app uses, from the environment. */
export function agentConfig(): { provider: Provider; model: string; maxRounds: number; thinkingBudget: number; effort: AgentOptions["effort"] } | null {
  const want = (process.env.SIZE_GRADING_PROVIDER || "").trim().toLowerCase();
  const hasClaude = Boolean((process.env.ANTHROPIC_API_KEY || "").trim());
  const hasOpenAi = Boolean(getOpenAiApiKey().trim());
  const provider: Provider | null =
    want === "openai" ? (hasOpenAi ? "openai" : null) : want === "claude" ? (hasClaude ? "claude" : null) : hasClaude ? "claude" : hasOpenAi ? "openai" : null;
  if (!provider) return null;
  const model =
    provider === "claude"
      ? (process.env.SIZE_GRADING_CLAUDE_MODEL || "claude-opus-5-5").trim()
      : (process.env.SIZE_GRADING_OPENAI_MODEL || "gpt-5.5").trim();
  return {
    provider,
    model,
    maxRounds: Number(process.env.SIZE_GRADING_ROUNDS || 5),
    thinkingBudget: Number(process.env.SIZE_GRADING_THINKING || 0),
    effort: ((process.env.SIZE_GRADING_AI_EFFORT || "low").trim() as AgentOptions["effort"]),
  };
}
