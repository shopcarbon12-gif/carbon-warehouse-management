/**
 * Public HTTPS (or dev HTTP) origin for absolute links returned to mobile clients.
 * Prefer env (production behind reverse proxy); fall back to request URL host.
 */
export function publicOriginFromRequest(req: Request): string {
  const fromEnv =
    process.env.WMS_APP_PUBLIC_BASE_URL?.trim() || process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const { protocol, host } = new URL(req.url);
  return `${protocol}//${host}`;
}

/** Turn relative paths like `/uploads/...` into full URLs handhelds can fetch. */
export function toAbsolutePublicUrl(req: Request, pathOrUrl: string): string {
  const p = pathOrUrl.trim();
  if (!p) return p;
  if (/^https?:\/\//i.test(p)) return p;
  const origin = publicOriginFromRequest(req);
  return `${origin}${p.startsWith("/") ? p : `/${p}`}`;
}
