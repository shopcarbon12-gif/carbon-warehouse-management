/**
 * Employee / staff display names — owner rule (2026-10-12):
 *
 *   "when using employees name across all the projects, we should mention
 *    only first name and the first letter of the last name, e.g. Julian P.
 *    — only in reports you should keep it full."
 *
 * So everywhere OUTSIDE the Reports area an employee is shown as
 * "First L.". Reports (app/(main)/reports/*, components/reports/*,
 * app/api/reports/*) keep the full name and must NOT use this helper.
 *
 * Display only — never apply this before writing to the database; stored
 * snapshots (e.g. picked_by_name) stay full so reports can show them.
 *
 * NOT for customer names — customers are always shown as-is.
 */

/**
 * "Julian Perez" → "Julian P."; "Ana María de la Cruz" → "Ana C." (first
 * token + initial of the LAST token). A single name is returned unchanged,
 * extra whitespace is collapsed, and null / empty / email values pass
 * straight through. Idempotent: "Julian P." → "Julian P.".
 */
export function shortStaffName(full: string | null | undefined): string | null | undefined {
  if (full == null) return full;
  const s = full.trim().replace(/\s+/g, " ");
  if (!s) return full;
  if (s.includes("@")) return s; // an email, not a name — leave it alone
  const parts = s.split(" ");
  if (parts.length === 1) return s;
  const first = parts[0]!;
  const initial = parts[parts.length - 1]!.replace(/^[^\p{L}\p{N}]+/u, "").charAt(0).toUpperCase();
  return initial ? `${first} ${initial}.` : first;
}

/**
 * Staff label for a history row that has both a live users row (first/last)
 * and a stored snapshot (often the email). Prefers "First L." from the users
 * row; otherwise shortens the snapshot (an email shows only its local part).
 */
export function staffLabel(
  first: string | null | undefined,
  last: string | null | undefined,
  snapshot?: string | null,
): string | null {
  const name = [first, last].map((v) => (v ?? "").trim()).filter(Boolean).join(" ");
  if (name) return shortStaffName(name) ?? null;
  const snap = (snapshot ?? "").trim();
  if (!snap) return null;
  if (snap.includes("@")) return snap.split("@")[0]!.trim() || snap;
  return shortStaffName(snap) ?? null;
}
