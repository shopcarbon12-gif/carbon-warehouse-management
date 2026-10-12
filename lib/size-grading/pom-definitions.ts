/**
 * Where each point of measure is taken — the one written definition the
 * measuring AI is held to, and the same wording as the owner's guide sketches
 * (T-shirt A–P, long pants A–N, 2026-10-12).
 *
 * A measurement is only "right" against a tape when both used the same rule:
 * "chest" at the armpit and "chest" 2.5 cm below it differ by a centimetre on
 * a tee. So the rule lives here, once, and the prompt quotes it verbatim.
 *
 * Every definition is a straight line between two end points, because that is
 * what the operator drags on screen and what is saved. Seams that curve a
 * little (outseam over the hip) are taken end to end.
 */
import type { GarmentType, PomKey } from "./garment";

export const POM_RULE: Record<PomKey, string> = {
  chest: "Straight across, 2.5 cm (1\") below the armpit, from one side edge to the other.",
  waist:
    "Tops and dresses: straight across at the narrowest point between chest and hem. Trousers, shorts, skirts and one-pieces with a waistband: straight across the TOP edge of the waistband, button closed, edge to edge.",
  hip: "Tops and dresses: straight across at the widest point below the waist. Trousers, shorts and one-pieces: straight across, 8 cm (3\") above the crotch point. Skirts: straight across, 18 cm (7\") below the top of the waistband.",
  length:
    "Tops and dresses: from the high point of the shoulder (where the shoulder seam meets the collar) straight down to the hem, parallel to the centre line. On the BACK view: from the back collar seam at centre back straight down to the hem. Skirts: from the top of the waistband at centre front straight down to the hem.",
  hem: "Straight across the bottom edge of the garment, edge to edge.",
  shoulder: "From one shoulder seam point (where the sleeve joins the body at the top) to the other, straight across.",
  sleeve: "From the shoulder seam point to the end of the sleeve, along the top fold of the sleeve.",
  sleeveInseam: "From the armpit point to the end of the sleeve, along the underside of the sleeve.",
  bicep: "From the armpit point, square across the sleeve (perpendicular to the top fold) to the top fold.",
  cuff: "Across the end of the sleeve, edge to edge.",
  armhole: "Straight line from the shoulder seam point to the armpit point (the armhole seam's two ends).",
  inseam: "From the crotch seam point to the hem, along the inside leg seam of ONE leg.",
  outseam: "From the top of the waistband at the side to the hem, along the outside side seam of ONE leg.",
  legOpening: "Across the hem of ONE leg, edge to edge, square to the leg.",
  rise: "FRONT view: from the top of the waistband at centre front straight down to the crotch seam point. BACK view: from the top of the waistband at centre back straight down to the crotch seam point.",
  thigh: "2.5 cm (1\") below the crotch point, across ONE leg, square to the leg, from the inside leg edge to the outside edge.",
  knee: "Halfway down the inseam of ONE leg, square across the leg, edge to edge.",
  calf: "Halfway between the knee line and the hem of ONE leg, square across the leg, edge to edge.",
  neck: "From one collar seam to the other, at the two high points of the shoulder (inside edge of the collar).",
  neckDrop:
    "FRONT view: from the imaginary line joining the two shoulder high points straight down to the collar seam at centre front. BACK view: the same, to the collar seam at centre back.",
  collarHeight: "The width of the neck rib / collar band, at centre front, from its outer edge to its seam.",
  shoulderSlope: "Vertical drop from the level of the shoulder high point down to the shoulder seam point (one side).",
  waistbandHeight: "From the top edge to the bottom edge (seam) of the waistband, square to the waistband.",
  frontPocketOpening: "Along the front pocket opening, from where it meets the waistband seam to where it meets the side seam.",
  backPocketWidth: "Across the top edge of ONE back pocket, edge to edge.",
  backPocketLength: "From the top edge of ONE back pocket to its bottom point, at the pocket's centre.",
};

/**
 * Landmark rules that cost real centimetres when guessed. The crotch one is
 * from the first test (2026-10-12): two models put the crotch where the GAP
 * between the legs begins — on flat leggings the legs lie touching for 7 cm
 * below the real crotch, so inseam and rise were both 7 cm wrong.
 */
export const LANDMARK_RULES = [
  "CROTCH SEAM POINT: where the centre-front seam ENDS and meets the inside leg seams. On jeans: follow the fly's J-shaped stitching down; the crotch point is just below where the fly stitching ends (usually 2–5 cm below the bottom of the zip). Below that point a single seam line often seems to continue straight down for 5–10 cm until the legs separate — that line is the two INSEAMS lying pressed together, not the centre seam. Never use the point where the legs separate (both test garments, 2026-10-12: leggings 7 cm low, jeans 8 cm low). Check: front rise (waistband top to crotch) is almost always 20–30 cm; back rise 30–40 cm.",
  "ARMPIT POINT: the corner where the sleeve's underside meets the body's side edge.",
  "SHOULDER HIGH POINT: where the shoulder seam meets the collar (neckline), not the top of the collar.",
  "SHOULDER SEAM POINT: where the ARMHOLE seam — the stitched line joining sleeve to body, which runs from the top edge down towards the armpit, often only a faint line or crease on dark fabric — meets the top edge. Find that seam line in a close-up and follow it up to the edge. It is NOT a bump, step or kink in the outline: on a drop-shoulder tee the seam sits a few cm inside the point where the outline bends (first T-shirt test, 2026-10-12: the bend read the shoulder 3 cm wide).",
  "EDGES: an end point lies on the outermost edge of the fabric, the fold line, not on a shadow beside it or on stitching just inside it.",
];

/** The landmarks worth finding before any line is drawn, per family. */
export const LANDMARKS: Record<GarmentType, string> = {
  top: "both shoulder high points (collar meets shoulder seam), both shoulder seam points, both armpit points, the collar seam at centre front/back, both sleeve-end corners on each sleeve, both hem corners.",
  dress: "both shoulder high points, both shoulder seam points, both armpit points, the collar seam at centre front/back, both sleeve-end corners, the narrowest waist, the widest hip, both hem corners.",
  trousers: "both top corners of the waistband, the waistband seam, the crotch seam point (where the two inside leg seams meet), both corners of each leg's hem, the outside edge of each leg at hip/thigh/knee/calf height, the pocket corners.",
  shorts: "both top corners of the waistband, the waistband seam, the crotch seam point, both corners of each leg's hem, the outside edge of each leg at hip/thigh height, the pocket corners.",
  skirt: "both top corners of the waistband, the waistband seam, both hem corners, the side edges 18 cm below the waistband.",
  onepiece: "both shoulder high points, both shoulder seam points, both armpit points, the collar seam at centre front/back, both sleeve-end corners, the waist, the crotch seam point, both corners of each leg's hem.",
};

/**
 * Plausible ranges for adult garments, in cm. A final answer outside one is
 * sent back once with the number, so the AI looks again instead of the
 * operator finding it. Ranges are wide on purpose — they catch a wrong
 * landmark (crotch at the leg gap: front rise 34 cm), not a size.
 */
export const PLAUSIBLE: Partial<Record<PomKey, { front?: [number, number]; back?: [number, number]; why: string }>> = {
  rise: {
    front: [17, 31],
    back: [27, 43],
    why: "front rise is almost always 20–30 cm (back rise 30–40 cm); a longer one means the crotch was put where the legs separate — move it up to where the centre seam ends, just below the fly",
  },
};
