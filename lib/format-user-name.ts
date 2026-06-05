/**
 * Canonical user display name for the WHOLE app — UI and exported reports.
 *
 * Rule (locked 2026-06): never show a user's email in any human-facing place.
 * Always render "First L." — first name + last-initial + dot, e.g. "Elior P.".
 * Falls back to the email's local part, then the raw email, only when no name
 * is on file (so an unnamed account never renders blank).
 */
export function formatUserDisplayName(
  first: string | null | undefined,
  last: string | null | undefined,
  email?: string | null,
): string {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  if (f) return l ? `${f} ${l[0]!.toUpperCase()}.` : f;
  if (email) {
    const local = email.split("@")[0]?.trim();
    return local && local.length > 0 ? local : email;
  }
  return "";
}
