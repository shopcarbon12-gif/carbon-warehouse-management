/**
 * Stored look anchors: the panel 1 of a run, kept per (product, model, colour)
 * so a later partial re-render ("Keep look") can attach it and match the crops
 * it will sit beside. Today a one-panel fix has nothing to match and the
 * operator re-renders all four.
 *
 * Objects live in R2 under carbon-studio/look-anchors/<tenant>/<matrix>/; the
 * index is studio_matrix_state.look_anchors (migration 0114). Everything here
 * is best-effort: a storage or database failure costs the stored look, never
 * the render it came from.
 */
import { getPool } from "@/lib/db";
import {
  deleteStorageObjects,
  isR2StorageConfigured,
  tryGetStoragePathFromUrl,
  uploadBytesToStorage,
} from "@/lib/storageProvider";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* models.model_id is free TEXT; anything but the key separator "|" and whitespace. */
const MODEL_ID_RE = /^[A-Za-z0-9_.:@-]{1,80}$/;

export type StoredLookAnchor = {
  url: string;
  runTag: string;
  at: string;
  modelId: string;
  colour: string;
  /** null = never judged; pass | flagged | forced (operator rendered anyway) | unavailable. */
  gate: string | null;
};

/** The only prefix a stored look anchor may come from, for this tenant and product. */
export function lookAnchorPrefix(tenantId: string, matrixId: string): string {
  return `carbon-studio/look-anchors/${tenantId}/${matrixId}/`;
}

export function normalizeLookColour(colour: unknown): string {
  return typeof colour === "string" ? colour.replace(/\s+/g, " ").trim().slice(0, 80) : "";
}

/** `<modelId>|<COLOUR>` — the colour upper-cased so "Black" and "BLACK" are one look. */
export function lookAnchorKey(modelId: string, colour: string): string {
  return `${modelId}|${normalizeLookColour(colour).toUpperCase()}`;
}

export function isValidLookModelId(v: unknown): v is string {
  return typeof v === "string" && MODEL_ID_RE.test(v);
}

/** What GET /api/studio/state hands back: only well-formed entries. */
export function sanitizeLookAnchors(v: unknown): Record<string, StoredLookAnchor> {
  const out: Record<string, StoredLookAnchor> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url.trim() : "";
    if (!/^https?:\/\//i.test(url) || url.length > 2048) continue;
    out[key.slice(0, 200)] = {
      url,
      runTag: typeof o.runTag === "string" ? o.runTag.slice(0, 96) : "",
      at: typeof o.at === "string" ? o.at.slice(0, 40) : "",
      modelId: typeof o.modelId === "string" ? o.modelId.slice(0, 80) : "",
      colour: typeof o.colour === "string" ? o.colour.slice(0, 80) : "",
      gate: typeof o.gate === "string" ? o.gate.slice(0, 32) : null,
    };
  }
  return out;
}

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/**
 * Upload panel 1 and index it under its (model, colour) key. Returns the
 * stored entry, or null when it could not be stored (no R2, no ids, a
 * failure) — the caller simply answers without `lookAnchor`.
 */
export async function storeLookAnchor(args: {
  tenantId: string | null | undefined;
  matrixId: string | null | undefined;
  modelId: string;
  colour: string;
  runTag: string;
  b64: string;
  /** Read at write time, in case the gate already answered. */
  currentGate: () => string | null;
}): Promise<(StoredLookAnchor & { key: string }) | null> {
  const tenantId = String(args.tenantId || "");
  const matrixId = String(args.matrixId || "");
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(matrixId) || !isValidLookModelId(args.modelId)) return null;
  if (!isR2StorageConfigured()) return null;
  const pool = getPool();
  if (!pool) return null;
  try {
    const safeRun = args.runTag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "run";
    const { url, path } = await withDeadline(
      uploadBytesToStorage({
        path: `${lookAnchorPrefix(tenantId, matrixId)}${safeRun}-${Date.now()}.png`,
        bytes: Buffer.from(args.b64, "base64"),
        contentType: "image/png",
      }),
      20_000,
    );
    const key = lookAnchorKey(args.modelId, args.colour);
    const entry: StoredLookAnchor = {
      url,
      runTag: args.runTag,
      at: new Date().toISOString(),
      modelId: args.modelId,
      colour: normalizeLookColour(args.colour),
      gate: args.currentGate(),
    };
    const previous = await pool.query(
      `SELECT look_anchors -> $2::text ->> 'url' AS url FROM studio_matrix_state WHERE matrix_id = $1::uuid`,
      [matrixId, key],
    );
    /* A product with no saved Studio state yet still gets its row (it exists:
       the matrices check), with nothing but the anchor in it. */
    const written = await pool.query(
      `INSERT INTO studio_matrix_state (matrix_id, tenant_id, look_anchors, updated_at)
       SELECT $1::uuid, $2::uuid, jsonb_build_object($3::text, $4::jsonb), now()
        WHERE EXISTS (SELECT 1 FROM matrices WHERE id = $1::uuid)
       ON CONFLICT (matrix_id) DO UPDATE
         SET look_anchors = COALESCE(studio_matrix_state.look_anchors, '{}'::jsonb) || EXCLUDED.look_anchors`,
      [matrixId, tenantId, key, JSON.stringify(entry)],
    );
    if (!written.rowCount) {
      void deleteStorageObjects([path]).catch(() => undefined);
      return null;
    }
    /* One stored look per (model, colour): the one it replaced is garbage. */
    const oldPath = tryGetStoragePathFromUrl(String(previous.rows[0]?.url || ""));
    if (oldPath && oldPath !== path && oldPath.startsWith(lookAnchorPrefix(tenantId, matrixId))) {
      void deleteStorageObjects([oldPath]).catch(() => undefined);
    }
    /* The gate may have answered while the row was being written. */
    const gateNow = args.currentGate();
    if (gateNow && gateNow !== entry.gate) await markLookAnchorGate(matrixId, args.runTag, gateNow);
    return { ...entry, gate: gateNow ?? entry.gate, key };
  } catch (e) {
    console.warn("[studio-look-anchors] not stored:", (e as Error)?.message || e);
    return null;
  }
}

/** Record the panel-1 gate on the stored look this run produced, if any. */
export async function markLookAnchorGate(matrixId: string | null | undefined, runTag: string, gate: string): Promise<void> {
  const id = String(matrixId || "");
  if (!UUID_RE.test(id) || !runTag) return;
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE studio_matrix_state s
          SET look_anchors = (
            SELECT jsonb_object_agg(e.k, CASE WHEN e.v->>'runTag' = $2 THEN e.v || jsonb_build_object('gate', $3::text) ELSE e.v END)
              FROM jsonb_each(s.look_anchors) AS e(k, v)
          )
        WHERE s.matrix_id = $1::uuid
          AND EXISTS (SELECT 1 FROM jsonb_each(s.look_anchors) AS e(k, v) WHERE e.v->>'runTag' = $2)`,
      [id, runTag, gate],
    );
  } catch (e) {
    console.warn("[studio-look-anchors] gate not recorded:", (e as Error)?.message || e);
  }
}
