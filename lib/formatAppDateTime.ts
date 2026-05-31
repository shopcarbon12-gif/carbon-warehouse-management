/**
 * Display timezone for human-readable timestamps (US Eastern, observes DST).
 * Override with NEXT_PUBLIC_APP_TIME_ZONE or APP_TIME_ZONE (IANA), e.g. America/Chicago.
 */
const raw =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_APP_TIME_ZONE?.trim()) ||
  (typeof process !== "undefined" && process.env.APP_TIME_ZONE?.trim()) ||
  "America/New_York";

export const APP_TIME_ZONE = raw;

export function formatAppDateTime(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-US", {
    timeZone: APP_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "medium",
  });
}
