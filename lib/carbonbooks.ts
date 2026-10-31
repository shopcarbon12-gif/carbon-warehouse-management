import { createHmac, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import type { SessionPayload } from "@/lib/auth";

/**
 * CarbonBooks (books.shopcarbon.com) is a separate app opened from one item in the WMS menu.
 * WMS never reads CarbonBooks' data: it asks CarbonBooks whether to show the item, and hands the
 * signed-in user over with a one-time, 60-second pass signed with the shared secret.
 * Off (item hidden) unless CARBON_BOOKS_URL and CARBON_BOOKS_HANDOFF_SECRET are set.
 */
export function carbonBooksConfig(): { url: string; secret: Uint8Array } | null {
  const url = process.env.CARBON_BOOKS_URL?.trim().replace(/\/+$/, "");
  const raw = process.env.CARBON_BOOKS_HANDOFF_SECRET?.trim() ?? "";
  if (!url || raw.length < 32) return null;
  return { url, secret: new TextEncoder().encode(raw) };
}

export function signCarbonBooksHandoff(session: SessionPayload, secret: Uint8Array): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: session.email, tid: session.tid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.sub)
    .setIssuer("carbon-wms")
    .setAudience("carbon-books")
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(secret);
}

const cache = new Map<string, { visible: boolean; at: number }>();
const CACHE_MS = 60_000;

/** Whether CarbonBooks says this WMS user may see it. Any failure → hidden. Cached 60 s per user. */
export async function carbonBooksVisible(userId: string): Promise<boolean> {
  const cfg = carbonBooksConfig();
  if (!cfg) return false;
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.visible;
  let visible = false;
  try {
    const key = createHmac("sha256", cfg.secret).update("carbonbooks-visibility").digest("base64url");
    const res = await fetch(`${cfg.url}/api/wms/visibility?user=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    visible = res.ok && (await res.json()).visible === true;
  } catch {
    visible = false;
  }
  cache.set(userId, { visible, at: Date.now() });
  return visible;
}
