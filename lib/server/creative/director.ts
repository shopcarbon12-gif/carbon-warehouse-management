/**
 * CarbonWMS Creative — the AI Creative Director (spec §7.2). Builds the brief automatically
 * (Product Twin + style lane + season + Brand Brain + top 20 Radar winners in the same lane and
 * media type + CARBON's own past winners), pitches 3 concepts, then writes the pro shot list for
 * the chosen one. Radar ads are used for STRUCTURE only (spec §11): their structure summaries,
 * hooks as ideas and patterns go in; never their logos, text, people or pictures.
 */
import type { Pool } from "pg";
import { z } from "zod";
import { brandBlock, getBrand, presetOf, UGC_FORMATS } from "./config";
import { json } from "./llm";
import { listRecipes } from "./recipes";
import { currentSeason, topWinners } from "./radar/query";
import { getTwin } from "./twin";
import { ownWinners } from "./learning";

export const MODIFIERS = { crazier: "Push it further: bolder hooks, stranger angles, more pattern interrupts — still on-brand.", luxury: "More luxury: slower, quieter, deep blacks, editorial negative space, fewer words.", new: "Completely new ideas — none of the previous concepts' recipes or hooks." } as const;
export type Modifier = keyof typeof MODIFIERS;

/**
 * The model's JSON is not schema-enforced (strict: false), so it sometimes writes "9x16", "Vertical",
 * "Dolly in" or a sentence one word too long — and the whole step failed (owner, 2026-11-14:
 * "Invalid option: expected one of 9:16|4:5|1:1"). Close answers are mapped; anything else falls
 * back to a safe choice; over-long text is cut.
 */
const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);
function looseEnum<const T extends readonly [string, ...string[]]>(values: T, fallback: T[number], alias: (s: string) => string | null = () => null) {
  return z.preprocess((v) => {
    const s = norm(v);
    if (typeof s !== "string") return fallback;
    const exact = values.find((x) => x.toLowerCase() === s);
    if (exact) return exact;
    const flat = s.replace(/[\s-]+/g, "_");
    return values.find((x) => x.toLowerCase() === flat) ?? alias(s) ?? fallback;
  }, z.enum(values));
}
const clip = (n: number) => z.preprocess((v) => (typeof v === "string" ? [...v].slice(0, n).join("") : v), z.string().max(n));
const formatAlias = (s: string) => {
  const r = s.replace(/\s/g, "").replace(/[x×/]/g, ":");
  if (r.startsWith("9:16") || /vertical|portrait|story|stories|reel|tiktok/.test(s)) return "9:16";
  if (r.startsWith("4:5") || /feed/.test(s)) return "4:5";
  if (r.startsWith("1:1") || /square/.test(s)) return "1:1";
  return null;
};
const AspectFormat = looseEnum(["9:16", "4:5", "1:1"] as const, "9:16", formatAlias);

/** How a storyboard frame is framed — drives the preview's lens so a "macro" frame really is a close detail. */
export const FRAMINGS = ["macro", "close_up", "medium", "full_body", "wide"] as const;
const Framing = looseEnum(FRAMINGS, "medium", (s) =>
  /macro|extreme|detail/.test(s) ? "macro" : /close/.test(s) ? "close_up" : /full|head.to.toe/.test(s) ? "full_body" : /wide|establish/.test(s) ? "wide" : null,
);
/**
 * Each concept's own visual world (owner, 2026-11-14: "three different concepts looking the same in the
 * pictures") — the previews and the shot list use it instead of one shared preset look.
 */
const ConceptLook = z.preprocess(
  (v) => (v && typeof v === "object" ? v : { location: "", light: "", palette: "" }),
  z.object({ location: clip(160), light: clip(120), palette: clip(120) }),
);

export const Concept = z.object({
  title: clip(60),
  idea: clip(220),
  hook: z.object({ first_1_5s: clip(200), text: clip(60).nullable(), why: clip(220) }),
  recipe_key: z.string(),
  edit_recipe: clip(300),
  storyboard: z.array(z.object({ frame: z.number().int(), framing: Framing, shot: clip(160), text: clip(60).nullable() })).min(4).max(8),
  look: ConceptLook,
  music: z.object({ mood: z.string(), bpm: z.number() }),
  length_s: z.number(),
  format: AspectFormat,
  cast_count: z.number().int().min(1).max(4),
  inspired_by: z.array(z.string()).max(3),
});
export type Concept = z.infer<typeof Concept>;
const Concepts = z.object({ concepts: z.array(Concept).length(3) });

export const Shot = z.object({
  idx: z.number().int(),
  subject_action: clip(300),
  camera_move: looseEnum(["static", "dolly_in", "dolly_out", "orbit", "whip_pan", "crash_zoom", "handheld_follow", "top_down", "low_angle", "tracking_side", "push_in", "tilt_up"] as const, "static"),
  lens: looseEnum(["24mm", "35mm", "50mm", "85mm", "macro"] as const, "35mm", (x) => (/macro/.test(x) ? "macro" : ((m) => (m ? `${m[1]}mm` : null))(x.match(/\b(24|35|50|85)\s*mm/)))),
  lighting: clip(80),
  location: clip(120),
  duration_s: z.number().min(0.5).max(10),
  transition_in: clip(40),
  garment_must_show: clip(200),
  cast: z.array(z.string()).max(4), // model ids
  products: z.array(z.string()).max(4), // product ids worn in this shot
  text_overlay: clip(80).nullable(),
  is_end_card: z.boolean(),
  is_static_frame: z.boolean(), // freeze / still is enough (no video clip needed)
  still_prompt: clip(1200),
  motion_prompt: clip(900),
  sfx: z.array(z.string()).max(3),
  /** UGC: what the creator says out loud in this shot (the video engine speaks it), or null. */
  say: z.preprocess((v) => (typeof v === "string" && v.trim() ? [...v].slice(0, 160).join("") : null), z.string().nullable()).optional(),
  /**
   * A shot where something changes on camera (off the hanger → wearing it, bag → held up): what the
   * LAST frame shows. A second picture is drawn for it and the video engine moves from one to the other,
   * so the clothes are right at the end instead of morphing (owner, 2026-11-15).
   */
  end_state: z.preprocess((v) => (typeof v === "string" && v.trim() ? [...v].slice(0, 300).join("") : null), z.string().nullable()).optional(),
  /** The ONE shot where the garment goes from not worn to worn (off the hanger / out of the bag → on). */
  puts_on: z.preprocess((v) => v === true || v === "true", z.boolean()).optional(),
});
export type Shot = z.infer<typeof Shot>;
export const ShotList = z.object({
  shots: z.array(Shot).min(2).max(14),
  music: z.object({ mood: z.string(), bpm: z.number() }),
  captions: z.array(z.string()).max(3),
  /** What each person wears besides the product, the SAME in every shot (owner, 2026-11-15: shorts in one shot, sweatpants in the next). */
  outfit: z.preprocess((v) => (typeof v === "string" && v.trim() ? [...v].slice(0, 300).join("") : null), z.string().nullable()).optional(),
});
export type ShotList = z.infer<typeof ShotList>;

export type Brief = {
  kind: string;
  preset: string;
  lane: string | null;
  season: { key: string; label: string };
  products: { id: string; facts: Record<string, unknown> | null; details: string[] }[];
  cast: { id: string; name: string; gender: string; look: string | null; personality: string | null }[];
  locations: { name: string; description: string }[];
  radar: { advertiser: string; pattern: string[]; hook: string; structure: string; score: number }[];
  own: string[];
  inspiration: { structure: string; hook: string; patterns: string[] } | null;
  brand: string;
};

export async function buildBrief(pool: Pool, tenantId: string, p: { kind: string; products: string[]; preset: string; cast: { id: string; name: string; gender: string; look: string | null; personality: string | null }[]; inspirationAdId?: string | null }): Promise<Brief> {
  const brand = await getBrand(pool, tenantId);
  const twins = await Promise.all(p.products.map((id) => getTwin(pool, tenantId, id)));
  const laneOf = (f: Record<string, unknown> | null) => {
    const t = `${f?.title ?? ""} ${f?.type ?? ""} ${(f?.collections as string[] | undefined)?.join(" ") ?? ""}`.toLowerCase();
    if (/dress|gown|satin|corset|evening/.test(t)) return "evening_going_out";
    if (/jean|denim/.test(t)) return "denim";
    if (/blazer|velvet|cashmere|luxe/.test(t)) return "luxury";
    return "streetwear";
  };
  const lane = laneOf(twins[0]?.facts ?? null);
  const mediaType = p.kind === "static" ? "static" : p.kind === "ugc" ? "ugc" : p.kind === "animated" ? "animated" : "video";
  let winners = await topWinners(pool, tenantId, { lane, mediaType, limit: 20 });
  if (winners.length < 8) winners = [...winners, ...(await topWinners(pool, tenantId, { lane, limit: 20 - winners.length }))];
  const locs = await pool.query(`SELECT name, description FROM creative_locations WHERE tenant_id = $1::uuid ORDER BY created_at LIMIT 20`, [tenantId]);
  let inspiration: Brief["inspiration"] = null;
  if (p.inspirationAdId) {
    const a = await pool.query(`SELECT tags FROM creative_ads WHERE id = $1::uuid AND tenant_id = $2::uuid`, [p.inspirationAdId, tenantId]);
    const t = a.rows[0]?.tags;
    if (t) inspiration = { structure: t.structure_summary, hook: t.hook_text, patterns: t.creative_pattern };
  }
  return {
    kind: p.kind,
    preset: p.preset,
    lane,
    season: currentSeason(),
    products: twins.map((t, i) => ({ id: p.products[i], facts: t?.facts ?? null, details: (t?.details ?? []).map((d: { kind: string; note?: string }) => `${d.kind}: ${d.note ?? ""}`) })),
    cast: p.cast,
    locations: locs.rows.length ? locs.rows : [{ name: presetOf(brand, p.preset).name, description: presetOf(brand, p.preset).look }],
    radar: winners.map((w) => ({ advertiser: "a winning brand", pattern: w.tags?.creative_pattern ?? [], hook: w.tags?.hook_text ?? "", structure: w.tags?.structure_summary ?? "", score: w.winner_score ?? 0 })),
    own: await ownWinners(pool, tenantId),
    inspiration,
    brand: brandBlock(brand, p.preset, p.kind === "ugc"),
  };
}

function briefText(b: Brief, recipes: { key: string; name: string; idea: string; media_types: string[] }[]): string {
  return [
    b.brand,
    `FORMAT: ${b.kind} for Instagram (Feed 4:5, Reels/Stories 9:16). Season now: ${b.season.label}. Style lane: ${b.lane}.`,
    `PRODUCTS (facts are the ONLY claims allowed):\n${b.products.map((p, i) => `  P${i + 1} [${p.id}]: ${JSON.stringify(p.facts ?? { note: "no twin yet" })}${p.details.length ? ` · details: ${p.details.join("; ")}` : ""}`).join("\n")}`,
    `CAST: ${b.cast.map((c) => `${c.name} [${c.id}] (${c.gender}${c.look ? `, ${c.look}` : ""}${c.personality ? `, ${c.personality}` : ""})`).join("; ")}`,
    `LOCATIONS: ${b.locations.map((l) => `${l.name} — ${l.description}`).join("; ")}`,
    `WHAT IS WINNING in this lane right now (structure only — never copy a brand, its logo, text or people):\n${b.radar.slice(0, 20).map((r) => `  · [${r.pattern.join(", ")}] hook: "${r.hook}" — ${r.structure} (score ${r.score})`).join("\n") || "  (Radar is still empty)"}`,
    b.own.length ? `WHAT WORKS FOR CARBON (real results):\n${b.own.map((o) => `  · ${o}`).join("\n")}` : "",
    b.inspiration ? `USE THIS RADAR AD AS INSPIRATION (structure only): ${b.inspiration.structure} · hook idea: ${b.inspiration.hook} · patterns: ${b.inspiration.patterns.join(", ")}` : "",
    `EDIT RECIPES you can use (recipe_key):\n${recipes.map((r) => `  · ${r.key}: ${r.name} — ${r.idea} (${r.media_types.join("/")})`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function pitchConcepts(pool: Pool, tenantId: string, brief: Brief, opts: { modifier?: Modifier | null; previous?: Concept[]; projectId: string }): Promise<Concept[]> {
  const recipes = (await listRecipes(pool, tenantId, { status: "active" })).filter((r) => r.media_types.includes(brief.kind === "ugc" ? "ugc" : brief.kind) || brief.kind === "video");
  const prompt = [
    "You are CARBON's Creative Director. Pitch exactly 3 different concepts for this ad.",
    briefText(brief, recipes),
    opts.modifier ? `OWNER ASKED: ${MODIFIERS[opts.modifier]}` : "",
    opts.previous?.length ? `PREVIOUS CONCEPTS (don't repeat): ${opts.previous.map((c) => `${c.title} (${c.recipe_key})`).join("; ")}` : "",
    "For each concept: title; one-line idea; the HOOK — what happens in the first 1.5 s and why it stops the scroll (hook.text = the on-screen words, or null); recipe_key (one of the recipes above);",
    "edit_recipe (cuts, pacing, transitions in one line); look = the concept's OWN visual world: location (a specific place), light (source, direction, time of day) and palette (2–3 colours); a 4–8 frame storyboard where each frame has a framing (macro, close_up, medium, full_body or wide) and a shot that matches it; music mood + BPM (the owner likes deep / tech / dark afro house around 118–126 BPM); length_s; format = exactly one of \"9:16\", \"4:5\" or \"1:1\"; cast_count; inspired_by = which winning patterns it builds on.",
    brief.kind === "static" ? "This is a STATIC (or carousel): storyboard frames = the slides; length_s = 0." : "",
    brief.kind === "ugc"
      ? `This is AI UGC — it must feel and look like a REAL person filmed it on their phone, never like a campaign shoot. It must never pretend to be a real customer or invent reviews.\n${UGC_FORMATS}\nThe 3 concepts use 3 DIFFERENT UGC formats and 3 different everyday places (e.g. bedroom mirror, car front seat, apartment by the window, fitting room, daytime sidewalk). look.light is plain natural or room light. Storyboard frames are what the phone sees. Ignore any instruction below about cinematic places or lights.`
      : "",
    brief.kind === "ugc" ? "" : "The 3 concepts must LOOK different at a glance, not only cut differently: three different kinds of place (e.g. a night street, a warm interior, a clean studio, a rooftop at dusk, daylight architecture — never two of the same kind), three different lights and three different palettes, each still true to the brand's look. Vary the framing too: every concept has at least one macro or close_up frame and at least one full_body or wide frame.",
    "FACTS ONLY: describe only the fabric, colour, wash, hardware and details the PRODUCTS facts and detail crops show. Never call a piece denim (or any other fabric) unless its facts say so — a black knit dress is not denim.",
    "Never invent facts, reviews, ratings or numbers. Never name other brands.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const r = await json(pool, prompt, Concepts, { tenantId, what: "creative director: 3 concepts", projectId: opts.projectId, maxOutputTokens: 6000 });
  return r.value.concepts;
}

export async function writeShotList(pool: Pool, tenantId: string, brief: Brief, concept: Concept, projectId: string): Promise<ShotList> {
  const recipes = await listRecipes(pool, tenantId);
  const recipe = recipes.find((r) => r.key === concept.recipe_key);
  const prompt = [
    "You are CARBON's Creative Director writing the PRO SHOT LIST for the chosen concept.",
    briefText(brief, recipe ? [recipe] : []),
    "FACTS ONLY: describe only the fabric, colour, wash, hardware and details the PRODUCTS facts and detail crops show. Never call a piece denim (or any other fabric) unless its facts say so — a black knit dress is not denim.",
    `CHOSEN CONCEPT: ${JSON.stringify(concept)}`,
    brief.kind === "ugc"
      ? `UGC SHOT LIST — the whole video must look like a real person filmed it on a phone.\n${UGC_FORMATS}\nIf the concept is cinematic (night sets, moody light, orbits, macro beauty shots), REWRITE it into the closest UGC format in an everyday place with natural light — keep only the product and the idea. camera_move: static (phone on a shelf / selfie), handheld_follow (a friend holds the phone) or push_in (phone moves closer) — nothing else. lens: 24mm (phone camera). 3–6 shots of 2–4 s plus the end card. say: the creator script's lines WORD FOR WORD, in order, spread over the shots (never rewrite them into slogans), or null when the creator doesn't talk. text_overlay: null on every UGC shot (no on-screen titles or subtitles at all). At most ONE shot may show putting the piece on (off the hanger / out of the bag → wearing it): mark it puts_on true, its still_prompt = the moment BEFORE (garment on the hanger / in the bag / in their hands) and end_state = the moment AFTER (now wearing it). Shots before it show the piece not worn yet; every shot after it shows the creator wearing it. If the concept doesn't need putting it on, no shot has puts_on and the creator wears it in every shot. still_prompt always says it is a frame from a phone video in that everyday place with natural light.`
      : "",
    brief.kind !== "ugc" && concept.look?.location ? `Shoot it in the concept's own look — location: ${concept.look.location}; light: ${concept.look.light}; palette: ${concept.look.palette}. Keep every shot in that world unless the concept calls for a cut to another place.` : "",
    // UGC shows no on-screen words, so its recipe beats go in without their text cues (review 2026-11-15).
    recipe ? `RECIPE BEATS: ${JSON.stringify(brief.kind === "ugc" ? recipe.structure.beats.map((b) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== "text"))) : recipe.structure.beats)}` : "",
    "Every shot: subject_action, camera_move, lens, lighting (hard sun / sodium streetlight / neon rim / softbox / on-camera flash / soft directional …), location (from LOCATIONS), duration_s, transition_in,",
    "garment_must_show (which detail of which product must be visible), cast (model ids from CAST), products (product ids from PRODUCTS worn in the shot), text_overlay (short, or null), is_end_card, is_static_frame (true ONLY for the end card — every other shot becomes a real video clip of a moving person),",
    "say (what the person says out loud in the shot, or null); puts_on + end_state ONLY for the single shot where the piece is put on (end_state = what the last frame shows, e.g. 'now wearing the jacket, zipped'); every other shot: puts_on false and end_state null — never use end_state to describe where a normal shot ends.",
    "outfit: one line — what each person wears besides the product (bottoms / shoes / underlayer, e.g. 'barefoot, hair down, small gold hoops'), kept IDENTICAL in every shot. The product is worn the same way in every shot where it is worn.",
    "still_prompt: the first-frame picture for the image model — describe the scene, pose, camera, lens and light; say the person is the CAST reference and the clothes are the PRODUCT references, exactly as given; no text, no logos except the garment's own print;",
    "motion_prompt: what moves in the clip, for the video model (camera move, body motion, fabric motion), one or two sentences; sfx: up to 3 sound effects (whoosh, fabric rustle, shutter, bass hit …).",
    `Total length close to ${concept.length_s || "the concept's"} s. The last shot is the CARBON end card (is_end_card true).`,
    "captions: 3 Instagram caption options in the brand voice, facts only.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const r = await json(pool, prompt, ShotList, { tenantId, what: "creative director: shot list", projectId, maxOutputTokens: 9000 });
  return { ...r.value, shots: r.value.shots.map((s, i) => ({ ...s, idx: i })) };
}
