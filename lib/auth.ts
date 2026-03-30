import { SignJWT, jwtVerify } from "jose";

const COOKIE_NAME = "wms_session";

export type SessionPayload = {
  sub: string;
  email: string;
  tid: string;
  lid: string;
  /** `memberships.role` at login / location switch (default `member`). */
  role: string;
  /** Super Admin JSON flag `device_security.can_bypass_device_lock` (JWT claim `bdl`). */
  bypassDeviceLock?: boolean;
};

function getSecret(): Uint8Array {
  const raw =
    process.env.SESSION_SECRET?.trim() ||
    "dev-only-change-me-min-32-chars!!!!";
  return new TextEncoder().encode(raw);
}

export function sessionCookieName(): string {
  return COOKIE_NAME;
}

/**
 * Use Secure on `wms_session` only when the client used HTTPS. In production,
 * `secure: true` on plain HTTP makes browsers ignore Set-Cookie, so login returns
 * 200 but the next navigation has no session. Coolify/Traefik send
 * `X-Forwarded-Proto`; override with `WMS_SESSION_COOKIE_SECURE=0|1` if needed.
 */
export function sessionCookieSecure(req: Request): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  const override = process.env.WMS_SESSION_COOKIE_SECURE?.trim();
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;
  const raw = req.headers.get("x-forwarded-proto");
  const proto = raw?.split(",")[0]?.trim().toLowerCase();
  return proto === "https";
}

export async function signSession(p: SessionPayload): Promise<string> {
  return new SignJWT({
    tid: p.tid,
    lid: p.lid,
    email: p.email,
    role: p.role,
    ...(p.bypassDeviceLock ? { bdl: true } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(p.sub)
    .setExpirationTime("7d")
    .sign(getSecret());
}

export async function verifySessionToken(
  token: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const sub = payload.sub;
    const tid = payload.tid as string | undefined;
    const lid = payload.lid as string | undefined;
    const email = payload.email as string | undefined;
    const roleRaw = payload.role as string | undefined;
    const bdl = payload.bdl as boolean | undefined;
    if (!sub || !tid || !lid || !email) return null;
    const role = roleRaw?.trim() || "member";
    return {
      sub,
      tid,
      lid,
      email,
      role,
      bypassDeviceLock: Boolean(bdl),
    };
  } catch {
    return null;
  }
}
