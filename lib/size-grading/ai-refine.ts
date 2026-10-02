/**
 * Tighten a line the vision model placed onto the garment's real edge.
 *
 * The model knows WHERE a measurement goes — which row is the hip, which point
 * is the crotch — far better than the silhouette code. What it is less good at
 * is landing on the exact pixel where fabric meets table; a few pixels out is a
 * few millimetres out. The silhouette is the opposite: useless at deciding
 * where the hip is, exact about where the edge is once you are standing next
 * to it. So the model chooses the place and the mask chooses the pixel.
 *
 * Bounded on purpose. An end only moves if a real inside→outside edge is
 * within `maxPx` of where the model put it, along the line itself. When the
 * mask is wrong — a dark garment on a dark table — there is usually no such
 * edge nearby and the model's point stands, rather than being dragged onto
 * whatever the mask mistook for the garment.
 *
 * Pure functions, no DOM, so they run in node tests too.
 */

import type { PomKey } from "./garment";
import type { Point, ShirtMask } from "./measure";

/** Points whose two ends sit on the garment's outline, along the line itself. */
export const SNAPPABLE: ReadonlySet<PomKey> = new Set<PomKey>([
  "chest", "waist", "hip", "hem", "thigh", "knee", "calf", "legOpening", "cuff", "bicep", "length", "rise",
]);

function inside(mask: ShirtMask, p: Point): boolean {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return false;
  return mask.data[y * mask.width + x] === 1;
}

/**
 * Move `end` along the outward direction (away from `other`) to the nearest
 * place where the garment stops. Null when there is no such place close by.
 */
export function snapEnd(mask: ShirtMask, end: Point, other: Point, maxPx: number): Point | null {
  const dx = end.x - other.x;
  const dy = end.y - other.y;
  const len = Math.hypot(dx, dy);
  if (len < 2) return null;
  const ux = dx / len;
  const uy = dy / len;
  const at = (t: number): Point => ({ x: end.x + ux * t, y: end.y + uy * t });

  let best: number | null = null;
  const R = Math.max(2, Math.round(maxPx));
  for (let t = -R; t < R; t++) {
    /* Inside here, outside one step further out — and it holds for a couple
       of pixels either side, so a single stray mask pixel is not an edge. */
    if (!inside(mask, at(t)) || inside(mask, at(t + 1))) continue;
    if (!inside(mask, at(t - 2)) || inside(mask, at(t + 3))) continue;
    if (best === null || Math.abs(t) < Math.abs(best)) best = t;
  }
  return best === null ? null : at(best + 0.5);
}

/**
 * A mask worth snapping to at all: neither empty nor the whole picture, and
 * actually containing the middle of the line the model drew across the garment.
 */
export function maskAgrees(mask: ShirtMask, a: Point, b: Point): boolean {
  const total = mask.width * mask.height;
  if (mask.area < total * 0.02 || mask.area > total * 0.8) return false;
  return inside(mask, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
}

export function refineLine(
  key: string,
  mask: ShirtMask | null,
  a: Point,
  b: Point,
  maxPx: number,
): { a: Point; b: Point; snapped: number } {
  if (!mask || !SNAPPABLE.has(key as PomKey)) return { a, b, snapped: 0 };
  /* A length runs from edge to edge too, but its middle is not always on the
     garment (a rise ends in the gap between the legs), so only the width-type
     lines are required to agree before snapping. */
  const across = key !== "length" && key !== "rise";
  if (across && !maskAgrees(mask, a, b)) return { a, b, snapped: 0 };
  const na = snapEnd(mask, a, b, maxPx);
  const nb = snapEnd(mask, b, a, maxPx);
  return { a: na ?? a, b: nb ?? b, snapped: (na ? 1 : 0) + (nb ? 1 : 0) };
}
