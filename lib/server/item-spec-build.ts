/* eslint-disable @typescript-eslint/no-explicit-any */

import { LOCK_TEXT_MAX_BYTES, LOCK_TEXT_MAX_LINES, classifyBackView } from "@/lib/studio-item-spec";

/**
 * The item-spec prompt and the numbered lock list it becomes.
 *
 * Lifted out of app/api/openai/item-spec/route.ts because a Next.js route file
 * may export nothing but its handlers — which left the one piece of this
 * feature worth testing (does a real photograph produce usable lock lines?)
 * reachable only through an authenticated HTTP call. Here it can be run
 * directly against a product's own photos.
 */

export function text(v: unknown) {
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
const NONE = /^(none|no\b|n\/a|nothing|not (visible|applicable|present|apparent)|-)/i;


type TextItem = { text?: string; placement?: string; style?: string; color?: string; technique?: string };
type GraphicItem = { description?: string; placement?: string; colors?: string; technique?: string; finish?: string; size?: string };

/**
 * Turn the side of the PHOTOGRAPH into the side of the BODY.
 *
 * A front view is a mirror: the wearer's right hip is on the left of the
 * picture. Asked to make that conversion itself, the vision model got it
 * backwards even when handed this exact case as a worked example — it read the
 * chain on the right of a front photo and called it the wearer's right hip,
 * when the photo shows it on the wearer's LEFT. So the model is now asked only
 * for what it can see ("image-left" / "image-right") and the mirror is applied
 * here, where it is arithmetic rather than spatial reasoning.
 *
 * The view comes from whichever of front/back appears FIRST in the line, since
 * every placement is written as "front, …" or "back, …"; a line that names
 * neither is treated as a front view, which is what the overwhelming majority
 * of placements are.
 */
export function resolveWearerSide(line: string): string {
  if (!/\bimage-(left|right)\b/i.test(line)) return line;
  const front = line.search(/\bfront\b/i);
  const back = line.search(/\bback\b/i);
  const isBack = back >= 0 && (front < 0 || back < front);
  return line.replace(/\bimage-(left|right)\b/gi, (_m, side: string) => {
    const left = side.toLowerCase() === "left";
    // Back view: picture and body agree. Front view: they are mirrored.
    const wearer = isBack ? (left ? "left" : "right") : left ? "right" : "left";
    return `the wearer's ${wearer}`;
  });
}

/** "technique / finish" suffix for graphic-type lines (omits unknowns). */
function applied(g: { technique?: string; finish?: string }): string {
  const t = text(g?.technique);
  const f = text(g?.finish);
  const parts = [t && !/unclear|unknown/i.test(t) ? t : "", f && !/unclear|unknown/i.test(f) ? f : ""].filter(Boolean);
  return parts.length ? ` — applied as ${parts.join(", ")}` : "";
}

/** Deterministic, prompt-ready numbered lock list built from the JSON spec.
 *
 *  Order matters because the list is byte-capped from the END: the lines
 *  that keep the generator from redesigning the garment — what it is, its
 *  FIT, what the BACK shows, and what must NOT be invented — come first, so
 *  a long hardware inventory can never push them off. */
export function buildLockText(spec: any): string {
  const lines: string[] = [];
  const push = (s: string) => {
    const t = resolveWearerSide(s.replace(/\s+/g, " ").trim());
    if (t) lines.push(t.length > 220 ? `${t.slice(0, 217)}…` : t);
  };
  const g = text(spec?.garment_type);
  const cw = text(spec?.colorway);
  if (g || cw) push(`Garment: ${[g, cw].filter(Boolean).join(" — ")}.`);
  const fit = text(spec?.fit_silhouette);
  if (fit) push(`FIT/SILHOUETTE: ${fit}.`);
  const back = classifyBackView(spec?.back_view, spec?.back_state);
  if (back.state === "unknown") {
    push("BACK: not photographed — the back is UNKNOWN. Do not invent a back design; keep the back plain in the item's own colour, fabric and construction with nothing added.");
  } else if (back.state === "plain") {
    push("BACK: plain — no print, text, graphic, logo or patch on the back.");
  } else {
    push(`BACK: ${back.text || "carries a design (see the lines placed on the back below)"}.`);
  }
  const unc = list(spec?.uncertain);
  if (unc.length) push(`NOT CLEARLY VISIBLE (do not invent): ${unc.join("; ")}.`);
  for (const t of (Array.isArray(spec?.text) ? spec.text : []) as TextItem[]) {
    const w = text(t?.text);
    if (!w) continue;
    push(
      `TEXT (exact spelling, case and letterforms): "${w}"${t.placement ? ` at ${text(t.placement)}` : ""}${t.style ? `, ${text(t.style)}` : ""}${t.color ? `, ${text(t.color)}` : ""}${applied(t)}. Reproduce verbatim — never paraphrase, translate, drop, or add letters.`,
    );
  }
  for (const lg of (Array.isArray(spec?.logos_icons) ? spec.logos_icons : []) as GraphicItem[]) {
    const d = text(lg?.description);
    if (!d) continue;
    push(`LOGO/ICON: ${d}${lg.placement ? ` at ${text(lg.placement)}` : ""}${lg.size ? `, ${text(lg.size)}` : ""}${lg.colors ? ` (${text(lg.colors)})` : ""}${applied(lg)} — same mark, scale, position, colours and surface look (flat vs raised, matte vs gloss).`);
  }
  for (const gr of (Array.isArray(spec?.graphics_prints) ? spec.graphics_prints : []) as GraphicItem[]) {
    const d = text(gr?.description);
    if (!d) continue;
    push(`GRAPHIC/PRINT: ${d}${gr.placement ? ` at ${text(gr.placement)}` : ""}${gr.colors ? ` (${text(gr.colors)})` : ""}${applied(gr)} — same artwork, scale, position, colours and surface look.`);
  }
  /* The construction map. These lines carry the plain zones too, which is the
     point: an unmentioned zone is one the generator fills in from convention. */
  for (const z of (Array.isArray(spec?.construction_zones) ? spec.construction_zones : []) as Array<{
    zone?: string;
    detail?: string;
  }>) {
    const zone = text(z?.zone);
    const detail = text(z?.detail);
    if (zone && detail) push(`ZONE — ${zone.toUpperCase()}: ${detail}.`);
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
  for (const s of list(spec?.other_details)) push(`DETAIL: ${s}.`);
  // Hard cap so the spec can never push the image prompt over the model limit
  // (the generate route appends it inside its server block and caps it too).
  const out: string[] = [];
  let bytes = 0;
  for (const [i, l] of lines.slice(0, LOCK_TEXT_MAX_LINES).entries()) {
    const line = `${i + 1}. ${l}`;
    bytes += Buffer.byteLength(line, "utf8") + 1;
    if (bytes > LOCK_TEXT_MAX_BYTES) break;
    out.push(line);
  }
  return out.join("\n");
}

export function buildSpecInstruction(itemType: string, sortedViews: boolean): string {
  return [
    `You are a garment technologist documenting a "${itemType}" for an exact-reproduction photo shoot. Inspect EVERY reference image at maximum detail and record ONLY what is clearly visible. Never guess; list unclear items under "uncertain".`,
    "Return STRICT JSON with these keys:",
    '{ "garment_type": string, "colorway": string, "materials_texture": string, "wash_finish": string, "distressing": string,',
    '  "hardware": string[] (each: item, count, finish/colour, exact location, AND its form in enough detail to redraw it — a chain needs its link shape, strand count, length and both attachment points; a zip needs tooth colour, pull shape and whether it sits inside or outside; a BUTTON needs its diameter AND how big it looks against the part it sits on (e.g. "about 2 cm, nearly as tall as the 4 cm waistband"), how many holes it has or whether it is a shank, its shape, and its material look (matte horn, glossy plastic, metal, fabric-covered) — a button described only as "round, dark" comes back as a small generic one — buttons, rivets, zips, eyelets, snaps, buckles, D-rings, chains),',
    '  "stitching": string (thread colour(s), single/double/triple topstitch, bar tacks, decorative stitching, where),',
    '  "pockets": string[] (type, count, placement, details), "closures": string, "seams_panels": string,',
    '  "construction_zones": [{ "zone": string, "detail": string }] — the design-bearing areas of THIS garment, each described well enough to rebuild it. For bottoms cover: waistband (height, flat or elasticated, pleats or none), closure/fly, belt loops (count or none), front pockets, back pockets, front of leg, back of leg, side seam, hem/cuff. THE CLOSURE IS THE MOST LOOKED-AT PART OF A WAISTBAND and "zip fly with button closure" is not enough to draw: say how the waistband actually fastens — a plain button on the band, or an extended or squared tab that reaches past the fly — which side laps over which, how far it reaches, how many buttons, and how large the button is against the band. For tops cover: neckline/collar, shoulder seam, chest, sleeve and cuff, side seam, hem, back yoke. For outerwear also: lapel/hood, front closure, pocket flaps, vents.',
    '  "text": [{ "text": exact characters as printed (keep case, punctuation, spacing), "placement": string, "style": string, "color": string, "technique": string }] — include EVERY word, number, logo wordmark, label text, embroidery and print lettering; transcribe letter-by-letter,',
    '  "logos_icons": [{ "description": string, "placement": string, "size": string, "colors": string, "technique": string, "finish": string }] — every brand mark, symbol, icon, emblem, monogram, artwork or illustration,',
    '  "graphics_prints": [{ "description": string, "placement": string, "colors": string, "technique": string, "finish": string }] — prints, patterns, artwork, embroidery, appliqués,',
    '  "labels_patches": string[] (woven/printed labels, leather/jacron patches, hang tags visible, with text and placement),',
    '  "trims_hems_cuffs_collar": string, "fit_silhouette": string, "other_details": string[], "uncertain": string[],',
    '  "back_state": "not_photographed" | "plain" | "design" — not_photographed when NO image shows the back of the garment; plain when a back view (a BACK-labelled image, or an unmistakable back view) shows the back carries no print, text, graphic, logo or patch; design when a back view shows something on the back,',
    '  "back_view": string — for "design": a short description of everything on the back (each element must also appear in text / logos_icons / graphics_prints with placement "back, …"); for "plain": "plain"; for "not_photographed": "not photographed" }',
    'PLACEMENT must always name the SIDE and zone: e.g. "front, image-right shoulder near collar", "back, lower centre", "front, image-left sleeve". Every placement starts with "front, " or "back, " so the mirror can be resolved. Text that appears on more than one side gets one entry per side. STYLE must describe the print EFFECT when present: motion-blur / ghosted edges, faded, gradient, halftone, cracked / distressed, outline, 3D / shadowed, italic / bold / condensed, letter-spacing.',
    'NEVER WRITE A BARE "LEFT" OR "RIGHT", AND NEVER WORK OUT WHICH SIDE OF THE BODY A DETAIL IS ON. Report only what you can see: write "image-left" or "image-right", meaning the side of the PHOTOGRAPH the detail appears on, e.g. "front, image-right near the waistband". Converting that to the wearer\'s left or right is a mirror, it is done for you afterwards in code, and every attempt to do it here has come out backwards and put the detail on the wrong hip in every picture generated from it. Describe the picture; leave the mirror alone. (Centre, upper, lower, hem, cuff, collar and so on stay exactly as they are — only the words left and right are affected.)',
    'FIT_SILHOUETTE must be specific: oversized / boxy / drop-shoulder / relaxed / regular / slim / cropped / longline, sleeve length and shape, body length, hem shape, neckline (crew / V / ribbed collar width).',
    'For every logo, icon, graphic and text: state the APPLICATION TECHNIQUE as seen — heat transfer / vinyl, screen print, silicone or high-density raised print, puff print, foil / metallic, embroidery (thread colours, stitch density), appliqué / patch (sewn or bonded), embossed / debossed, laser etch, rhinestones / studs / metal badge, sublimation, woven label — and the FINISH (matte or gloss, flat or raised, cracked / distressed print). Say "unclear" if it cannot be determined.',
    'A PLAIN ZONE MUST STILL BE DESCRIBED. Write "flat, no pressed crease, no pleat" or "plain, no stripe or tape" or "none" rather than leaving the zone out. A zone you do not mention is a zone the image generator will fill in with whatever that kind of garment usually has — a crease down a trouser leg, a chest pocket on a shirt — so saying a zone is empty is as valuable as describing a busy one. Never write a zone you cannot see; put that under "uncertain" instead.',
    "Be exhaustive and specific (measurable where possible: e.g. 'five copper rivets on front pockets', 'contrast orange double topstitch on outseam', 'white silicone raised logo 4 cm wide on left chest'). Ignore any person, background, or styling in the photos — describe the product only.",
    ...(sortedViews
      ? [
          "VIEW LABELS ARE AUTHORITATIVE: the reference images below are grouped under GENERAL / FRONT / BACK headings chosen by the operator. Anything seen on a FRONT-labelled image gets placement \"front, …\"; anything on a BACK-labelled image gets placement \"back, …\". Never decide the side from the garment shape when a label is given. Text or graphics that appear on both a FRONT and a BACK image get one entry per side.",
        ]
      : []),
  ].join("\n");
}
