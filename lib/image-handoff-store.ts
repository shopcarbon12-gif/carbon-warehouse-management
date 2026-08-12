/**
 * Carbon Studio phone-camera hand-off — minimal in-memory session store.
 * Desktop creates a session (QR), the phone POSTs a captured photo (stored to
 * R2, url recorded here), desktop polls + consumes. Single web instance in
 * prod, so a module-level Map persists across requests. Sessions expire in 10m.
 */
export type HandoffSession = {
  id: string;
  createdAt: number;
  expiresAt: number;
  imageUrl: string | null;
};

const TTL_MS = 10 * 60 * 1000;
const SESSIONS = new Map<string, HandoffSession>();

function prune() {
  const now = Date.now();
  for (const [k, v] of SESSIONS) if (v.expiresAt < now) SESSIONS.delete(k);
}

export function createHandoffSession(): HandoffSession {
  prune();
  const now = Date.now();
  const s: HandoffSession = { id: crypto.randomUUID(), createdAt: now, expiresAt: now + TTL_MS, imageUrl: null };
  SESSIONS.set(s.id, s);
  return s;
}

export function getHandoffSession(id: string): HandoffSession | null {
  prune();
  return SESSIONS.get(id) || null;
}

export function setHandoffImage(id: string, url: string): boolean {
  const s = SESSIONS.get(id);
  if (!s) return false;
  s.imageUrl = url;
  s.expiresAt = Date.now() + TTL_MS;
  return true;
}

export function consumeHandoffImage(id: string): string | null {
  const s = SESSIONS.get(id);
  if (!s?.imageUrl) return null;
  const url = s.imageUrl;
  SESSIONS.delete(id);
  return url;
}
