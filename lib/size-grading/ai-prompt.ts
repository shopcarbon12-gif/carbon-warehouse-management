/**
 * What the vision model is asked, per garment and per point of measure.
 *
 * Shared by the API route and the tests so the wording that was tested is
 * the wording that ships. See ai-lines.ts for what happens to the answer.
 *
 * Wording that mattered on the owner's photos:
 *  - the calibration sheet and everything that is not the garment are named
 *    as not-the-garment, or the model measures the table;
 *  - every coordinate is on a grid drawn INTO the picture — asked for raw
 *    pixel positions, models drift by several percent;
 *  - one leg / one sleeve is named ("the one on the left of the photo") so
 *    the seams and widths come from the same side and can share corners.
 */

import type { GarmentType, PomKey } from "./garment";

const HINT: Partial<Record<PomKey, string>> = {
  chest: "straight across the body 2.5 cm below the armpits, side edge to side edge",
  waist: "straight across at the waist: for trousers, shorts and skirts the very top edge of the waistband, edge to edge; for tops and dresses the narrowest part of the body",
  hip: "straight across the seat / hips at the widest point, edge to edge",
  hem: "straight across the bottom hem, edge to edge",
  length: "from the highest point of the shoulder next to the collar straight down to the bottom hem (for skirts: waistband top to hem)",
  shoulder: "straight across from one shoulder seam point to the other",
  armhole: "from the top of the shoulder seam straight down to the armpit, on the sleeve on the left of the photo",
  sleeve: "along the sleeve on the left of the photo, from its shoulder seam point to the end of the cuff",
  sleeveInseam: "along the underside of the sleeve on the left of the photo, from the armpit to the end of the cuff",
  bicep: "across the sleeve on the left of the photo, 2.5 cm below the armpit, perpendicular to the sleeve, edge to edge",
  cuff: "across the opening at the end of the sleeve on the left of the photo, edge to edge",
  thigh: "across the leg on the left of the photo, 2.5 cm below the crotch, from the inner edge to the outer edge, perpendicular to the leg",
  knee: "across the same leg halfway between the crotch and the hem, edge to edge, perpendicular to the leg",
  calf: "across the same leg two thirds of the way from the crotch to the hem, edge to edge, perpendicular to the leg",
  legOpening: "across the bottom hem of the same leg, edge to edge",
  inseam: "from the crotch point (where the legs meet) down the inner edge of the same leg to its hem",
  outseam: "from the top outer corner of the waistband down the outer edge of the same leg to its hem",
  rise: "from the top edge of the waistband at the centre straight down to the crotch point",
  neck: "across the neck opening from one side seam point to the other",
  neckDrop: "from the line between the two neck side points straight down to the lowest point of the neckline",
  collarHeight: "across the collar at the centre, from its top edge to the neck seam",
  shoulderSlope: "from the neck side point down to the shoulder seam point, on the left of the photo",
  waistbandHeight: "a short vertical line at the centre from the top edge of the waistband to its bottom seam",
  frontPocketOpening: "along the opening edge of the front pocket on the left of the photo",
  backPocketWidth: "across the top of the back pocket on the left of the photo, edge to edge",
  backPocketLength: "from the top edge of the back pocket on the left of the photo down to its lowest point",
};

const TYPE_WORDS: Record<GarmentType, string> = {
  top: "a top / T-shirt / shirt",
  trousers: "trousers / leggings / jeans",
  shorts: "shorts",
  dress: "a dress",
  skirt: "a skirt",
  onepiece: "a romper / bodysuit / overall",
};

export const AI_GRID_STEP = 100; // grid labelled every 100 on a 0–1000 scale

export function buildAiPrompt(keys: PomKey[], type: GarmentType | null, view: "front" | "back"): string {
  const pts = keys.map((k) => `- ${k}: ${HINT[k] ?? k}.`).join("\n");
  return `You are a garment technologist measuring a garment laid flat, photographed from above and squared up to a true top-down view.
A printed calibration sheet (a grey rectangular ring on white paper) is in the photo: it is NOT the garment. Tables, floors, paper, fabric scraps, tools and hands are NOT the garment. Measure only the ONE main garment.
${type ? `It is ${TYPE_WORDS[type]}, lying ${view} side up.` : `It is lying ${view} side up.`}

A grid is drawn over the photo: x from 0 (left) to 1000 (right), y from 0 (top) to 1000 (bottom), labelled every ${AI_GRID_STEP}. Give every coordinate on that scale, as precisely as you can.

Return JSON only:
{
 "garment": "top" | "trousers" | "shorts" | "dress" | "skirt" | "onepiece",
 "description": "short, e.g. black leggings",
 "box": [x0, y0, x1, y1],
 "on": [[x, y], ...],
 "off": [[x, y], ...],
 "lines": { "<point>": {"a": [x, y], "b": [x, y]} | null }
}
"box": a tight box round the whole garment.
"on": 6 points certainly ON the garment fabric, well inside its edges, spread over the whole garment.
"off": 4 points certainly NOT the garment, just outside its edges (the surface beside it, the calibration sheet, other objects).
"lines": for each point of measure, the two ends of the line a tape measure would follow, with each end exactly ON the garment's edge or seam:
${pts}
Use null for a point that does not exist on this garment or cannot be seen.`;
}
