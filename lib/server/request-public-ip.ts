/**
 * Extract the request's public IP from the standard proxy headers.
 *
 * Coolify's single Traefik front-end APPENDS the real TCP peer to
 * `x-forwarded-for`, so the LAST hop is the one it set and cannot be spoofed
 * by the client; the leftmost entries may be attacker-supplied. We therefore
 * read the last hop (used for agent IP matching / live-scan prewarm, which
 * must not be triggerable for an arbitrary tenant via a forged header).
 * `x-real-ip` / `cf-connecting-ip` (also proxy-set) are fallbacks.
 *
 * Returns null if no usable IP could be determined.
 */
export function extractPublicIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  // Some Coolify setups also use cf-connecting-ip from upstream Cloudflare.
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  return null;
}
