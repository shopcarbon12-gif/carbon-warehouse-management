import { SignJWT, jwtVerify } from "jose";

const COOKIE_NAME = "wms_session";

export type SessionPayload = {
  sub: string;
  email: string;
  tid: string;
  lid: string;
  /** `memberships.role` at login / location switch (default `member`). */
  role: string;
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

export async function signSession(p: SessionPayload): Promise<string> {
  return new SignJWT({
    tid: p.tid,
    lid: p.lid,
    email: p.email,
    role: p.role,
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
    if (!sub || !tid || !lid || !email) return null;
    const role = roleRaw?.trim() || "member";
    return { sub, tid, lid, email, role };
  } catch {
    return null;
  }
}
