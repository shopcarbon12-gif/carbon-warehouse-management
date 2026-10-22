/**
 * Return `p` only when it is a safe same-origin path, else `fallback`.
 *
 * A value like "//attacker.example" or "/\attacker.example" also starts with
 * "/" but is protocol-relative and would navigate off-site, so a bare
 * `startsWith("/")` check is an open redirect. Reject those and control
 * characters.
 */
export function safeInternalPath(
  p: string | null | undefined,
  fallback = "/dashboard",
): string {
  if (!p || !p.startsWith("/")) return fallback;
  if (p.startsWith("//") || p.startsWith("/\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(p)) return fallback;
  return p;
}
