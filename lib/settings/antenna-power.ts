/**
 * UHF handheld antenna output is expressed in **dBm** on a **0–30** scale (typical regulatory / reader UI range).
 * Older builds incorrectly used 0–300; normalize on read.
 */
export const ANTENNA_POWER_DBM_MAX = 30;

/** @internal legacy UI scale upper bound */
const LEGACY_ANTENNA_POWER_MAX = 300;

/**
 * Clamp to 0–30 dBm. Values &gt; 30 are treated as legacy 0–300 and scaled proportionally.
 */
export function normalizeAntennaPowerDbm(raw: number): number {
  if (!Number.isFinite(raw)) return 27;
  const x = Math.round(raw);
  if (x > ANTENNA_POWER_DBM_MAX) {
    return Math.min(
      ANTENNA_POWER_DBM_MAX,
      Math.max(0, Math.round((x / LEGACY_ANTENNA_POWER_MAX) * ANTENNA_POWER_DBM_MAX)),
    );
  }
  return Math.min(ANTENNA_POWER_DBM_MAX, Math.max(0, x));
}
