/**
 * How each point of measure is taken, what colour it is drawn in, and which
 * side of the garment it lives on.
 *
 * One table for all three, because they have to agree everywhere a point
 * appears: the line on the photo, the dot in the result list, the sketch in the
 * how-to-measure guide and the box on the item card. A point that is purple on
 * the photo and teal in the guide is a guide nobody can follow.
 */

import type { GarmentType, PomKey } from "./garment";

/* Matched to the owner's reference pictures (public/size-grading/guide/), so a
   line on the measuring screen is the same colour as the same line in the
   guide. Where the pictures reuse a hue for two points on one garment (hip and
   thigh are both cyan there), the second is a shade apart so the two lines can
   still be told apart on the photo. */
export const POM_COLOR: Record<PomKey, string> = {
  chest: "#facc15", waist: "#a855f7", hip: "#22d3ee", length: "#3b82f6",
  hem: "#f43f5e", shoulder: "#22c55e", sleeve: "#8b5cf6",
  sleeveInseam: "#fb923c", bicep: "#f59e0b", cuff: "#f472b6", armhole: "#f97316",
  inseam: "#22c55e", outseam: "#3b82f6", legOpening: "#f43f5e", rise: "#f472b6",
  thigh: "#06b6d4", knee: "#a78bfa", calf: "#818cf8",
  neck: "#60a5fa", neckDrop: "#93c5fd", collarHeight: "#bfdbfe",
  shoulderSlope: "#fde047", waistbandHeight: "#f9a8d4",
  frontPocketOpening: "#fda4af", backPocketWidth: "#fca5a5", backPocketLength: "#ef4444",
};
export const colorForPom = (key: string) => POM_COLOR[key as PomKey] ?? "#38bdf8";

/** The default instruction for each point — what a tape on the table does. */
const HOWTO: Record<PomKey, string> = {
  chest: "Straight across the chest, 1 in (2.5 cm) below the armpits, edge to edge.",
  waist: "Straight across the narrowest part of the body, edge to edge.",
  hip: "Straight across the widest part of the hips, edge to edge.",
  length: "From the highest point of the shoulder, beside the collar, straight down to the hem.",
  hem: "Straight across the bottom edge, side to side.",
  shoulder: "From one shoulder seam straight across to the other.",
  sleeve: "From the shoulder seam along the top of the sleeve to the end of the cuff.",
  sleeveInseam: "From the armpit along the underside of the sleeve to the end of the cuff.",
  bicep: "Across the sleeve at the armpit, square to the sleeve.",
  cuff: "Straight across the sleeve opening.",
  armhole: "From the top of the shoulder seam straight down to the armpit.",
  inseam: "From the crotch seam down the inner leg to the hem.",
  outseam: "From the top of the waistband down the outside of the leg to the hem.",
  legOpening: "Straight across the bottom of the leg.",
  rise: "From the crotch seam straight up to the top of the waistband.",
  thigh: "Across one leg, 1 in (2.5 cm) below the crotch.",
  knee: "Across one leg, halfway between the crotch and the hem.",
  calf: "Across one leg at the widest point below the knee.",
  neck: "Straight across the neck opening, seam to seam.",
  neckDrop: "From the line between the two neck seams straight down to the neckline.",
  collarHeight: "Height of the collar or neck band, edge to edge.",
  shoulderSlope: "How far the shoulder point sits below the neck point.",
  waistbandHeight: "From the top to the bottom edge of the waistband.",
  frontPocketOpening: "Along the front pocket opening, from end to end.",
  backPocketWidth: "Across the back pocket at its top edge.",
  backPocketLength: "From the top of the back pocket to its lowest point.",
};

/* Where the same name means a different place on a different garment — the
   waist of a pair of jeans is the waistband, the waist of a dress is the
   narrowest point of the body. */
const HOWTO_FOR: Partial<Record<GarmentType, Partial<Record<PomKey, string>>>> = {
  trousers: {
    waist: "Straight across the top of the waistband, from edge to edge.",
    hip: "Across the widest point, about 6.3 in (16 cm) below the top of the waistband.",
    length: "From the top of the waistband straight down to the hem.",
  },
  shorts: {
    waist: "Straight across the top of the waistband, from edge to edge.",
    hip: "Across the widest point, about 6.3 in (16 cm) below the top of the waistband.",
  },
  skirt: {
    waist: "Straight across the top of the waistband, from edge to edge.",
    hip: "Across the widest point, about 6.3 in (16 cm) below the top of the waistband.",
    length: "From the top of the waistband straight down to the hem.",
  },
  onepiece: {
    rise: "From the crotch seam straight up to the waist seam.",
  },
};

export function pomHowTo(key: string, type: GarmentType): string {
  return HOWTO_FOR[type]?.[key as PomKey] ?? HOWTO[key as PomKey] ?? "";
}

/**
 * Which side of the garment a point can be seen on.
 *
 * A front pocket is not there when the garment is lying back up, and a back
 * pocket is not there front up. Offering them anyway asks the operator to place
 * a line on something that is not in the photo — and before this, the only way
 * out was to place it somewhere and save a number that meant nothing.
 */
export const POM_SIDES: Partial<Record<PomKey, Array<"front" | "back">>> = {
  frontPocketOpening: ["front"],
  backPocketWidth: ["back"],
  backPocketLength: ["back"],
};

export function pomOnSide(key: string, view: "front" | "back"): boolean {
  const sides = POM_SIDES[key as PomKey];
  return !sides || sides.includes(view);
}
