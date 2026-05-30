/**
 * Short human display name: "Elior P." (first name + last initial). Falls back
 * to just the first name, then the email, then a dash. Used wherever a user's
 * identity is shown in a compact column ("By", "Created by", "Cashier", …) so
 * we never surface a raw email when a real name is available.
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
  return (email ?? "").trim() || "—";
}
