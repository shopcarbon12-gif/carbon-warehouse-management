/**
 * CarbonWMS Creative — the Edit Recipe Library (spec §7.3). 15 seed recipes, stored in the DB per
 * tenant (seeded on first use). Each recipe is a structure the Creative Director fills with CARBON
 * products, cast and locations; the Auto-Editor turns its beats into cuts on the music.
 */
import type { Pool } from "pg";

export type RecipeBeat = { label: string; seconds: number; shot: string; transition: string; text?: string };
export type RecipeStructure = {
  beats: RecipeBeat[];
  pacing: "fast" | "medium" | "slow";
  music: { mood: string; bpm: [number, number] };
  length: [number, number];
  crew?: boolean;
  ugc?: boolean;
  patterns: string[];
};

const r = (key: string, name: string, idea: string, media: string[], s: RecipeStructure) => ({ key, name, idea, media, structure: s });

export const SEED_RECIPES = [
  r("outfit_swap_match_cut", "Outfit swap match-cut", "Same pose; a jump / clap / spin and a new fit lands on every beat.", ["video"], {
    beats: [
      { label: "Hook pose", seconds: 1.2, shot: "full body, locked-off, model in fit 1, looks into lens", transition: "match_cut", text: "hook" },
      { label: "Swap 1", seconds: 1.5, shot: "same framing and pose, spin → fit 2", transition: "match_cut" },
      { label: "Swap 2", seconds: 1.5, shot: "same framing, jump → fit 3", transition: "match_cut" },
      { label: "Swap 3", seconds: 1.5, shot: "same framing, clap → fit 4", transition: "flash_frame" },
      { label: "Hero hold", seconds: 2.5, shot: "push-in on the hero fit, detail moment", transition: "hard_cut", text: "product + price" },
      { label: "End card", seconds: 1.6, shot: "CARBON end card", transition: "fade" },
    ],
    pacing: "fast", music: { mood: "tech house", bpm: [122, 128] }, length: [8, 12], patterns: ["outfit_grid", "pattern_interrupt"],
  }),
  r("fabric_macro_reveal", "Fabric macro → full look reveal", "Start on the wash / stitching in macro, pull out to the whole look on the drop.", ["video"], {
    beats: [
      { label: "Macro", seconds: 1.5, shot: "macro lens on the fabric / wash / stitching, slow slide", transition: "hard_cut", text: "hook" },
      { label: "Macro 2", seconds: 1.2, shot: "macro on hardware or graphic", transition: "whip_pan" },
      { label: "Reveal", seconds: 2.5, shot: "fast pull-back / dolly-out to full look", transition: "zoom_punch" },
      { label: "Walk", seconds: 2.5, shot: "walking toward camera, low angle", transition: "hard_cut", text: "product + price" },
      { label: "End card", seconds: 1.6, shot: "CARBON end card", transition: "fade" },
    ],
    pacing: "medium", music: { mood: "deep house", bpm: [118, 124] }, length: [8, 12], patterns: ["material_detail_as_proof", "slow_mo_fabric"],
  }),
  r("day_to_night_walk", "Day-to-night walk", "One continuous walk: street in daylight → neon night, the outfit stays the hero.", ["video"], {
    beats: [
      { label: "Day walk", seconds: 2.5, shot: "handheld follow, daylight street", transition: "match_cut", text: "hook" },
      { label: "Dusk", seconds: 2, shot: "same walk, golden hour, side tracking", transition: "match_cut" },
      { label: "Night", seconds: 2.5, shot: "same walk, neon rim light, wet ground", transition: "flash_frame" },
      { label: "Hero", seconds: 2, shot: "stop, turn to camera, detail on the garment", transition: "hard_cut", text: "product + price" },
      { label: "End card", seconds: 1.6, shot: "CARBON end card", transition: "fade" },
    ],
    pacing: "medium", music: { mood: "dark afro house", bpm: [118, 124] }, length: [9, 13], patterns: ["lookbook_editorial"],
  }),
  r("speed_ramp_freeze_slam", "Speed-ramp walk-in → freeze → text slam", "Slow walk ramps to fast, freezes on the drop, a word slams in.", ["video"], {
    beats: [
      { label: "Walk in", seconds: 2.5, shot: "low angle 24mm, model walks in, speed ramp slow→fast", transition: "hard_cut", text: "hook" },
      { label: "Freeze", seconds: 1.5, shot: "freeze frame on the drop", transition: "zoom_punch", text: "slam word" },
      { label: "Details", seconds: 2, shot: "two quick detail cuts on beats", transition: "flash_frame" },
      { label: "Hero", seconds: 2, shot: "full look, hold", transition: "hard_cut", text: "product + price" },
      { label: "End card", seconds: 1.6, shot: "CARBON end card", transition: "fade" },
    ],
    pacing: "fast", music: { mood: "tech house", bpm: [124, 130] }, length: [8, 11], patterns: ["pattern_interrupt", "headline_claim"],
  }),
  r("fit_check_mirror", "Fit check mirror (UGC)", "Phone-in-hand mirror fit check, creator talks through the fit and fabric.", ["ugc"], {
    beats: [
      { label: "Hook line", seconds: 1.5, shot: "mirror selfie, phone visible, creator says the hook", transition: "hard_cut", text: "captions" },
      { label: "Fit", seconds: 3, shot: "turns side and back in the mirror", transition: "jump_cut", text: "captions" },
      { label: "Fabric", seconds: 2.5, shot: "close to the mirror, touches the fabric / wash", transition: "jump_cut", text: "captions" },
      { label: "CTA", seconds: 2, shot: "back to front, says where to get it", transition: "hard_cut", text: "product + price" },
    ],
    pacing: "medium", music: { mood: "lo-fi house", bpm: [110, 120] }, length: [8, 14], ugc: true, patterns: ["fit_check_mirror", "try_on_haul"],
  }),
  r("three_ways_split", "3 ways to style it → split-screen finale", "One hero piece, three looks, ending on a 3-way split screen.", ["video", "animated"], {
    beats: [
      { label: "Hook", seconds: 1.3, shot: "hero piece alone, hanger or flat", transition: "hard_cut", text: "1 piece, 3 ways" },
      { label: "Look 1", seconds: 2, shot: "street look, full body", transition: "whip_pan", text: "01" },
      { label: "Look 2", seconds: 2, shot: "evening look, full body", transition: "whip_pan", text: "02" },
      { label: "Look 3", seconds: 2, shot: "luxury look, full body", transition: "whip_pan", text: "03" },
      { label: "Split", seconds: 2.5, shot: "3-way split screen of the looks", transition: "mask_wipe", text: "product + price" },
      { label: "End card", seconds: 1.6, shot: "CARBON end card", transition: "fade" },
    ],
    pacing: "fast", music: { mood: "deep house", bpm: [120, 124] }, length: [10, 14], patterns: ["styling_3_ways"],
  }),
  r("drop_countdown", "Drop countdown", "Dark teaser, glitch cuts, the date slams in.", ["video", "animated"], {
    beats: [
      { label: "Dark tease", seconds: 1.5, shot: "silhouette, rim light only", transition: "glitch", text: "hook" },
      { label: "Glimpse 1", seconds: 1, shot: "1-frame detail flashes", transition: "glitch" },
      { label: "Glimpse 2", seconds: 1, shot: "another detail", transition: "glitch" },
      { label: "Reveal", seconds: 2, shot: "the piece lit for the first time", transition: "flash_frame" },
      { label: "Date slam", seconds: 2, shot: "black, date + time", transition: "hard_cut", text: "date" },
    ],
    pacing: "fast", music: { mood: "dark afro house", bpm: [120, 126] }, length: [7, 10], patterns: ["drop_countdown"],
  }),
  r("street_casting_pov", "Street casting POV interview (AI UGC, labelled)", "POV mic-in-frame street interview about the fit. Clearly AI, never presented as a real customer.", ["ugc"], {
    beats: [
      { label: "Question", seconds: 1.5, shot: "POV, mic in frame, model on the street", transition: "hard_cut", text: "captions" },
      { label: "Answer", seconds: 3.5, shot: "model answers, shows the fit", transition: "jump_cut", text: "captions" },
      { label: "Detail", seconds: 2, shot: "points at the detail", transition: "jump_cut", text: "captions" },
      { label: "CTA", seconds: 2, shot: "says shopcarbon.com", transition: "hard_cut", text: "product + price" },
    ],
    pacing: "medium", music: { mood: "street ambience + light beat", bpm: [95, 110] }, length: [9, 14], ugc: true, patterns: ["street_casting"],
  }),
  r("orbit_freeze_callouts", "Orbit freeze with animated callouts", "Camera orbits the model, freezes, animated lines call out the details.", ["video", "animated"], {
    beats: [
      { label: "Orbit", seconds: 3, shot: "360 orbit around the model, 50mm", transition: "hard_cut", text: "hook" },
      { label: "Freeze + callouts", seconds: 3, shot: "freeze, callout lines to 2–3 details", transition: "zoom_punch", text: "callouts" },
      { label: "Hero", seconds: 2, shot: "full look", transition: "hard_cut", text: "product + price" },
      { label: "End card", seconds: 1.6, shot: "CARBON end card", transition: "fade" },
    ],
    pacing: "medium", music: { mood: "tech house", bpm: [122, 126] }, length: [8, 11], patterns: ["feature_callout"],
  }),
  r("price_anchor_punch", "Price anchor punch", "\"This fit under $X\" — pieces land one by one, the total animates.", ["video", "animated", "static"], {
    beats: [
      { label: "Claim", seconds: 1.5, shot: "full look, text: this fit under $X", transition: "zoom_punch", text: "price claim" },
      { label: "Piece 1", seconds: 1.3, shot: "piece 1 with its price", transition: "hard_cut", text: "piece price" },
      { label: "Piece 2", seconds: 1.3, shot: "piece 2 with its price", transition: "hard_cut", text: "piece price" },
      { label: "Total", seconds: 2, shot: "full look, animated total", transition: "flash_frame", text: "total" },
      { label: "End card", seconds: 1.6, shot: "CARBON end card", transition: "fade" },
    ],
    pacing: "fast", music: { mood: "tech house", bpm: [124, 128] }, length: [7, 10], patterns: ["price_anchor", "offer_and_value"],
  }),
  r("flatlay_to_life", "Flatlay to life", "The flat-lay morphs into the model wearing it.", ["video"], {
    beats: [
      { label: "Flat-lay", seconds: 1.5, shot: "top-down flat-lay of the outfit", transition: "morph", text: "hook" },
      { label: "To life", seconds: 3, shot: "same framing, the model now wears it, top-down lying pose", transition: "hard_cut" },
      { label: "Stand", seconds: 2.5, shot: "standing full look", transition: "hard_cut", text: "product + price" },
      { label: "End card", seconds: 1.6, shot: "CARBON end card", transition: "fade" },
    ],
    pacing: "medium", music: { mood: "deep house", bpm: [118, 124] }, length: [8, 11], patterns: ["outfit_grid"],
  }),
  r("crew_walk", "Crew walk", "2–4 models walk in sync, each in their CARBON pieces.", ["video"], {
    beats: [
      { label: "Crew in", seconds: 2.5, shot: "low angle 24mm, crew walks toward camera in sync", transition: "hard_cut", text: "hook" },
      { label: "Singles", seconds: 3, shot: "one quick cut per person, their piece", transition: "whip_pan" },
      { label: "Crew hold", seconds: 2.5, shot: "crew stops, looks at camera", transition: "flash_frame", text: "product + price" },
      { label: "End card", seconds: 1.6, shot: "CARBON end card", transition: "fade" },
    ],
    pacing: "fast", music: { mood: "tech house", bpm: [124, 128] }, length: [9, 12], crew: true, patterns: ["street_casting", "lookbook_editorial"],
  }),
  r("before_after_vibe", "Before/after vibe", "Plain fit vs the CARBON fit, same pose, same place.", ["video", "static"], {
    beats: [
      { label: "Before", seconds: 2, shot: "plain generic fit, flat light, bored", transition: "mask_wipe", text: "before" },
      { label: "After", seconds: 3, shot: "same pose and place, CARBON fit, the preset light", transition: "flash_frame", text: "after" },
      { label: "Hero", seconds: 2, shot: "detail + full look", transition: "hard_cut", text: "product + price" },
      { label: "End card", seconds: 1.6, shot: "CARBON end card", transition: "fade" },
    ],
    pacing: "fast", music: { mood: "tech house", bpm: [122, 126] }, length: [7, 10], patterns: ["before_after"],
  }),
  r("texture_asmr", "Texture ASMR", "Luxury pacing: close fabric, real fabric sound, slow light.", ["video"], {
    beats: [
      { label: "Touch", seconds: 2.5, shot: "macro, hand runs over the fabric, soft directional light", transition: "dissolve", text: "hook" },
      { label: "Fold", seconds: 2.5, shot: "macro, fabric folds and drapes", transition: "dissolve" },
      { label: "Worn", seconds: 3, shot: "slow push-in on the model wearing it", transition: "dissolve", text: "product + price" },
      { label: "End card", seconds: 1.6, shot: "CARBON end card", transition: "fade" },
    ],
    pacing: "slow", music: { mood: "ambient / no music, fabric sound", bpm: [70, 90] }, length: [9, 14], patterns: ["slow_mo_fabric", "material_detail_as_proof"],
  }),
  r("florida_route", "Florida route", "Parking lot → skate park → gas station, sun to the first rain.", ["video"], {
    beats: [
      { label: "Parking lot", seconds: 2, shot: "hard sun, parking lot, low angle", transition: "whip_pan", text: "hook" },
      { label: "Skate park", seconds: 2, shot: "skate park edge, handheld follow", transition: "whip_pan" },
      { label: "Gas station", seconds: 2, shot: "gas station canopy at dusk, sodium light", transition: "flash_frame" },
      { label: "First rain", seconds: 2.5, shot: "first rain, wet asphalt, model looks up", transition: "hard_cut", text: "product + price" },
      { label: "End card", seconds: 1.6, shot: "CARBON end card", transition: "fade" },
    ],
    pacing: "fast", music: { mood: "dark afro house", bpm: [118, 124] }, length: [9, 12], patterns: ["lookbook_editorial", "seasonal_event"],
  }),
] as const;

export async function ensureRecipes(pool: Pool, tenantId: string): Promise<void> {
  for (const x of SEED_RECIPES)
    await pool.query(
      `INSERT INTO creative_recipes (tenant_id, key, name, idea, media_types, structure) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb) ON CONFLICT DO NOTHING`,
      [tenantId, x.key, x.name, x.idea, x.media as unknown as string[], JSON.stringify(x.structure)],
    );
}

export type RecipeRow = { id: string; key: string; name: string; idea: string; media_types: string[]; structure: RecipeStructure; status: string; score: number | null };

export async function listRecipes(pool: Pool, tenantId: string, opts: { status?: string } = {}): Promise<RecipeRow[]> {
  await ensureRecipes(pool, tenantId);
  const r = await pool.query<RecipeRow>(
    `SELECT id::text, key, name, idea, media_types, structure, status, score FROM creative_recipes WHERE tenant_id = $1::uuid AND ($2::text IS NULL OR status = $2) ORDER BY score DESC NULLS LAST, created_at`,
    [tenantId, opts.status ?? null],
  );
  return r.rows;
}
