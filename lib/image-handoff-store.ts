/**
 * Carbon Studio phone-camera hand-off — session store, in Postgres.
 *
 * Desktop creates a session (QR) for a product, the phone POSTs captured
 * photos (stored to R2, registered here), the desktop polls and collects
 * them. The session stays alive (not deleted on pickup) so the phone can send
 * more; TTL 15 min from the last upload, capped at 2 h from creation; rows are
 * pruned 24 h after expiry so a late recovery still finds them.
 *
 * This used to be a module-level Map. A deploy or restart wiped every pending
 * photo's pointer while the bytes sat in R2 — and there was no way to ask
 * "what did this session ever receive", so anything the desktop missed was
 * gone for good. Rows now outlive the process; `listHandoffImages` lets the
 * desktop re-collect a live session, and `recoverHandoffImagesForMatrix`
 * finds photos a closed panel never collected.
 */
import { getPool } from "@/lib/db";

export type HandoffImage = { id: string; url: string; path: string; taken: boolean };
export type HandoffSession = {
  id: string;
  createdAt: number;
  expiresAt: number;
  matrixId: string | null;
  /** The desktop polled within the last 10 s. */
  listening: boolean;
};

const TTL_MS = 15 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Per-session ceiling on registered photos (6 per request; a session is one product). */
export const MAX_IMAGES_PER_SESSION = 60;

/** The session is expired or gone: the phone must scan a new code. */
export class HandoffSessionGone extends Error {
  constructor() {
    super("Session not found or expired — scan the QR code again.");
    this.name = "HandoffSessionGone";
  }
}
/** The session already holds MAX_IMAGES_PER_SESSION photos. */
export class HandoffSessionFull extends Error {
  constructor() {
    super(`This session already holds ${MAX_IMAGES_PER_SESSION} photos — start a new one on the computer.`);
    this.name = "HandoffSessionFull";
  }
}

function pool() {
  const p = getPool();
  if (!p) throw new Error("Database unavailable");
  return p;
}

function rowToSession(row: {
  id: string;
  created_at: string | Date;
  expires_at: string | Date;
  matrix_id: string | null;
  last_polled_at: string | Date | null;
}): HandoffSession {
  const polled = row.last_polled_at ? new Date(row.last_polled_at).getTime() : 0;
  return {
    id: row.id,
    createdAt: new Date(row.created_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime(),
    matrixId: row.matrix_id,
    listening: polled > 0 && Date.now() - polled < 10_000,
  };
}

async function prune() {
  // Best effort; a failed prune must never fail the request that triggered it.
  try {
    await pool().query(`DELETE FROM studio_handoff_sessions WHERE expires_at < now() - interval '24 hours'`);
  } catch {
    /* ignore */
  }
}

export async function createHandoffSession(matrixId: string | null): Promise<HandoffSession> {
  await prune();
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + TTL_MS;
  await pool().query(
    `INSERT INTO studio_handoff_sessions (id, created_at, expires_at, matrix_id)
     VALUES ($1::uuid, to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), $4::uuid)`,
    [id, now, expiresAt, matrixId && UUID_RE.test(matrixId) ? matrixId : null]
  );
  return { id, createdAt: now, expiresAt, matrixId: matrixId && UUID_RE.test(matrixId) ? matrixId : null, listening: false };
}

/** A live session (for the phone's upload and the desktop's normal poll). */
export async function getHandoffSession(id: string): Promise<HandoffSession | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await pool().query(
    `SELECT id, created_at, expires_at, matrix_id, last_polled_at
       FROM studio_handoff_sessions WHERE id = $1::uuid AND expires_at >= now()`,
    [id]
  );
  return r.rows[0] ? rowToSession(r.rows[0]) : null;
}

/** A session that may have expired up to 24 h ago — for re-collecting. */
export async function getHandoffSessionForRecovery(id: string): Promise<HandoffSession | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await pool().query(
    `SELECT id, created_at, expires_at, matrix_id, last_polled_at
       FROM studio_handoff_sessions WHERE id = $1::uuid AND expires_at >= now() - interval '24 hours'`,
    [id]
  );
  return r.rows[0] ? rowToSession(r.rows[0]) : null;
}

/** The desktop is polling: remembered so the phone can be told nobody is. */
export async function touchHandoffPoll(id: string): Promise<void> {
  await pool().query(`UPDATE studio_handoff_sessions SET last_polled_at = now() WHERE id = $1::uuid`, [id]);
}

/** Phone uploaded photos (already stored to R2). Registered in ONE
 *  transaction whose first statement re-checks the session is alive — the
 *  check outside the write let a prune between them surface as a raw
 *  foreign-key error on the phone. Refreshes the session (capped at 2 h from
 *  creation). Returns the new image ids in arrival order. */
export async function addHandoffImages(id: string, imgs: { url: string; path: string }[]): Promise<string[]> {
  if (!imgs.length) return [];
  if (!UUID_RE.test(id)) throw new HandoffSessionGone();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const alive = await client.query(
      `UPDATE studio_handoff_sessions
          SET expires_at = LEAST(now() + interval '15 minutes', created_at + interval '2 hours')
        WHERE id = $1::uuid AND expires_at >= now()
        RETURNING id`,
      [id]
    );
    if (!alive.rowCount) throw new HandoffSessionGone();
    const count = await client.query(`SELECT count(*)::int AS n FROM studio_handoff_images WHERE session_id = $1::uuid`, [id]);
    if (Number(count.rows[0]?.n || 0) + imgs.length > MAX_IMAGES_PER_SESSION) throw new HandoffSessionFull();
    const ids: string[] = [];
    for (const img of imgs) {
      const r = await client.query(
        `INSERT INTO studio_handoff_images (session_id, url, path) VALUES ($1::uuid, $2, $3) RETURNING id`,
        [id, img.url, img.path]
      );
      ids.push(r.rows[0].id);
    }
    await client.query("COMMIT");
    return ids;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if ((e as { code?: string })?.code === "23503") throw new HandoffSessionGone();
    throw e;
  } finally {
    client.release();
  }
}

const mapRows = (rows: { id: string; url: string; path: string }[]): HandoffImage[] =>
  rows.map((row) => ({ id: row.id, url: row.url, path: row.path, taken: true }));

/** Desktop poll: every not-yet-collected image, in arrival order, marked collected. */
export async function takeAllHandoffImages(id: string): Promise<HandoffImage[]> {
  const r = await pool().query(
    `WITH fresh AS (
       SELECT id FROM studio_handoff_images WHERE session_id = $1::uuid AND taken_at IS NULL
     )
     UPDATE studio_handoff_images i SET taken_at = now()
       FROM fresh WHERE i.id = fresh.id
     RETURNING i.id, i.url, i.path, i.seq`,
    [id]
  );
  return mapRows(r.rows.sort((a, b) => Number(a.seq) - Number(b.seq)));
}

/** Everything this session ever received, collected or not (the desktop
 *  dedupes) — the recovery path for a panel that stopped listening. */
export async function listHandoffImages(id: string): Promise<HandoffImage[]> {
  const r = await pool().query(
    `UPDATE studio_handoff_images SET taken_at = COALESCE(taken_at, now())
       WHERE session_id = $1::uuid
     RETURNING id, url, path, seq`,
    [id]
  );
  return mapRows(r.rows.sort((a, b) => Number(a.seq) - Number(b.seq)));
}

/** Photos sent for this product (last 24 h) that no desktop ever collected.
 *  `take` marks them collected; otherwise it only counts. */
export async function recoverHandoffImagesForMatrix(
  matrixId: string,
  take: boolean
): Promise<{ count: number; images: HandoffImage[] }> {
  if (!UUID_RE.test(matrixId)) return { count: 0, images: [] };
  if (!take) {
    const r = await pool().query(
      `SELECT count(*)::int AS n
         FROM studio_handoff_images i JOIN studio_handoff_sessions s ON s.id = i.session_id
        WHERE s.matrix_id = $1::uuid AND i.taken_at IS NULL AND s.expires_at >= now() - interval '24 hours'`,
      [matrixId]
    );
    return { count: Number(r.rows[0]?.n || 0), images: [] };
  }
  const r = await pool().query(
    `WITH fresh AS (
       SELECT i.id FROM studio_handoff_images i JOIN studio_handoff_sessions s ON s.id = i.session_id
        WHERE s.matrix_id = $1::uuid AND i.taken_at IS NULL AND s.expires_at >= now() - interval '24 hours'
     )
     UPDATE studio_handoff_images i SET taken_at = now()
       FROM fresh WHERE i.id = fresh.id
     RETURNING i.id, i.url, i.path, i.seq`,
    [matrixId]
  );
  const images = mapRows(r.rows.sort((a, b) => Number(a.seq) - Number(b.seq)));
  return { count: images.length, images };
}

/** Look up a specific image (for the display proxy). */
export async function findHandoffImage(id: string, imageId: string): Promise<HandoffImage | null> {
  if (!UUID_RE.test(id) || !UUID_RE.test(imageId)) return null;
  const r = await pool().query(
    `SELECT id, url, path, taken_at FROM studio_handoff_images WHERE session_id = $1::uuid AND id = $2::uuid`,
    [id, imageId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return { id: row.id, url: row.url, path: row.path, taken: row.taken_at != null };
}
