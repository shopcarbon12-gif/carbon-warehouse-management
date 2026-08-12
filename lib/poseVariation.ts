/* eslint-disable @typescript-eslint/no-explicit-any */
// Pose / face variation engine.
//
// Problem this solves: the master panel prompt is otherwise byte-for-byte
// identical on every generation, so the image model collapses to the same
// "default" interpretation of each pose AND the identity lock freezes the same
// face/expression -> the set looks robotic ("AI stamped the same person in the
// same pose every time").
//
// Strategy (approved by user — "Strategy A"): keep ONE locked model identity,
// but inject a *rotating* micro-variation directive each generation:
//   - a different body micro-option per active pose (stance / arm distance /
//     foot angle / head turn — all drawn from the pose library's own safe
//     "Variation Options"), and
//   - a face micro-variation (gaze / head tilt / micro-expression / weight
//     shift) that stays strictly WITHIN the identity lock (same exact face
//     geometry, skin tone, hairline, age — only expression/gaze move).
//
// Selection is deterministic from a per-generation `seed` so consecutive
// generations rotate to a DIFFERENT option (never back-to-back identical) with
// no shared server state and no round-trip. `strength` controls how much
// variation is applied.

export type VariationStrength = "subtle" | "natural" | "editorial";

export const DEFAULT_VARIATION_STRENGTH: VariationStrength = "natural";

export function normalizeStrength(value: unknown): VariationStrength {
  const v = String(value || "").trim().toLowerCase();
  if (v === "subtle" || v === "editorial") return v;
  return "natural";
}

/** Poses that have no human face in frame (close-up / detail). */
function isCloseUpPose(gender: string, pose: number | null): boolean {
  const g = String(gender || "").toLowerCase();
  if (pose == null) return false;
  return g === "female" ? pose === 5 : pose === 6;
}

/** Poses that crop out the head (lower body / legs). */
function isLowerBodyPose(gender: string, pose: number | null): boolean {
  const g = String(gender || "").toLowerCase();
  if (pose == null) return false;
  return g === "female" ? pose === 7 : pose === 5;
}

// Per-pose body micro-variation pools. These are intentionally drawn from the
// existing "Variation Options" in lib/panelPoseLibraries.ts so they never
// conflict with the hard locks (no occlusion, no hands in pockets, full-body
// poses stay full-body). Each entry is ONE concrete directive.
const MALE_BODY: Record<number, string[]> = {
  1: [
    "arms relaxed ~1 inch from torso (tighter silhouette)",
    "arms relaxed ~2 inches from torso (more shape clarity)",
    "feet with a slight natural toe-out (5-10°), weight still even",
    "micro weight shift to one leg, hips natural, shoulders level",
  ],
  2: [
    "slight toe-out (5-10°) on one foot, controlled stance",
    "small heel lift on the front foot (mostly planted)",
    "subtle weight shift with a calm off-camera gaze",
    "head at a small 5-10° angle, body squared",
  ],
  3: [
    "head neutral, eyes to camera, chest open",
    "head at a soft 5-10° angle (same side), shoulders level",
    "arms eased slightly back to open the drape",
  ],
  4: [
    "arms slightly wider from body (more back-width clarity)",
    "arms slightly closer for a cleaner silhouette",
    "head perfectly neutral vs a tiny 2-5° look-down",
  ],
  5: [
    "feet parallel (classic), even weight",
    "slight toe-out (5-10°) on one foot to reveal the outer seam",
    "stance a touch wider than hip-width (subtle)",
  ],
  6: [
    "hero the detail slightly more head-on",
    "hero the detail from a soft 10-15° angle",
    "crop a touch looser to keep surrounding context fabric",
  ],
  7: [
    "head turned ~20° over the shoulder (subtle)",
    "head turned ~30° over the shoulder (stronger attitude)",
    "look over the opposite shoulder for this shot",
    "soft chin dip (2-5°) with a relaxed over-shoulder glance",
  ],
  8: [
    "seated 3/4 angle, one forearm easing onto the thigh, calm off-camera gaze",
    "controlled mid-step walk, weight just landing on the front foot",
    "relaxed lean (weight shifted slightly back), ankles natural",
    "seated upright, hands resting on thighs, composed gaze to camera",
  ],
};

const FEMALE_BODY: Record<number, string[]> = {
  1: [
    "subtle hip shift to the left, arms ~1-2 inches from torso",
    "subtle hip shift to the right, arms ~1-2 inches from torso",
    "feet parallel with arms ~2 inches away (more structured)",
    "soft toe-out (5-10°), one arm with a gentle bend",
  ],
  2: [
    "head turned ~30° over the shoulder (subtle), face visible",
    "head turned ~45° over the shoulder (stronger attitude)",
    "look over the opposite shoulder for this shot",
  ],
  3: [
    "rotate ~25° toward front",
    "rotate ~30° (balanced)",
    "rotate ~35° for more silhouette",
  ],
  4: [
    "head neutral, gaze to camera",
    "small head tilt (3-5°)",
    "calm off-camera gaze (5-10°)",
  ],
  5: [
    "hero the detail slightly more head-on",
    "hero the detail from a soft 10-15° angle",
    "crop a touch looser to keep surrounding context fabric",
  ],
  6: [
    "both arms relaxed (cleanest)",
    "one hand resting lightly on the upper thigh (no occlusion)",
    "slight off-camera gaze with a soft, confident expression",
  ],
  7: [
    "slight toe-out (5-10°) on the left foot",
    "slight toe-out (5-10°) on the right foot",
    "stance a touch wider than hip-width (subtle)",
  ],
  8: [
    "seated 3/4 angle, one forearm easing onto the thigh, calm gaze",
    "controlled walk-in mid-step, fabric showing natural drape",
    "relaxed lean (weight shifted slightly back), ankles natural",
    "seated upright, hands on thighs, composed gaze to camera",
  ],
};

// Face micro-variation pools — applied WITHIN the identity lock. None of these
// change face geometry / skin tone / hairline / age; they only move the
// gaze, head angle, micro-expression, and weight a touch so the same person
// does not look stamped.
const GAZE = [
  "direct, calm gaze to camera",
  "calm gaze just off-camera to the left",
  "calm gaze just off-camera to the right",
  "soft gaze slightly past the lens",
  "gentle downward gaze (2-4°)",
];

const HEAD_TILT = [
  "head level",
  "head tilted ~2° to the left",
  "head tilted ~2° to the right",
  "a tiny chin lift (1-2°)",
  "a tiny chin dip (2-3°)",
];

const EXPRESSION = [
  "neutral premium expression",
  "relaxed jaw with a faint, assured confidence",
  "calm expression with soft eyes",
  "composed, lips relaxed, quietly confident",
  "subtle editorial poise (not posed-stiff)",
];

const WEIGHT = [
  "weight even on both feet",
  "weight ~55% on one leg (subtle)",
  "a micro weight shift, hips natural",
];

/** Deterministic index that, for consecutive seeds, never repeats back-to-back. */
function rotate(seed: number, offset: number, len: number): number {
  if (len <= 0) return 0;
  const n = Math.floor(seed) + offset;
  const m = ((n % len) + len) % len;
  return m;
}

function bodyPool(gender: string, pose: number | null): string[] {
  if (pose == null) return [];
  const table = String(gender || "").toLowerCase() === "female" ? FEMALE_BODY : MALE_BODY;
  return table[pose] || [];
}

function describePoseVariation(
  gender: string,
  pose: number | null,
  side: "LEFT" | "RIGHT",
  strength: VariationStrength,
  seed: number
): string | null {
  if (pose == null) return null;
  const offset = side === "LEFT" ? 0 : 7; // de-sync the two halves of a panel
  const closeUp = isCloseUpPose(gender, pose);
  const lowerBody = isLowerBodyPose(gender, pose);

  const body = bodyPool(gender, pose);
  const bodyPick = body.length ? body[rotate(seed, offset, body.length)] : null;

  // Close-up / lower-body frames have no face: only apply the body/detail micro-option.
  if (closeUp || lowerBody) {
    return bodyPick ? `${side} (Pose ${pose}): ${bodyPick}.` : null;
  }

  const gaze = GAZE[rotate(seed, offset + 1, GAZE.length)];
  const tilt = HEAD_TILT[rotate(seed, offset + 2, HEAD_TILT.length)];
  const expr = EXPRESSION[rotate(seed, offset + 3, EXPRESSION.length)];
  const weight = WEIGHT[rotate(seed, offset + 4, WEIGHT.length)];

  const parts: string[] = [];
  if (bodyPick) parts.push(bodyPick);

  if (strength === "subtle") {
    parts.push(gaze, weight);
  } else if (strength === "editorial") {
    parts.push(gaze, tilt, expr, weight);
  } else {
    // natural (default)
    parts.push(gaze, tilt, expr);
  }

  return `${side} (Pose ${pose}): ${parts.join("; ")}.`;
}

/**
 * Build the variation directive block to append to the locked panel prompt.
 * Returns "" when there is nothing meaningful to vary.
 */
export function buildPoseVariationDirective(args: {
  modelGender: string;
  poseA: number | null;
  poseB: number | null;
  strength?: VariationStrength;
  seed?: number;
}): string {
  const strength = normalizeStrength(args.strength);
  // A finite seed must be supplied for deterministic anti-repeat rotation; if it
  // is missing we fall back to 0 (still better than a frozen prompt because the
  // directive language itself differs from the base prompt).
  const seed = Number.isFinite(args.seed as number) ? Math.floor(args.seed as number) : 0;

  const left = describePoseVariation(args.modelGender, args.poseA, "LEFT", strength, seed);
  const right = describePoseVariation(args.modelGender, args.poseB, "RIGHT", strength, seed);
  if (!left && !right) return "";

  const editorial = strength === "editorial";
  const lines = [
    "POSE & EXPRESSION VARIATION DIRECTIVE (this generation only):",
    "- Keep the EXACT same locked model identity and the EXACT locked garment — this overrides nothing in the identity/item hard locks.",
    "- Within that lock, apply the natural micro-variation below so the shot reads candid and real, NOT a stiff repeated default pose:",
    left,
    right,
    "- Vary ONLY expression, gaze direction, head angle, and subtle stance/weight. Do NOT change face geometry, eye/nose/lip shape, skin tone, undertone, hairline, hairstyle, age, body proportions, framing, crop, or garment.",
    "- This must still look unmistakably like the same person across the set — same face, fresh moment.",
    editorial
      ? "- Editorial energy: capture an in-between, natural moment (not posed-stiff), while staying storefront-clean and non-sexual."
      : "- Keep it premium, calm, and storefront-clean.",
  ].filter(Boolean);

  return lines.join("\n");
}
