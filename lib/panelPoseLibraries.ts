/* eslint-disable @typescript-eslint/no-explicit-any */
export const MALE_PANEL_MAPPING_TEXT = `MALE PANEL MAPPING (IMMUTABLE)
- Panel 1: Pose 1 + Pose 2
- Panel 2: Pose 3 + Pose 4
- Panel 3: Pose 5 + Pose 6
- Panel 4: Pose 7 + Pose 8`;

export const FEMALE_PANEL_MAPPING_TEXT = `FEMALE PANEL MAPPING (IMMUTABLE)
- Panel 1: Pose 1 + Pose 2
- Panel 2: Pose 3 + Pose 4
- Panel 3: Pose 7 + Pose 5     (Lower Body + Close-Up) preserves female Pose 5 close-up
- Panel 4: Pose 6 + Pose 8     (Relaxed Full Body + Creative)`;

export const MALE_POSE_LIBRARY = String.raw`GLOBAL RULES (apply to all poses)
- Pure white background, even studio lighting, sharp focus, natural proportions (no distortion).
- Same model + styling; Pose 1/2/4 must match full-body scale.
- Hands visible; no hands in pockets; no props (except Pose 8).
- Do not cover logos/graphics, waistband/closure, pockets, hems, side seams.
- Fabric relaxed (no pulling); quick reset between shots (smooth hem, align hood/drawstrings, straighten placket/zip).
- Expression: neutral/premium/confident (no exaggerated smile).
- Variation rule: for each pose, choose ONE variation option below. Do not repeat the same option on back-to-back products.

POSE 1 - Full Body Front (Neutral Hero) [Main]
Base
- Full body; straight-on; head and feet fully visible.
- Arms relaxed at sides, held slightly away from torso (1-2 inches).
- Hands fully visible; fingers relaxed.
- Feet parallel; hip-width; even weight.
- Chin slightly down (2-5 deg); shoulders level.
- Expression: neutral/premium/confident.
Variation Options (pick ONE)
- 1A: Arms 1 inch away (tighter silhouette)
- 1B: Arms 2 inches away (more shape clarity)
- 1C: Slight toe-out (5-10 deg) both feet (still clean)

POSE 2 - Full Body Lifestyle (Controlled)
Base
- Full body; same scale as Pose 1.
- Subtle weight shift only (no bent knee).
- Controlled stance; no props; hands visible.
- Head: small angle (5-10 deg) OR calm off-camera gaze (choose one direction per shoot).
Variation Options (pick ONE)
- 2A: Slight toe-out (5-10 deg) on one foot
- 2B: Small heel lift (front foot mostly planted)
- 2C: Calm off-camera gaze (same direction every time)

POSE 3 - Torso + Head (Front)
Base
- Crop: mid-thigh to head.
- Upright posture; shoulders neutral and level.
- Arms slightly back or relaxed slightly away from torso to open chest/drape.
- Head forward or slightly angled (5-10 deg).
- Neckline/branding unobstructed; hood/collar/drawstrings aligned.
Variation Options (pick ONE)
- 3A: Head neutral, eyes to camera
- 3B: Head 5-10 deg angle (same side consistently)
- 3C: Calm off-camera gaze (minimal, premium)

POSE 4 - Full Body Back View
Base
- Full body; straight-on back; same scale as Pose 1.
- Arms relaxed slightly away from body to show back fit.
- Neck neutral; hood/neckline set clean.
- No twisting; shoulders level; hands visible.
Variation Options (pick ONE)
- 4A: Arms slightly wider away (more back width clarity)
- 4B: Arms slightly closer (cleaner silhouette)
- 4C: Head perfectly neutral vs tiny look-down (2-5 deg)

POSE 5 - Lower Body / Legs
Base
- Crop: waist to feet.
- Neutral stance; even weight.
- Emphasize fit: drape, taper/stacking, construction, hem finish.
- Keep waistband/closure visible if possible.
Variation Options (pick ONE)
- 5A: Feet parallel (most classic)
- 5B: Slight toe-out (5-10 deg) on one foot to show outer seam
- 5C: Stance width: hip-width vs slightly wider (subtle)

POSE 6 - Single Close-Up (One frame only)
Base
- Output exactly ONE close-up image.
- Governed by CLOSE-UP ITEM TYPE LOCK (HARD LOCK).
- Choose highest-conversion detail by priority: branding, hardware, construction, fabric texture.
- Fabric relaxed; even lighting; ultra-sharp texture.
- Include a little surrounding context fabric (do not crop so tight it "floats").
Variation Options (pick ONE)
- 6A: Branding hero detail
- 6B: Hardware hero detail
- 6C: Construction/texture hero detail

POSE 7 - Torso Back (Back Details Crop) - Over-the-Shoulder Variant
Base
- Crop: mid-thigh to head; back-facing.
- Body square to camera (hips + shoulders aligned); no torso twist.
- Head turns 20-30 deg over ONE shoulder (choose one default side; switch occasionally).
- Small chin dip (2-5 deg).
- Arms relaxed slightly away from torso; hands visible.
- Creative detail (choose ONE and standardize):
  A1 "Collar Pop Assist": fingertips lightly pinch collar/hood seam near shoulder (off to the side), OR
  A2 "Shoulder Tap": two fingers lightly touch shoulder seam.
- Do not cover back branding/graphics/yoke/hood details.
Variation Options (pick ONE)
- 7A: Head turn ~20 deg (subtle)
- 7B: Head turn ~30 deg (stronger)
- 7C: Switch look-over shoulder (occasionally, not every product)

POSE 8 - Natural Variation (Controlled Creative) [1 Image Only] - EXPANDED
Core Rules (must follow)
- Output exactly ONE creative image per product.
- Pure white background, same studio lighting + lens look as the rest of the set; no distortion.
- Hands visible, no pockets, no dramatic gestures, no heavy pulling/gripping that distorts fabric.
- Do not cover key garment areas: logos/graphics, waistband + closure, pockets, hems, side seams, back print (if present).
- Keep it studio-clean streetwear: calm attitude, premium expression, natural proportions.

Selection Rule (consistent by product type)
- TOPS (tees, hoodies, crewnecks)
  Default: B (Seated Stool - 3/4 Angle)
  Use D (Lean Look) only if the garment has minimal chest/back graphics or if seated hides details.
- BOTTOMS (pants/denim/cargos/shorts)
  Default: E (Seated "Edge") for thigh/knee shape + stacking + hem behavior
  Use A (Seated Stool - Front) when waistband/closure/pockets are the main selling features.
- OUTERWEAR (jackets/overshirts/puffers)
  Default: C (Walking Across Frame) for drape/movement and premium "real life" energy
  Use B if walking risks hiding important details (zips/pockets/branding) or causes too much occlusion.

Creative Options (choose ONE based on rules above)
A) Seated Stool - Front (Upright)
- Sit upright on a simple backless stool (neutral, studio-safe).
- Feet flat, about hip-width; knees ~90 deg.
- Torso straight; shoulders relaxed and level.
- Hands resting flat on thighs (above knee), not covering waistband/closure/pockets.
- Head: neutral or slight chin dip (2-5 deg); gaze to camera.
- Use when you need maximum waistband + closure clarity without standing.

B) Seated Stool - 3/4 Angle (25-35 deg) [Default for Tops]
- Sit on stool with body rotated 25-35 deg (not side profile).
- Keep spine upright; shoulders relaxed; clean silhouette.
- Feet flat; one foot can be 1-2 inches forward naturally (no dramatic pose).
- One forearm rests lightly on thigh; the other arm relaxed at side or lightly on other thigh.
- No occlusions: keep chest graphic, neckline, and waist area visible.
- Head: slight angle (5-10 deg) or calm off-camera gaze (pick one direction and stay consistent).

C) Walking Across Frame (Controlled Mid-Step) [Default for Outerwear]
- Model walks laterally across frame with a small, controlled stride (not runway).
- Capture at mid-step: front foot just landing or just lifting.
- Arms swing naturally but kept close enough to avoid covering pockets/graphics/zip area.
- Torso upright, shoulders level; no leaning or twisting.
- Outerwear must remain readable: avoid flaring open too wide; keep front details visible.

D) Lean "Against Wall" Look (Studio-Safe; No Wall)
- No actual wall-create subtle lean posture by shifting weight slightly back.
- Feet: choose ONE standard for your brand:
  D1: ankles crossed (clean streetwear attitude), OR
  D2: feet parallel (more minimal/clean).
- Arms relaxed at sides; hands visible; no pockets.
- Keep garment readable: do not let arms block side seams/graphics/closures.
- Head: calm gaze (camera or slightly off-camera), premium expression.

E) Seated "Edge" (Cube/Bench) [Default for Bottoms]
- Sit on a low cube/bench "edge," upright spine (no slouch).
- Feet flat; knees ~90 deg; stance natural.
- Hands rest on thighs near the knees (so waistband/closure stays visible).
- Keep thigh + knee area visible to show fit, taper, and drape.
- For pants: ensure stacking/hem behavior is readable; reset bunching so it looks intentional.
- Head can be in frame or slightly cropped depending on your system, but keep it consistent.
`;

export const FEMALE_POSE_LIBRARY = String.raw`============================================================
FEMALE POSE SET (UPDATED + CONTROLLED VARIATION) - 1 to 8
============================================================

GLOBAL RULES (apply to all poses)
- Pure white background, even studio lighting, sharp focus, natural proportions (no distortion).
- Same model + styling; Pose 1/2/3/6 must match full-body scale.
- Hands visible (unless cropped out); no pockets.
- Do not cover logos/graphics, neckline, waistband + closure, pockets, hems, side seams, back print (if present).
- Fabric relaxed (no pulling); quick reset between shots (smooth hem, align straps/drawstrings, flatten collar).
- Expression: premium + calm (neutral or soft controlled smile).
- Variation rule: for each pose, choose ONE "Variation Option" listed. Do not repeat the same option on back-to-back products.

POSE 1 - Front Hero (Main Shopify Hero)
Base
- Full body; straight-on; head + feet fully visible.
- Neutral stance with a small hip shift (subtle, not exaggerated).
- Arms relaxed at sides or one soft bend; held 1-2 inches away from torso.
- Legs straight; feet parallel or slight toe-out (5-10 deg).
- Chin slightly down (2-5 deg); shoulders level.
- Expression: professional/premium/confident.
Variation Options (pick ONE)
- 1A: Hip shift slightly left
- 1B: Hip shift slightly right
- 1C: Feet parallel + arms 2 inches away (more structured)

POSE 2 - Back View (Face Visible)
Base
- Full body; back-facing; same scale as Pose 1.
- Body square to camera (no torso twist).
- Head turned 30-45 deg over one shoulder so face is visible (choose one default side).
- Arms relaxed slightly away from torso; hands visible.
- Back design/branding unobstructed; avoid shoulder tension wrinkles.
Variation Options (pick ONE)
- 2A: Head turn ~30 deg (subtle)
- 2B: Head turn ~45 deg (stronger attitude)
- 2C: Switch "look-over" shoulder (use occasionally, not every product)

POSE 3 - 3/4 Front Angle (Full Body)
Base
- Full body; rotated 25-35 deg (not side profile); same scale as Pose 1.
- Subtle weight shift only; no dramatic pose.
- Legs straight; arms relaxed slightly away from body to show drape and waist shape.
- Keep key garment areas unobstructed.
Variation Options (pick ONE)
- 3A: Rotate ~25 deg (more front)
- 3B: Rotate ~30 deg (balanced default)
- 3C: Rotate ~35 deg (more silhouette)

POSE 4 - Upper Body (With Face)
Base
- Crop: mid-thigh to head (preferred) OR waist-up (choose one standard per category).
- Upright posture; shoulders neutral.
- Arms relaxed/lightly posed; hands visible if in frame.
- Neckline/upper fit details clearly visible; hair must not cover neckline/logos.
- Fabric reset: collar/neckline flat, straps even, branding unobstructed.
Variation Options (pick ONE)
- 4A: Head neutral, gaze to camera
- 4B: Small head tilt (3-5 deg)
- 4C: Calm off-camera gaze (5-10 deg), same direction each time

POSE 5 - Single Close-Up (One frame only)
Base
- Output exactly ONE close-up image.
- Governed by CLOSE-UP ITEM TYPE LOCK (HARD LOCK).
- Choose highest-conversion detail by priority:
  Branding (patch/embroidery/print) -> Hardware (zip/button/snap) -> Construction (seam/panel/hem/stitching) -> Fabric texture (if minimal branding)
- Ultra-sharp texture; even lighting; fabric relaxed and not stretched.
- Include a little surrounding context fabric (do not crop so tight it "floats").
Variation Options (pick ONE)
- 5A: Branding hero (logo/patch)
- 5B: Hardware hero (zip/button)
- 5C: Construction/texture hero (seam/knit/weave)

POSE 6 - Relaxed Front Variation (Full Body + Face Visible)
Base
- Full body; front-facing; same scale as Pose 1.
- Softer stance than Pose 1 (casual but premium).
- Arms relaxed OR one hand resting lightly on upper thigh/hip area (must not cover waistband/pockets/logo).
- Legs straight; no bent knee.
- Face must ALWAYS be visible; expression calm and confident.
Variation Options (pick ONE)
- 6A: Both arms relaxed (cleanest)
- 6B: One hand lightly on upper thigh (no occlusion)
- 6C: Slight off-camera gaze (same direction each time)

POSE 7 - Lower Body / Legs (Bottoms Focus)
Base
- Crop: waist to feet.
- Stance: neutral, even weight; legs straight (no bent knee).
- Visibility: waistband + closure, front rise, and pocket openings clearly visible.
- Fit priorities: drape, taper, hem behavior, construction details (seams/panels).
- Hands/arms: out of frame preferred. If hands appear, do not block waistband/closure/pockets.
- Reset rule: smooth fabric so hem finish/stacking looks intentional (not messy bunching).
Variation Options (pick ONE)
- 7A: Slight toe-out (5-10 deg) left foot
- 7B: Slight toe-out (5-10 deg) right foot
- 7C: Stance width: hip-width vs slightly wider (keep subtle)

FEMALE - POSE 8: Natural Variation (Controlled Creative) [1 Image Only] - EXPANDED
Core Rules (must follow)
- Output exactly ONE creative image per product.
- Pure white background, same studio lighting + lens look as the rest; no distortion.
- Hands visible, no pockets, no dramatic gestures, no heavy pulling/gripping that distorts fabric.
- Do not cover key garment areas: logos/graphics, neckline, waistband + closure, pockets, hems, side seams, back print (if present).
- Keep it studio-clean streetwear: premium calm expression, natural proportions, controlled attitude.

Selection Rule (consistent by product type)
- TOPS (tees, tanks, hoodies, crewnecks)
  Default: B (Seated Stool - 3/4 Angle)
  Use D (Lean Look) if minimal chest/back graphics or seated hides details.
- BOTTOMS (jeans, skirts, pants, shorts)
  Default: E (Seated "Edge") to show thigh/knee shape + drape + hem behavior
  Use A (Seated Stool - Front) when waistband/closure/pockets are the key features.
- DRESSES / SETS / ONE-PIECES
  Default: B (Seated Stool - 3/4 Angle) for silhouette + neckline
  Use C (Controlled Walk-In) when you want flow/drape and it will not hide details.
- OUTERWEAR (jackets, overshirts, puffers)
  Default: C (Controlled Walk-In) for drape + movement
  Use B if movement risks occluding branding/zips/pockets.

Creative Options (choose ONE based on rules above)
A) Seated Stool - Front (Upright)
- Sit upright on a simple backless stool.
- Feet flat; hip-width; knees ~90 deg (knees together or slightly apart-natural).
- Torso tall; shoulders relaxed and level.
- Hands resting flat on thighs (above knee), not covering waistband/branding/closure.
- Head: neutral or slight chin dip (2-5 deg); gaze to camera.
- Clean silhouette; no slouching.
- Best for: bottoms where waistband/closure/pockets are the main selling points.

B) Seated Stool - 3/4 Angle (25-35 deg) [Default for Tops + Dresses]
- Sit on stool; rotate body 25-35 deg (not side profile).
- Upright spine; shoulders relaxed; clean silhouette.
- Feet flat; one foot may sit 1-2 inches forward naturally.
- One forearm lightly rests on thigh; the other arm relaxed at side or on thigh.
- Keep neckline, chest graphic, waist area visible-no occlusions.
- Head: slight angle (3-5 deg) or calm off-camera gaze (choose one direction and stay consistent).
- Best for: tops, dresses, sets-adds depth and shape without losing product clarity.

C) Controlled Walk-In (Mid-Step) [Default for Outerwear + Flow Pieces]
- Take a small, controlled step (not runway, no dramatic stride).
- Capture at mid-step: front foot landing or lifting; posture upright.
- Arms natural swing but kept close enough to avoid covering pockets/graphics/zip area.
- No twisting; shoulders level; premium calm expression.
- For skirts/dresses: ensure movement shows drape without hiding hem/waist details.
- Best for: outerwear, dresses/skirts with flow, long tops where drape matters.

D) Lean "Against Wall" Look (Studio-Safe; No Wall)
- No actual wall-create a subtle lean posture by shifting weight slightly back.
- Feet: choose ONE brand standard:
  D1: ankles crossed (more streetwear energy), OR
  D2: feet parallel (clean minimal).
- Arms relaxed; hands visible; no pockets.
- Keep waist, neckline, and branding visible; avoid arm blocking side seams.
- Head: calm gaze (camera or slightly off-camera), consistent direction.
- Best for: minimal-graphic tops, clean sets, mood-driven pieces.

E) Seated "Edge" (Low Cube/Bench) [Default for Bottoms]
- Sit on a low cube/bench edge; upright spine (no slouch).
- Feet flat; knees ~90 deg; stance natural.
- Hands on thighs near the knees so waistband/closure stays visible.
- Show thigh/knee shape + drape: great for denim, pants, skirts.
- Reset fabric so hem behavior looks intentional (not messy bunching).
- Keep pockets/closure/branding visible.
- Best for: bottoms-shows fit through thigh/knee + hem better than standing.
`;

export function getPoseLibraryForGender(gender: string) {
  return String(gender || "").toLowerCase() === "female"
    ? FEMALE_POSE_LIBRARY
    : MALE_POSE_LIBRARY;
}

/*
 * Choice-free pose text.
 *
 * The libraries were written for a human photographer: "Variation Options (pick
 * ONE)", "Creative detail (choose ONE)", "Creative Options A–E", "mid-thigh to
 * head OR waist-up". Pasted into an image prompt, every one of those is a coin
 * the model flips on its own — and the server's POSE VARIATION line
 * (lib/poseVariation.ts) has already made the pick, so a second pick could
 * only contradict it. The resolver below hands over the library text with
 * every choice made in code: the micro-variation is left to POSE VARIATION
 * alone, Pose 8 is the one creative option the Selection Rule names for this
 * kind of product, and the remaining A1/A2-style details come from the run seed.
 */

export type Pose8Option = "A" | "B" | "C" | "D" | "E";

/** The creative option the Pose 8 Selection Rule makes the default for this
 *  category (lib/panelGeneration.ts itemTypeCategory). Both libraries use the
 *  same letters; dresses / sets / one-pieces share the tops default. */
export function pose8OptionFor(_gender: string, category: string): Pose8Option {
  const c = String(category || "");
  if (c === "bottom" || c === "footwear") return "E";
  if (c === "outerwear") return "C";
  return "B";
}

function seededPick<T>(seed: number, salt: number, options: T[]): T {
  const n = Math.abs(Math.floor(Number.isFinite(seed) ? seed : 0) + salt);
  return options[n % options.length];
}

/* Library lines that carry a choice, rewritten (or dropped, null) once. Head
   angle, gaze, foot angle and arm position are POSE VARIATION's to set, so the
   lines that offered them are reduced to what stays fixed. */
const RESOLVED_LINES: Record<string, string | null> = {
  "- Variation rule: for each pose, choose ONE variation option below. Do not repeat the same option on back-to-back products.": null,
  '- Variation rule: for each pose, choose ONE "Variation Option" listed. Do not repeat the same option on back-to-back products.': null,
  "- Expression: premium + calm (neutral or soft controlled smile).": "- Expression: premium and calm.",
  "- Head: small angle (5-10 deg) OR calm off-camera gaze (choose one direction per shoot).": null,
  "- Arms slightly back or relaxed slightly away from torso to open chest/drape.": "- Arms relaxed, opening the chest and drape.",
  "- Head forward or slightly angled (5-10 deg).": null,
  "- Head turns 20-30 deg over ONE shoulder (choose one default side; switch occasionally).": "- Head turned over one shoulder.",
  "- Arms relaxed at sides or one soft bend; held 1-2 inches away from torso.": "- Arms relaxed, held 1-2 inches away from the torso.",
  "- Legs straight; feet parallel or slight toe-out (5-10 deg).": "- Legs straight.",
  "- Head turned 30-45 deg over one shoulder so face is visible (choose one default side).": "- Head turned over one shoulder so the face is visible.",
  "- Crop: mid-thigh to head (preferred) OR waist-up (choose one standard per category).": "- Crop: mid-thigh to head.",
  "- Arms relaxed OR one hand resting lightly on upper thigh/hip area (must not cover waistband/pockets/logo).":
    "- Hands never cover the waistband, the pockets, the logo.",
  "- Hands/arms: out of frame preferred. If hands appear, do not block waistband/closure/pockets.": "- Hands and arms out of frame.",
  "- Head: neutral or slight chin dip (2-5 deg); gaze to camera.": null,
  "- Use when you need maximum waistband + closure clarity without standing.": null,
  "- One forearm rests lightly on thigh; the other arm relaxed at side or lightly on other thigh.":
    "- One forearm rests lightly on the thigh; the other arm relaxed at the side.",
  "- One forearm lightly rests on thigh; the other arm relaxed at side or on thigh.":
    "- One forearm rests lightly on the thigh; the other arm relaxed at the side.",
  "- Head: slight angle (5-10 deg) or calm off-camera gaze (pick one direction and stay consistent).": null,
  "- Head: slight angle (3-5 deg) or calm off-camera gaze (choose one direction and stay consistent).": null,
  "- Capture at mid-step: front foot just landing or just lifting.": "- Captured at mid-step.",
  "- Capture at mid-step: front foot landing or lifting; posture upright.": "- Captured at mid-step; posture upright.",
  "- Head: calm gaze (camera or slightly off-camera), premium expression.": "- Premium expression.",
  "- Head: calm gaze (camera or slightly off-camera), consistent direction.": null,
  "- Head can be in frame or slightly cropped depending on your system, but keep it consistent.": "- Head in frame.",
  "- Feet flat; hip-width; knees ~90 deg (knees together or slightly apart-natural).": "- Feet flat; hip-width; knees ~90 deg, slightly apart.",
};

/** The global rules with their "choose ONE variation" line gone (the pick is POSE VARIATION's). */
export function resolveGlobalPoseRules(rules: string): string {
  return resolveLines(String(rules || "").split("\n"), 0).join("\n");
}

function resolveLines(lines: string[], seed: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const t = raw.trim();
    if (/^Variation Options \(pick ONE\)/i.test(t)) {
      // The option list under it: "- 3A: …", "- 7C: …".
      while (i + 1 < lines.length && /^\s*-\s*\d+[A-Z]:/.test(lines[i + 1])) i += 1;
      continue;
    }
    if (/^- Creative detail \(choose ONE/i.test(t)) {
      const opts: string[] = [];
      while (i + 1 < lines.length && /^\s+A\d\b/.test(lines[i + 1])) opts.push(lines[(i += 1)]);
      if (opts.length) {
        const chosen = seededPick(seed, 3, opts)
          .trim()
          .replace(/^A\d\s+"[^"]*":\s*/, "")
          .replace(/,?\s*OR\s*$/, "")
          .replace(/\.?$/, ".");
        out.push(`- Hand detail: ${chosen}`);
      }
      continue;
    }
    if (/^- Feet: choose ONE/i.test(t)) {
      const opts: string[] = [];
      while (i + 1 < lines.length && /^\s+D\d:/.test(lines[i + 1])) opts.push(lines[(i += 1)]);
      if (opts.length) {
        const chosen = seededPick(seed, 5, opts)
          .trim()
          .replace(/^D\d:\s*/, "")
          .replace(/,?\s*OR\s*$/, "")
          .replace(/\.?$/, ".");
        out.push(`- Feet: ${chosen}`);
      }
      continue;
    }
    if (/^- Best for:/i.test(t)) continue;
    if (Object.prototype.hasOwnProperty.call(RESOLVED_LINES, t)) {
      const r = RESOLVED_LINES[t];
      if (r !== null) out.push(raw.replace(t, r));
      continue;
    }
    out.push(raw);
  }
  return out;
}

/**
 * Pose 8 is a menu of five creative poses plus a rule for choosing. Keep the
 * core rules and the ONE option the rule picks for this category; the menu and
 * the rule itself go.
 */
function resolvePose8Block(block: string, option: Pose8Option, seed: number): string {
  const lines = block.split("\n");
  const header = lines[0];
  const core: string[] = [];
  let i = 1;
  for (; i < lines.length && !/^\s*Selection Rule\b/i.test(lines[i]) && !/^\s*[A-E]\)\s/.test(lines[i]); i += 1) {
    if (lines[i].trim()) core.push(lines[i]);
  }
  const start = lines.findIndex((l) => new RegExp(`^\\s*${option}\\)\\s`).test(l));
  if (start < 0) return block;
  let end = start + 1;
  while (end < lines.length && !/^\s*[A-E]\)\s/.test(lines[end])) end += 1;
  const title = lines[start].trim().replace(/\s*\[[^\]]*\]\s*$/, "");
  const body = resolveLines(lines.slice(start + 1, end), seed).filter((l) => l.trim());
  return [header, ...core, `Creative pose for this product: ${title}`, ...body].join("\n");
}

/**
 * One injected pose block, with every choice made. `category` is
 * lib/panelGeneration.ts itemTypeCategory(itemType); `seed` is the run's
 * variation seed (the same number the server's POSE VARIATION uses).
 */
export function resolvePoseBlock(
  block: string,
  opts: { gender: string; pose: number; category: string; seed: number },
): string {
  const text = String(block || "");
  if (opts.pose === 8 && /Creative Options/i.test(text)) {
    return resolvePose8Block(text, pose8OptionFor(opts.gender, opts.category), opts.seed);
  }
  return resolveLines(text.split("\n"), opts.seed).join("\n");
}
