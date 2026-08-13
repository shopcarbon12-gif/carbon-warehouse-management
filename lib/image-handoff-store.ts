/**
 * Carbon Studio phone-camera hand-off — in-memory session store.
 * Desktop creates a session (QR), the phone POSTs captured photos (stored to
 * R2), the desktop polls + picks them up one at a time. The session stays alive
 * (not deleted on pickup) so the phone can send more photos ("send another").
 * Single web instance in prod, so a module-level Map persists. TTL 15 min,
 * refreshed on every phone upload.
 */
export type HandoffImage = { id: string; url: string; path: string; taken: boolean };
export type HandoffSession = { id: string; createdAt: number; expiresAt: number; images: HandoffImage[] };

const TTL_MS = 15 * 60 * 1000;
const SESSIONS = new Map<string, HandoffSession>();

function prune() {
  const now = Date.now();
  for (const [k, v] of SESSIONS) if (v.expiresAt < now) SESSIONS.delete(k);
}

export function createHandoffSession(): HandoffSession {
  prune();
  const now = Date.now();
  const s: HandoffSession = { id: crypto.randomUUID(), createdAt: now, expiresAt: now + TTL_MS, images: [] };
  SESSIONS.set(s.id, s);
  return s;
}

export function getHandoffSession(id: string): HandoffSession | null {
  prune();
  return SESSIONS.get(id) || null;
}

/** Phone uploaded a photo (already stored to R2). Keeps the session alive. */
export function addHandoffImage(id: string, img: { url: string; path: string }): string | null {
  const s = SESSIONS.get(id);
  if (!s) return null;
  const imgId = crypto.randomUUID();
  s.images.push({ id: imgId, url: img.url, path: img.path, taken: false });
  s.expiresAt = Date.now() + TTL_MS;
  return imgId;
}

/** Desktop poll: return the next not-yet-taken image (marks it taken). */
export function takeNextHandoffImage(id: string): HandoffImage | null {
  const s = SESSIONS.get(id);
  if (!s) return null;
  const next = s.images.find((i) => !i.taken);
  if (!next) return null;
  next.taken = true;
  return next;
}

/** Desktop poll: return ALL not-yet-taken images at once (marks them taken).
 * Used so a phone burst of up to 6 photos all appear in one poll tick. */
export function takeAllHandoffImages(id: string): HandoffImage[] {
  const s = SESSIONS.get(id);
  if (!s) return [];
  const fresh = s.images.filter((i) => !i.taken);
  for (const i of fresh) i.taken = true;
  return fresh;
}

/** Look up a specific image (for the display proxy). */
export function findHandoffImage(id: string, imageId: string): HandoffImage | null {
  const s = SESSIONS.get(id);
  return s?.images.find((i) => i.id === imageId) || null;
}
