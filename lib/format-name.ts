/**
 * Short human display name: "Elior P." (first name + last initial). Falls back
 * to just the first name, then the email's LOCAL PART, then a dash. Used
 * wherever a user's identity is shown so we NEVER surface a raw email address
 * (locked rule 2026-06: always "First L.", never the email).
 */
export function shortName(
  first: string | null | undefined,
  last: string | null | undefined,
  email?: string | null,
): string {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  if (f && l) return `${f} ${l.charAt(0).toUpperCase()}.`;
  if (f) return f;
  if (l) return l;
  // Never surface a full email — fall back to its local part only.
  const e = (email ?? "").trim();
  if (e) return e.split("@")[0]!.trim() || "—";
  return "—";
}
