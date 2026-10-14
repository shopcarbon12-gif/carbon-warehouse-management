/**
 * What each Studio frame IS, stated as fact for the server prompt and the
 * judges. Nothing here asks a model anything: the pose libraries fix which
 * poses face away from the camera, and the accessory shot list fixes what each
 * shot shows.
 */

/** The poses shot from behind (lib/panelPoseLibraries.ts): female 2; male 4 and 7. */
export function isBackFacingPose(gender: string, pose: number | null): boolean {
  if (!Number.isFinite(Number(pose))) return false;
  const p = Number(pose);
  const g = String(gender || "").trim().toLowerCase();
  if (g === "female") return p === 2;
  return p === 4 || p === 7;
}

/**
 * Accessory mode (lib/accessoryShots.ts): shots 1-4 are product-only, 5-6 are
 * worn, 7 is the pairing shot that adds ONE companion piece on purpose, 8 is
 * the editorial flat lay.
 */
export function accessoryShotRole(shot: number | null): string {
  const s = Number(shot);
  if (s >= 1 && s <= 4) return "product only — no person";
  if (s === 5 || s === 6) return "worn";
  if (s === 7) return "pairing — adds one companion piece by design";
  if (s === 8) return "flat lay";
  return "";
}
