import { cookies } from "next/headers";
import { verifySessionToken, type SessionPayload } from "@/lib/auth";

/**
 * Cookie (browser) or `Authorization: Bearer` (Carbon mobile). Prefer Bearer when both exist.
 */
export async function getSessionFromRequest(req: Request): Promise<SessionPayload | null> {
  const auth = req.headers.get("authorization");
  const m = auth?.match(/^Bearer\s+(.+)$/i);
  if (m?.[1]) {
    const s = await verifySessionToken(m[1].trim());
    if (s) return s;
  }
  const jar = await cookies();
  const c = jar.get("wms_session")?.value;
  if (!c) return null;
  return verifySessionToken(c);
}
