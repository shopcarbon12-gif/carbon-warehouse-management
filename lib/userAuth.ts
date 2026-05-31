/**
 * WMS shim for the ported Shopify Collection Mapping feature.
 *
 * The feature's API route imports `readSession` (originally carbon-gen's
 * cookie-based auth) purely to scope each user's in-progress *drafts* — it is
 * NOT a security gate (the WMS proxy already authenticates every /api/* call).
 * WMS sessions are signed JWTs in the `wms_session` cookie (or a Bearer token);
 * we synchronously decode the JWT payload (no signature check needed for draft
 * scoping) to recover the user id / email. Returns empty identity when absent,
 * in which case the route falls back to its per-client fingerprint scoping.
 */
import type { NextRequest } from "next/server";

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readSession(req: NextRequest) {
  const bearer = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const cookie = req.cookies.get("wms_session")?.value || "";
  const token = bearer || cookie;
  const payload = token ? decodeJwtPayload(token) : null;
  const userId = String(payload?.sub || "").trim();
  const username = String(payload?.email || "").trim();
  const role = String(payload?.role || "").trim();
  return { isAuthed: Boolean(userId), userId, username, role };
}
