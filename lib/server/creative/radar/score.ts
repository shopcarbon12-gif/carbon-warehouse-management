/**
 * Radar — winner_score. PUBLIC ACTIVITY SIGNALS ONLY (never "sales"): how long an ad has run,
 * how many variations and platforms it has, and whether it is still running. The one place the
 * formula lives; the Radar tooltip reads WINNER_SCORE_EXPLAINED.
 */
export const WINNER_WEIGHTS = {
  days: 0.45, // days_running, saturating at 90 days
  variations: 0.25, // variation_count, saturating at 10
  platforms: 0.15, // platform_count, saturating at 4
  active: 0.15, // still running today
} as const;

export const WINNER_SCORE_EXPLAINED =
  "Winner score (0–100) uses public activity signals only — never sales: 45% days running (full at 90 days), 25% variations (full at 10), 15% platforms (full at 4), 15% still running. Brands keep spending on ads that work, so long-running, many-variation ads are the likeliest winners.";

export function winnerScore(v: { daysRunning: number | null; variations: number; platforms: number; active: boolean | null }): number | null {
  if (v.daysRunning == null && v.active == null) return null;
  const d = Math.min(1, Math.max(0, v.daysRunning ?? 0) / 90);
  const va = Math.min(1, Math.max(0, v.variations - 1) / 9);
  const p = Math.min(1, Math.max(0, v.platforms - 1) / 3);
  const a = v.active ? 1 : 0;
  return Math.round((d * WINNER_WEIGHTS.days + va * WINNER_WEIGHTS.variations + p * WINNER_WEIGHTS.platforms + a * WINNER_WEIGHTS.active) * 100);
}

export function scoreBreakdown(v: { daysRunning: number | null; variations: number; platforms: number; active: boolean | null }) {
  return {
    days: Math.round(Math.min(1, Math.max(0, v.daysRunning ?? 0) / 90) * WINNER_WEIGHTS.days * 100),
    variations: Math.round(Math.min(1, Math.max(0, v.variations - 1) / 9) * WINNER_WEIGHTS.variations * 100),
    platforms: Math.round(Math.min(1, Math.max(0, v.platforms - 1) / 3) * WINNER_WEIGHTS.platforms * 100),
    active: v.active ? Math.round(WINNER_WEIGHTS.active * 100) : 0,
  };
}

export function daysRunning(first: string | Date | null, last: string | Date | null, active: boolean | null): number | null {
  if (!first) return null;
  const a = new Date(first).getTime();
  const b = active || !last ? Date.now() : new Date(last).getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000));
}
