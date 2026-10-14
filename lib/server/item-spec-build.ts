/* eslint-disable @typescript-eslint/no-explicit-any */

import { LOCK_TEXT_MAX_BYTES, LOCK_TEXT_MAX_LINES, classifyBackView } from "@/lib/studio-item-spec";
import { getAccessoryKind } from "@/lib/accessoryShots";

/** An item type that puts the Studio in accessory mode (lib/accessoryShots.ts). */
export function isAccessoryItemType(itemType: string): boolean {
  return getAccessoryKind(itemType, "", itemType) !== null;
}

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

/** A measured size ("about one third of the chest width") replaces the bare
 *  adjective the description opens with — "large 'play' text … about one third
 *  of the chest width" contradicts itself, and the renders put the back-sized
 *  artwork on the front (2026-10-13). */
const LEADING_SIZE_WORD = /^\s*(?:very\s+)?(?:large|small|big|huge|oversized|tiny|medium|giant|massive|little)\b[\s,-]*/i;
function withoutSizeWord(description: string, size: string): string {
  return size ? description.replace(LEADING_SIZE_WORD, "") || description : description;
}

/** "technique / finish" suffix for graphic-type lines (omits unknowns). */
function applied(g: { technique?: string; finish?: string }): string {
  const t = text(g?.technique);
  const f = text(g?.finish);
  const parts = [t && !/unclear|unknown/i.test(t) ? t : "", f && !/unclear|unknown/i.test(f) ? f : ""].filter(Boolean);
  return parts.length ? ` — applied as ${parts.join(", ")}` : "";
}

/* A placement that names a STYLING piece — the tank under an overall, the tee
   under a jacket. Wayne Overall's spec locked the tank's print as product TEXT
   ("CAME" at front, top_under … Reproduce verbatim), and every panel printed a
   misread word on a piece that is not even for sale. The piece keeps its
   OUTFIT line, described in words. */
const STYLING_PLACEMENT = /\btop[_ ]under\b|\boutfit\b|\bstyling\b|\bworn (?:under|with)\b|\bunder(?:neath)? the (?:bib|jacket|overall|vest|coat)\b/i;

type DistressArea = { side?: string; where?: string; height?: string; kind?: string; size?: string; count?: unknown; relation?: string };

/** One DISTRESSING line per area, in camera words the mirror is applied to (resolveWearerSide). */
function distressLines(map: unknown): string[] {
  if (!Array.isArray(map)) return [];
  return (map as DistressArea[])
    .slice(0, 8)
    .map((a) => {
      const kind = text(a?.kind);
      if (!kind || NONE.test(kind)) return "";
      const side = text(a?.side).toLowerCase().startsWith("back") ? "back" : "front";
      const where = [text(a?.where), text(a?.height)].filter(Boolean).join(", ");
      const n = Number(a?.count);
      const count = Number.isInteger(n) && n > 1 ? `${n}× ` : "";
      const size = text(a?.size);
      const relation = text(a?.relation);
      // The side word comes first so resolveWearerSide mirrors the right view.
      return `DISTRESSING (${side}${where ? `, ${where}` : ""}): ${count}${kind}${size ? `, ${size}` : ""}${relation ? ` — ${relation}` : ""}.`;
    })
    .filter(Boolean);
}

/** Deterministic, prompt-ready numbered lock list built from the JSON spec.
 *
 *  Order matters because the list is byte-capped from the END: the lines
 *  that keep the generator from redesigning the garment — what it is, its
 *  FIT, what the BACK shows, and what must NOT be invented — come first, so
 *  a long hardware inventory can never push them off. */
export function buildLockText(spec: any, opts?: { accessory?: boolean }): string {
  /* A bracelet has no fabric to distress, no seams and no wash. Those keys are
     written for garments, and on jewellery they came back as "DISTRESSING:
     none — clean, undistressed fabric everywhere; do not add rips" — lines the
     generator is told to enforce, about cloth that is not there. */
  const fabricOnly = opts?.accessory === true;
  const lines: string[] = [];
  const push = (s: string, max = 220) => {
    const t = resolveWearerSide(s.replace(/\s+/g, " ").trim());
    if (t) lines.push(t.length > max ? `${t.slice(0, max - 3)}…` : t);
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
  /* Beads, charms and spacers as one ordered run, so a small worn shot that
     follows the words gets the pattern, not "evenly spaced beads". */
  const sequence = text(spec?.sequence);
  if (sequence && !NONE.test(sequence)) push(`SEQUENCE (from the clasp, all the way round): ${sequence}.`, 360);
  for (const t of (Array.isArray(spec?.text) ? spec.text : []) as TextItem[]) {
    const w = text(t?.text);
    if (!w || STYLING_PLACEMENT.test(text(t?.placement))) continue;
    push(
      `TEXT (exact spelling, case and letterforms): "${w}"${t.placement ? ` at ${text(t.placement)}` : ""}${t.style ? `, ${text(t.style)}` : ""}${t.color ? `, ${text(t.color)}` : ""}${applied(t)}. Reproduce verbatim — never paraphrase, translate, drop, or add letters.`,
    );
  }
  for (const lg of (Array.isArray(spec?.logos_icons) ? spec.logos_icons : []) as GraphicItem[]) {
    const d = text(lg?.description);
    if (!d || STYLING_PLACEMENT.test(text(lg?.placement))) continue;
    push(`LOGO/ICON: ${d}${lg.placement ? ` at ${text(lg.placement)}` : ""}${lg.size ? `, ${text(lg.size)}` : ""}${lg.colors ? ` (${text(lg.colors)})` : ""}${applied(lg)} — same mark, scale, position, colours and surface look (flat vs raised, matte vs gloss).`);
  }
  for (const gr of (Array.isArray(spec?.graphics_prints) ? spec.graphics_prints : []) as GraphicItem[]) {
    const d = withoutSizeWord(text(gr?.description), text(gr?.size));
    if (!d || STYLING_PLACEMENT.test(text(gr?.placement))) continue;
    push(`GRAPHIC/PRINT: ${d}${gr.placement ? ` at ${text(gr.placement)}` : ""}${gr.size ? `, ${text(gr.size)}` : ""}${gr.colors ? ` (${text(gr.colors)})` : ""}${applied(gr)} — same artwork, scale, position, colours and surface look.`);
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
  if (st && !(fabricOnly && NONE.test(st))) push(`STITCHING: ${st}.`);
  for (const s of list(spec?.pockets)) push(`POCKET: ${s}.`);
  const cl = text(spec?.closures);
  if (cl) push(`CLOSURE: ${cl}.`);
  /* "smooth, stretchy" let one panel draw matte jersey and the next a satin
     sheen (Karina, Brandi). The surface is its own required answer now and
     rides on the MATERIAL line. */
  const mt = text(spec?.materials_texture);
  const surface = text(spec?.surface);
  if (mt || surface) push(`MATERIAL/TEXTURE: ${[mt, surface ? `surface: ${surface}` : ""].filter(Boolean).join(" — ")}.`);
  const wf = text(spec?.wash_finish);
  if (wf && !(fabricOnly && NONE.test(wf))) push(`WASH/FINISH: ${wf}.`);
  const ds = text(spec?.distressing);
  const areas = fabricOnly ? [] : distressLines(spec?.distressing_map);
  if (areas.length) {
    /* A map, area by area, instead of "rips on front legs": each panel used to
       draw its own rips from the vague line. */
    for (const a of areas) push(a);
    push("DISTRESSING: nowhere else — every area not listed in a DISTRESSING line is clean, with no rips, fading or whiskering added.");
  } else if (ds && !NONE.test(ds)) push(`DISTRESSING: ${ds} — exact placement and extent, no more, no less.`);
  else if (ds && !fabricOnly) push("DISTRESSING: none — clean, undistressed fabric everywhere; do not add rips, fading, or whiskering.");
  const sp = text(spec?.seams_panels);
  if (sp && !(fabricOnly && NONE.test(sp))) push(`SEAMS/PANELS: ${sp}.`);
  const tr = text(spec?.trims_hems_cuffs_collar);
  if (tr && !(fabricOnly && NONE.test(tr))) push(`TRIMS/HEMS/CUFFS/COLLAR: ${tr}.`);
  for (const s of list(spec?.other_details)) push(`DETAIL: ${s}.`);
  /* The rest of the outfit in the photos. Last on purpose: the list is capped
     from the end, and the product's own lines must never be the ones dropped.
     The Studio reads these back to dress the model (lib/panelGeneration.ts
     buildStylingLock); the SEO writer skips them, since a jacket's description
     must not inherit the trousers it was photographed with. */
  const seen = spec?.outfit_seen;
  if (seen && seen.worn === true && Array.isArray(seen.pieces)) {
    const SLOTS = new Set(["top", "top_under", "bottom", "outerwear", "footwear", "accessories"]);
    const done = new Set<string>();
    for (const piece of seen.pieces.slice(0, 6)) {
      const slot = text(piece?.slot).toLowerCase().replace(/\s+/g, "_");
      const d = text(piece?.description);
      if (!SLOTS.has(slot) || !d || done.has(slot)) continue;
      done.add(slot);
      push(`OUTFIT — ${slot.toUpperCase().replace("_", " ")}: ${d}.`);
    }
  }
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

/*
 * The second, independent TEXT read. One gpt-4o pass misread "KOTN", "CARRON
 * JEANS" and a styling tank's "GAME", and nothing checked it. A second pass is
 * told only WHERE each text sits, never what the first pass read, so its
 * answer is a real second opinion; a disagreement goes to the operator as a
 * warning (lib/studio-item-spec.ts specRiskReport, code text_disagreement).
 */
export type TextReadEntry = { quoted: string; placement: string };

/** The product texts the lock list quotes, in the form the lock line carries them. A placement
 *  shared by two texts is left out: "the text at the back waistband" would not say which. */
export function textReadEntries(spec: any): TextReadEntry[] {
  const all = ((Array.isArray(spec?.text) ? spec.text : []) as TextItem[])
    .map((t) => ({ quoted: text(t?.text).replace(/\s+/g, " "), placement: text(t?.placement) }))
    .filter((e) => e.quoted && !STYLING_PLACEMENT.test(e.placement));
  const seen = new Map<string, number>();
  for (const e of all) seen.set(e.placement.toLowerCase(), (seen.get(e.placement.toLowerCase()) ?? 0) + 1);
  return all.filter((e) => e.placement && seen.get(e.placement.toLowerCase()) === 1).slice(0, 8);
}

export function buildTextReadInstruction(entries: TextReadEntry[]): string {
  return [
    "Read printed, stitched or woven text on a garment, letter by letter, from the photos below.",
    "For each numbered place, find the text that sits there and transcribe it EXACTLY as it appears: every letter, its case, its spacing and punctuation. Do not correct the spelling, do not complete a word you cannot fully see, and do not guess a brand name. If the text there is too small, too faint or in no photo, answer null.",
    'Places ("image-left" / "image-right" mean the side of the photograph):',
    ...entries.map((e, i) => `${i + 1}. ${e.placement}`),
    'Reply with JSON: {"readings":[{"n":1,"text":"..."}]} — one entry per place, "text": null when it cannot be read.',
  ].join("\n");
}

export function parseTextReadings(raw: string, entries: TextReadEntry[]): Array<{ quoted: string; reading: string | null }> {
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = String(raw || "").match(/\{[\s\S]*\}/);
    try {
      parsed = m ? JSON.parse(m[0]) : null;
    } catch {
      parsed = null;
    }
  }
  const rows: any[] = Array.isArray(parsed?.readings) ? parsed.readings : [];
  return entries.map((e, i) => {
    const row = rows.find((r) => Number(r?.n) === i + 1);
    const reading = typeof row?.text === "string" ? row.text.replace(/\s+/g, " ").trim() : "";
    return { quoted: e.quoted, reading: reading || null };
  });
}

const ACCESSORY_BRIEF = [
  "THIS IS AN ACCESSORY, NOT A GARMENT. The fabric keys (wash_finish, distressing, seams_panels, stitching, trims_hems_cuffs_collar) get \"none\" unless the piece genuinely has them.",
  "Describe it so a jeweller could rebuild it from your words alone:",
  "- the chain, cord or band by its trade name — ball chain, cable, curb, rope, snake, box, figaro, leather cord, elastic — and how fine or heavy it is;",
  "- every bead, stone or link: COUNT them, give their shape (round, faceted, rondelle, cube), size and colour, and the GROUPING exactly as it repeats, e.g. \"six clusters of three black faceted beads, each cluster separated by one tiny gold spacer bead\". Never write \"evenly spaced\" unless they really are single beads at equal intervals — the render follows your words, and a pattern described as even comes back even;",
  "- the SHAPE of each bead exactly: tube, round, faceted, rondelle, disc, cube, heishi, seed bead — a tube bead is never \"a bead\", a disc charm is never \"a round bead\";",
  "- return \"sequence\": the whole pattern as an explicit SEQUENCE starting at the clasp and going all the way round, every step with its count, e.g. \"clasp → gold disc ×1 → tube bead ×4 → white round bead ×1 → tube bead ×4 → gold disc ×1 → … → extender\". Every SPACER is its own step (tiny metal spacer beads, rondelles or knots between the beads); if there are none, the sequence says \"no spacers\". A repeating pattern may be written once with its repeat count, e.g. \"(black round ×1 → silver spacer ×1 → grey round ×1 → silver spacer ×1) ×7\". Count what you can see; what you cannot count goes under \"uncertain\";",
  "- each charm or pendant: its motif, shape, size compared with the beads, finish, and where it hangs;",
  "- the metal tone and finish: yellow gold, rose gold, silver; polished, matte, brushed;",
  "- the clasp — lobster, spring ring, toggle, magnetic, sliding knot — and any extender chain with the bead or charm at its end;",
  "- for sunglasses, hats, belts and bags: the frame or body shape, hardware, logos, straps and fastenings in the same detail.",
  "Do not estimate a length unless something in the photo shows the scale: a guessed length becomes a wrong size in the render.",
].join("\n");

export function buildSpecInstruction(itemType: string, sortedViews: boolean, productName?: string): string {
  const name = text(productName).replace(/"/g, "'").slice(0, 120);
  return [
    ...(isAccessoryItemType(itemType) ? [ACCESSORY_BRIEF] : []),
    `You are a garment technologist documenting a "${itemType}" for an exact-reproduction photo shoot. Inspect EVERY reference image at maximum detail and record ONLY what is clearly visible. Never guess; list unclear items under "uncertain".`,
    /* "Camille Double Pleated Trouser" came back "FRONT OF LEG: flat, no pressed
       crease, no pleat" — the plain-zone example below, copied onto a garment
       sold for its pleats. */
    ...(name
      ? [
          `The product is sold as "${name}". Every construction word in that name (pleated, ruched, cargo, chain, knot, zip, belted, wrap, ripped, drawstring, halter, cut-out …) is a feature buyers expect to see: find it in the photos and describe where it is and what it looks like. If you truly cannot see it, put it under "uncertain" — never write a line that says it is absent.`,
        ]
      : []),
    "Return STRICT JSON with these keys:",
    '{ "garment_type": string, "colorway": string, "materials_texture": string,',
    '  "surface": string — REQUIRED, read off the photos: exactly ONE sheen word (matte / soft sheen / satin / glossy / wet-look / metallic / sheer) then the TEXTURE (smooth / ribbed / knit / waffle / terry / fleece / twill / denim / crinkled / quilted / mesh / velvet / lace / sequinned / pleated / brushed), e.g. "glossy, smooth", "matte, ribbed"; for metal and beads: polished / matte / brushed metal, glossy / matte / frosted beads. Never "smooth" alone: a fabric with a sheen drawn matte is a different fabric,',
    '  "wash_finish": string, "distressing": string,',
    '  "distressing_map": [{ "side": "front" | "back", "where": string, "height": string, "kind": string, "size": string, "count": number, "relation": string }] — ONE entry per distressed area (rips, holes, frayed slits, abrasion, fading, whiskering), [] when there is none. "where" is what the camera sees: "image-left leg", "image-right leg", "both legs", "centre", "image-left side" — never the wearer\'s left or right. "height" is the band: waistband / upper thigh / mid-thigh / knee / shin / above the hem / hem (or chest / sleeve / hem for a top). "kind" says what it looks like ("open rip with white threads across", "small hole", "frayed slit", "light abrasion"), "size" how big against the leg or panel ("about half the leg width"), "count" how many, and "relation" how it sits against the others ("directly below the thigh rip", "the larger of the two", "level with the coin pocket"),',
    '  "hardware": string[] (each: item, count, finish/colour, exact location, AND its form in enough detail to redraw it — a chain needs its link shape, strand count, length and both attachment points; a zip needs tooth colour, pull shape and whether it sits inside or outside; a BUTTON needs its diameter AND how big it looks against the part it sits on (e.g. "about 2 cm, nearly as tall as the 4 cm waistband"), how many holes it has or whether it is a shank, its shape, and its material look (matte horn, glossy plastic, metal, fabric-covered) — a button described only as "round, dark" comes back as a small generic one — buttons, rivets, zips, eyelets, snaps, buckles, D-rings, chains),',
    '  "stitching": string (thread colour(s), single/double/triple topstitch, bar tacks, decorative stitching, where),',
    '  "pockets": string[] (type, count, placement, details), "closures": string, "seams_panels": string,',
    '  "outfit_seen": { "worn": boolean, "pieces": [{ "slot": "top" | "top_under" | "bottom" | "outerwear" | "footwear" | "accessories", "description": string }] } — the OTHER clothes in the photos, the ones that are not the product. worn=true when a photo shows the product worn by a person or styled together with other garments; then describe each other piece precisely enough to dress the model in it again: colour, cut, fit, length, rise, sleeve length and neckline for a top, sole and lace colour for shoes, fabric look, how it is worn (tucked, cuffed, open). Name the ONE thing you see — never "X or Y". Any print, text or graphic on such a piece is described in words in its description ("blue italic text print across the chest"), never quoted letter by letter. Use slot top_under for what is worn under a jacket, coat, vest or overall bib. Describe only what is clearly visible; a piece cut out of the frame is simply not listed. Never describe the person. worn=false and pieces=[] when the photos show the product alone (flat lay, hanger, ghost mannequin, product shot).',
    '  "construction_zones": [{ "zone": string, "detail": string }] — the design-bearing areas of THIS garment, each described well enough to rebuild it. For bottoms cover: waistband (height, flat or elasticated, pleats or none), closure/fly, belt loops (count or none), front pockets, back pockets, front of leg, back of leg, side seam, hem/cuff. THE CLOSURE IS THE MOST LOOKED-AT PART OF A WAISTBAND and "zip fly with button closure" is not enough to draw: say how the waistband actually fastens — a plain button on the band, or an extended or squared tab that reaches past the fly — which side laps over which, how far it reaches, how many buttons, and how large the button is against the band. For tops cover: neckline/collar, shoulder seam, chest, sleeve and cuff, side seam, hem, back yoke. For outerwear also: lapel/hood, front closure, pocket flaps, vents. For jewellery and accessories cover instead: chain, cord or band; beads or stones and how they are grouped; charm or pendant; clasp; extender — or for sunglasses, hats, belts and bags their frame or body, hardware, logo and fastening.',
    '  "text": [{ "text": exact characters as printed (keep case, punctuation, spacing), "placement": string, "style": string, "color": string, "technique": string }] — include EVERY word, number, logo wordmark, label text, embroidery and print lettering ON THE PRODUCT; transcribe letter-by-letter. Text on any OTHER piece in the photos (the tank under an overall, the tee under a jacket, the shoes) is NEVER a text entry, and neither are its logos or graphics: describe it in words in that piece\'s outfit_seen description,',
    '  "logos_icons": [{ "description": string, "placement": string, "size": string, "colors": string, "technique": string, "finish": string }] — every brand mark, symbol, icon, emblem, monogram, artwork or illustration; the CARBON brand mark (a cluster of linked hexagon outlines) is written "the Carbon logo (a cluster of linked hexagon outlines)", with its size against the label or garment and how it is applied,',
    '  "graphics_prints": [{ "description": string, "placement": string, "size": string, "colors": string, "technique": string, "finish": string }] — prints, patterns, artwork, embroidery, appliqués. SIZE is how big it is against the WHOLE side it sits on, read off an image that shows that whole side collar-to-hem, e.g. "about one third of the chest width", "about two thirds of the back width", "small, about the size of a palm" — never a bare "large" or "small", and never judged from a close-up,',
    '  "labels_patches": string[] — every OUTSIDE label or patch (leather / faux-leather jacron patch, woven label, rubber or printed badge), each described well enough to redraw it: its MATERIAL and colour (e.g. "black leather patch"), its shape and size against the part it sits on (e.g. "about half the height of the waistband, wider than tall"), the LAYOUT of what is on it (e.g. "logo on top, text underneath"), the exact text, every surface effect (white paint brushstroke behind the text, distressed or cracked print, embossing) and where it sits relative to the garment (e.g. "on the back waistband, just beside a belt loop, off centre"). Never call a leather patch a woven label. The CARBON logo is a cluster of linked hexagon outlines: write it as "the Carbon logo (a cluster of linked hexagon outlines)",',
    '  "trims_hems_cuffs_collar": string, "fit_silhouette": string, "other_details": string[], "uncertain": string[],',
    '  "photo_checks": [{ "image": number, "closeup": boolean }] — one entry per reference image, by the number in its "Image N" heading: closeup = it shows only part of the garment (a print or detail filling the frame, no complete collar-to-hem view of that side),',
    '  "back_state": "not_photographed" | "plain" | "design" — not_photographed when NO image shows the back of the garment; plain when a back view (a BACK-labelled image, or an unmistakable back view) shows the back carries no print, text, graphic, logo or patch; design when a back view shows something on the back,',
    '  "back_view": string — for "design": a short description of everything on the back (each element must also appear in text / logos_icons / graphics_prints with placement "back, …"); for "plain": "plain"; for "not_photographed": "not photographed" }',
    'PLACEMENT must always name the SIDE and zone: e.g. "front, image-right shoulder near collar", "back, lower centre", "front, image-left sleeve". Every placement starts with "front, " or "back, " so the mirror can be resolved. Text that appears on more than one side gets one entry per side. STYLE must describe the print EFFECT when present: motion-blur / ghosted edges, faded, gradient, halftone, cracked / distressed, outline, 3D / shadowed, italic / bold / condensed, letter-spacing.',
    'NEVER WRITE A BARE "LEFT" OR "RIGHT", AND NEVER WORK OUT WHICH SIDE OF THE BODY A DETAIL IS ON. Report only what you can see: write "image-left" or "image-right", meaning the side of the PHOTOGRAPH the detail appears on, e.g. "front, image-right near the waistband". Converting that to the wearer\'s left or right is a mirror, it is done for you afterwards in code, and every attempt to do it here has come out backwards and put the detail on the wrong hip in every picture generated from it. Describe the picture; leave the mirror alone. (Centre, upper, lower, hem, cuff, collar and so on stay exactly as they are — only the words left and right are affected.)',
    'FIT_SILHOUETTE must be specific: oversized / boxy / drop-shoulder / relaxed / regular / slim / cropped / longline, sleeve length and shape, body length, hem shape, neckline (crew / V / ribbed collar width).',
    'CLOSE-UPS GIVE DETAIL, NOT SIZE. A close-up makes a small print look huge and hides where it sits. Take every SIZE and POSITION from the image(s) that show the whole front or the whole back; use close-ups only for lettering, colours and edges. When the same artwork appears on the front and the back, size each one from its own side — a medium chest print and a large back print are different sizes, never copy one size onto the other. If a side has only close-ups, write its sizes under "uncertain". A sideways or upside-down image is still the side it is labelled as: read it rotated, and the collar end is always the top.',
    'For every logo, icon, graphic and text: state the APPLICATION TECHNIQUE as seen — heat transfer / vinyl, screen print, silicone or high-density raised print, puff print, foil / metallic, embroidery (thread colours, stitch density), appliqué / patch (sewn or bonded), embossed / debossed, laser etch, rhinestones / studs / metal badge, sublimation, woven label — and the FINISH (matte or gloss, flat or raised, cracked / distressed print). Say "unclear" if it cannot be determined.',
    'A PLAIN ZONE MUST STILL BE DESCRIBED — but only once you have looked: a zone that HAS pleats, ruching, a crease, a seam or a panel says so; the wording here is for a zone that is really empty, never a default. Write "flat, no pressed crease, no pleat" or "plain, no stripe or tape" or "none" rather than leaving an empty zone out. A zone you do not mention is a zone the image generator will fill in with whatever that kind of garment usually has — a crease down a trouser leg, a chest pocket on a shirt — so saying a zone is empty is as valuable as describing a busy one. Never write a zone you cannot see; put that under "uncertain" instead.',
    "Be exhaustive and specific (measurable where possible: e.g. 'five copper rivets on front pockets', 'contrast orange double topstitch on outseam', 'white silicone raised logo 4 cm wide on left chest'). Ignore the person and the background. Every key above describes the PRODUCT only — the clothes worn WITH it go in outfit_seen and nowhere else, so a pair of trousers styled under a jacket never becomes a detail of the jacket.",
    ...(sortedViews
      ? [
          "VIEW LABELS ARE AUTHORITATIVE: the reference images below are grouped under GENERAL / FRONT / BACK headings chosen by the operator. Anything seen on a FRONT-labelled image gets placement \"front, …\"; anything on a BACK-labelled image gets placement \"back, …\". Never decide the side from the garment shape when a label is given. Text or graphics that appear on both a FRONT and a BACK image get one entry per side.",
        ]
      : []),
  ].join("\n");
}
