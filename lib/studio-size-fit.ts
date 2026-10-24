/**
 * Studio size fit (owner, 2026-10-24): "check if the item has measurements in
 * its matrix and if it does, generate the item on the models in a realistic way
 * — check what size will fit first and then generate the pictures."
 *
 * Pure: the garment's measured sizes (CarbonGradingAI, flat, in cm) and the
 * model's body (model_profiles, in inches) in; the size this model would really
 * wear and a plain description of how it sits on them out. That description goes
 * into every panel, so OpenAI draws the real ease and length instead of a
 * generic fit. The operator's Item instruction still has the final word (the
 * generate route puts it last); a size named in the instruction is used as is.
 *
 * Flat measurements: chest, waist, hip and hem are taken straight across one
 * layer, so the garment goes around the body at twice that. Shoulder, length,
 * sleeve and inseam are taken as they are.
 */

export type GarmentKind = "top" | "trousers" | "shorts";
export type FitIntent = "skinny" | "slim" | "regular" | "relaxed" | "oversized";

/** source: app / graded / web = this product's own numbers; guide = copied from a size guide. */
export type MeasuredSize = { size: string; kind: GarmentKind; cm: Record<string, number>; source?: string };

export type ModelBody = {
  name: string;
  gender: "female" | "male";
  height: string; // display, e.g. 6'1"
  heightIn: number;
  chestIn: number | null; // bust for women
  waistIn: number | null;
  hipsIn: number | null;
  inseamIn: number | null;
  shoulderIn: number | null;
  size: string | null; // the model's usual size label, e.g. "M", "XS–S"
  jeansWaist: string | null; // e.g. "32"
};

export type SizeFit = {
  size: string;
  basis: "measurements" | "instruction";
  intent: FitIntent;
  /** One paragraph for the prompt. */
  text: string;
  /** Short line for the Studio, e.g. "Gringo → size M (chest 36.4" on a 40" chest: close)". */
  summary: string;
};

const IN = 2.54;
const r1 = (n: number) => Math.round(n * 10) / 10;
const fmt = (n: number) => `${r1(n)}"`;
const around = (flatCm: number | undefined) => (flatCm ? (flatCm * 2) / IN : null);
const straight = (cm: number | undefined) => (cm ? cm / IN : null);

/** The cut the spec / product name / item type promise. */
export function fitIntentOf(...texts: (string | null | undefined)[]): FitIntent {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  if (/\b(super[\s-]?slim|skinny|muscle fit|compression|second[\s-]?skin|bodycon|leggings?|jeggings?)\b/.test(t)) return "skinny";
  if (/\b(oversi[sz]ed|boxy|baggy|drop[\s-]?shoulder)\b/.test(t)) return "oversized";
  if (/\b(relaxed|loose|wide[\s-]?leg|wide fit|balloon)\b/.test(t)) return "relaxed";
  if (/\b(slim|fitted|tapered|tailored)\b/.test(t)) return "slim";
  return "regular";
}

/** The cut, with the Item instruction first: it has the final word (owner, 2026-10-24). */
export function runFitIntent(instruction: string | null | undefined, ...rest: (string | null | undefined)[]): FitIntent {
  const fromInstruction = fitIntentOf(instruction);
  return fromInstruction !== "regular" ? fromInstruction : fitIntentOf(...rest);
}

/** The FIT/SILHOUETTE line of an item spec, if any. */
export function specFitLine(spec: string | null | undefined): string {
  return /^\s*\d+\.\s*FIT\/SILHOUETTE:\s*(.+)$/im.exec(String(spec ?? ""))?.[1] ?? "";
}

/** A size the Item instruction names ("wear size L", "in XL", "size 32"), or null. */
export function instructionSize(instruction: string | null | undefined, sizes: string[]): string | null {
  const t = String(instruction ?? "");
  const m = /\b(?:size|wears?|wearing|in a|in an|in)\s+(XXXL|XXL|XL|XS|XXS|S|M|L|\d{2})\b/i.exec(t);
  if (!m) return null;
  const want = m[1].toUpperCase();
  return sizes.find((s) => s.trim().toUpperCase() === want) ?? null;
}

/* Ease (garment around − body around, inches) each cut is cut for. */
const TOP_CHEST: Record<FitIntent, [number, number]> = {
  skinny: [-2, 1],
  slim: [1, 3.5],
  regular: [3.5, 7],
  relaxed: [7, 10],
  oversized: [10, 18],
};
const BOTTOM_HIP: Record<FitIntent, [number, number]> = {
  skinny: [-1, 2],
  slim: [1.5, 4.5],
  regular: [3.5, 7],
  relaxed: [6, 11],
  oversized: [9, 18],
};

const outside = (v: number, [lo, hi]: [number, number]) => (v < lo ? lo - v : v > hi ? v - hi : 0);
const sizeLabelMatches = (size: string, label: string | null) =>
  !!label && label.split(/[–\-/ ]+/).some((p) => p.trim().toUpperCase() === size.trim().toUpperCase());

function scoreTop(m: MeasuredSize, body: ModelBody, intent: FitIntent): number {
  const chest = around(m.cm.chest);
  let s = 0;
  if (chest != null && body.chestIn) s += outside(chest - body.chestIn, TOP_CHEST[intent]) * 2;
  const sh = straight(m.cm.shoulder);
  if (sh != null && body.shoulderIn && intent !== "oversized") s += Math.max(0, Math.abs(sh - body.shoulderIn) - 1.5);
  if (sizeLabelMatches(m.size, body.size)) s -= 0.4; // tie-break toward the model's usual size
  return s;
}

function scoreBottom(m: MeasuredSize, body: ModelBody, intent: FitIntent, stretchWaist: boolean): number {
  let s = 0;
  const waist = around(m.cm.waist);
  if (waist != null && body.waistIn) {
    const e = waist - body.waistIn;
    s += outside(e, stretchWaist ? [-7, 2] : [-1, 1.5]) * 2;
  }
  const hip = around(m.cm.hip);
  if (hip != null && body.hipsIn) s += outside(hip - body.hipsIn, BOTTOM_HIP[intent]);
  if (/^\d{2}$/.test(m.size.trim()) && body.jeansWaist && body.jeansWaist.split(/[–\-]/).includes(m.size.trim())) s -= 1.5;
  else if (sizeLabelMatches(m.size, body.size)) s -= 0.4;
  return s;
}

const LETTERS = ["XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
function sizeRank(s: string): number {
  const t = s.trim().toUpperCase();
  if (/^\d+(\.\d+)?$/.test(t)) return 100 + Number(t);
  const i = LETTERS.indexOf(t);
  return i >= 0 ? i : 50;
}

/** Too small (-1), wearable (0) or too big (1) for this body. */
function wearable(m: MeasuredSize, body: ModelBody, intent: FitIntent, stretchWaist: boolean): -1 | 0 | 1 {
  if (m.kind === "top") {
    const chest = around(m.cm.chest);
    if (chest == null || !body.chestIn) return 0;
    const e = chest - body.chestIn;
    if (e < (intent === "skinny" ? -5 : -3)) return -1;
    if (e > TOP_CHEST[intent][1] + 8) return 1;
    return 0;
  }
  const waist = around(m.cm.waist);
  const hip = around(m.cm.hip);
  const stretchy = stretchWaist || intent === "skinny";
  if (waist != null && body.waistIn && waist - body.waistIn < (stretchy ? -9 : -2.5)) return -1;
  if (hip != null && body.hipsIn && hip - body.hipsIn < (intent === "skinny" ? -13 : -2.5)) return -1;
  if (waist != null && body.waistIn && waist - body.waistIn > 4) return 1;
  return 0;
}

/**
 * Realistic: a model wears their own size — the usual size, or for numbered
 * jeans their jeans waist — unless the garment's numbers say it cannot be worn,
 * then the next size up (or down). No size of theirs on the list: the best fit
 * by ease. (Damian Shirt is a super-slim stretch tee: every size is smaller than
 * a regular chest, and a pure ease search picked XXL for a size-M model.)
 */
function anchoredPick(sizes: MeasuredSize[], body: ModelBody, intent: FitIntent, stretchWaist: boolean): MeasuredSize {
  const ordered = [...sizes].sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
  const numeric = ordered.every((s) => /^\d{2}$/.test(s.size.trim()));
  const wants = [
    ...(numeric && body.jeansWaist ? body.jeansWaist.split(/[–\-]/).map((x) => x.trim()) : []),
    ...String(body.size ?? "").split(/[–\-/ ]+/).map((x) => x.trim().toUpperCase()),
  ].filter(Boolean);
  let i = ordered.findIndex((s) => wants.includes(s.size.trim().toUpperCase()));
  if (i < 0) {
    const kind = ordered[0].kind;
    return [...ordered].sort((a, b) =>
      kind === "top" ? scoreTop(a, body, intent) - scoreTop(b, body, intent) : scoreBottom(a, body, intent, stretchWaist) - scoreBottom(b, body, intent, stretchWaist),
    )[0];
  }
  let w = wearable(ordered[i], body, intent, stretchWaist);
  while (w === -1 && i < ordered.length - 1 && wearable(ordered[i + 1], body, intent, stretchWaist) !== 1) {
    i += 1;
    w = wearable(ordered[i], body, intent, stretchWaist);
  }
  while (w === 1 && i > 0 && wearable(ordered[i - 1], body, intent, stretchWaist) !== -1) {
    i -= 1;
    w = wearable(ordered[i], body, intent, stretchWaist);
  }
  return ordered[i];
}

function chestWords(e: number): string {
  if (e < -1) return "stretched snug across the chest — the knit pulls slightly over the chest and arms";
  if (e < 1) return "skin-close: it follows the chest, shoulders and arms";
  if (e < 3.5) return "close and clean, with a little room";
  if (e < 7) return "a regular fit with about a hand of room";
  if (e < 10) return "relaxed — it drapes away from the body";
  return "clearly oversized, wide and boxy on the body";
}
function shoulderWords(d: number): string {
  if (d < -1) return "the shoulder seams sit just inside the shoulder points";
  if (d < 1.5) return "the shoulder seams sit on the shoulder points";
  if (d < 4) return "the shoulder seams drop slightly past the shoulders";
  return "dropped shoulders: the seams sit well down the upper arms";
}
function topLengthWords(lenIn: number, heightIn: number): string {
  const k = lenIn / heightIn;
  if (k < 0.29) return "cropped — the hem ends above the waistband";
  if (k < 0.34) return "the hem ends at the waistband";
  if (k < 0.4) return "the hem ends at the hip, covering the waistband";
  if (k < 0.45) return "long — the hem ends at the upper thigh";
  return "very long — the hem reaches mid-thigh";
}
function waistWords(e: number, stretch: boolean): string {
  if (stretch && e < -1) return "the elastic waistband is gathered and sits flat around the waist";
  if (e < -1) return "the waistband is snug and closes firmly";
  if (e < 1.5) return "the waistband sits flush at the waist, no gap";
  return "the waistband sits a little loose at the waist";
}
function hipWords(e: number): string {
  if (e < 1) return "close over the hips and seat";
  if (e < 4.5) return "a clean fit over the hips and seat";
  if (e < 8) return "comfortable room through the hips and thighs";
  return "roomy and loose through the hips and thighs";
}
function trouserLengthWords(d: number): string {
  if (d < -3) return "cropped — the hem ends above the ankle and the ankle shows";
  if (d < -1) return "the hem ends at the ankle";
  if (d < 1.5) return "full length with a light break on the shoe";
  return "long — the hem stacks on the shoe";
}
function shortsLengthWords(inseamIn: number): string {
  if (inseamIn < 4.5) return "short — the hem ends high on the thigh";
  if (inseamIn < 7.5) return "the hem ends at mid-thigh";
  if (inseamIn < 10.5) return "the hem ends just above the knee";
  return "long — the hem reaches the knee";
}

/**
 * Pick the size and describe the fit. null when there is nothing to go on (no
 * measured size, or the model has no body numbers for this kind of garment).
 */
export function chooseSizeFit(input: {
  sizes: MeasuredSize[];
  body: ModelBody;
  intent: FitIntent;
  instruction?: string | null;
  spec?: string | null;
}): SizeFit | null {
  const sizes = input.sizes.filter((s) => s.size && Object.keys(s.cm).length);
  if (!sizes.length) return null;
  const { body, intent } = input;
  const kind = sizes[0].kind;
  const stretchWaist = /\b(elastic|elasticated|drawstring|stretch waist)\b/i.test(String(input.spec ?? ""));
  const named = instructionSize(input.instruction, sizes.map((s) => s.size));
  let pick: MeasuredSize | undefined = named ? sizes.find((s) => s.size === named) : undefined;
  if (!pick) {
    if (kind === "top" && !body.chestIn) return null;
    if (kind !== "top" && !body.waistIn && !body.hipsIn) return null;
    pick = anchoredPick(sizes, body, intent, stretchWaist);
  }
  const who = body.gender === "female" ? "her" : "his";
  /* Lengths are only described from this product's own measurements — a size
     guide copied across a whole family (all jeans: inseam 28") would draw every
     pair cropped. */
  const own = pick.source !== "guide";
  const parts: string[] = [];
  let summaryBit = "";
  if (kind === "top") {
    const chest = around(pick.cm.chest);
    const sh = straight(pick.cm.shoulder);
    const len = straight(pick.cm.length);
    const sl = straight(pick.cm.sleeve);
    if (chest != null && body.chestIn) {
      const e = chest - body.chestIn;
      parts.push(`chest ${fmt(chest)} around on ${who} ${fmt(body.chestIn)} ${body.gender === "female" ? "bust" : "chest"} — ${chestWords(e)}`);
      summaryBit = `chest ${fmt(chest)} on a ${fmt(body.chestIn)} ${body.gender === "female" ? "bust" : "chest"}`;
    }
    if (sh != null && body.shoulderIn) parts.push(`shoulder ${fmt(sh)} seam to seam on ${who} ${fmt(body.shoulderIn)} shoulders — ${shoulderWords(sh - body.shoulderIn)}`);
    if (len != null && own) parts.push(`body length ${fmt(len)} from the shoulder — ${topLengthWords(len, body.heightIn)}`);
    if (sl != null && own) parts.push(`sleeve ${fmt(sl)} from the shoulder seam`);
  } else {
    const waist = around(pick.cm.waist);
    const hip = around(pick.cm.hip);
    const inseam = straight(pick.cm.inseam);
    if (waist != null && body.waistIn) {
      parts.push(`waistband ${fmt(waist)} around on ${who} ${fmt(body.waistIn)} waist — ${waistWords(waist - body.waistIn, stretchWaist)}`);
      summaryBit = `waist ${fmt(waist)} on a ${fmt(body.waistIn)} waist`;
    }
    if (hip != null && body.hipsIn) parts.push(`hip ${fmt(hip)} around on ${who} ${fmt(body.hipsIn)} hips — ${hipWords(hip - body.hipsIn)}`);
    if (inseam != null && own) {
      if (kind === "shorts") parts.push(`inseam ${fmt(inseam)} — ${shortsLengthWords(inseam)}`);
      else if (body.inseamIn) parts.push(`inseam ${fmt(inseam)} on ${who} ${fmt(body.inseamIn)} inside leg — ${trouserLengthWords(inseam - body.inseamIn)}`);
      else parts.push(`inseam ${fmt(inseam)}`);
    }
  }
  if (!parts.length) return null;
  const why = named
    ? "the size the item instruction names"
    : own
      ? "the size that fits this body, checked against this garment's own measurements"
      : "the size that fits this body by the size guide";
  const text =
    `SIZE AND FIT — ${body.name} (${body.height}) wears size ${pick.size}, ${why}. ` +
    `Measured garment at this size on this body: ${parts.join("; ")}. ` +
    `Draw the garment on ${body.name} at exactly this fit and length in every frame — not looser or tighter, not longer or shorter. ` +
    `It is still the same garment as the item photos and spec; this only decides how it sits on this body.`;
  return {
    size: pick.size,
    basis: named ? "instruction" : "measurements",
    intent,
    text,
    summary: `${body.name} → size ${pick.size}${summaryBit ? ` (${summaryBit})` : ""}${named ? " · named in the item instruction" : ""}`,
  };
}

/** "6'1\"" → 73 inches. */
export function heightToInches(h: string | null | undefined, cm?: number | null): number {
  const m = /(\d)\s*'\s*(\d{1,2})?/.exec(String(h ?? ""));
  if (m) return Number(m[1]) * 12 + Number(m[2] ?? 0);
  return cm ? cm / IN : 70;
}
