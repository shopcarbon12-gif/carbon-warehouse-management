/**
 * Extract the request's public IP from the standard proxy headers.
 *
 * Coolify's Traefik front-end sets `x-forwarded-for` (comma-separated
 * chain — leftmost is the original client). `x-real-ip` is also set on
 * single-hop setups. Falls back to the connection peer if neither
 * header exists (won't be a real public IP in production, but useful
 * for local dev).
 *
 * Returns null if no usable IP could be determined.
 */
export function extractPublicIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // Pick the first non-empty hop. Strip whitespace.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  // Some Coolify setups also use cf-connecting-ip from upstream Cloudflare.
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  return null;
}
