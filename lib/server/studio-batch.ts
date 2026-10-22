/**
 * Studio night batch (owner, 2026-10-17).
 *
 * "Add to batch" in a product's Studio queues exactly what Generate would send
 * for each panel. Once a night (1 AM Eastern, scripts/worker.ts) every queued
 * product run goes to OpenAI's Batch API in one batch — half the price of a
 * live render, results within 24 hours and usually by morning. Each finished
 * panel is saved in the owner's Dropbox ("Carbon › Campaign › 2026 OPENAI
 * GENERATOR WMS" › product (UPC) › date model colour › panel-N.png — no R2,
 * owner 2026-10-17) and the product's Studio shows the run for review, the
 * same way a live run lands. Nothing is published by itself.
 *
 * The request for each panel is built by the generate route itself in
 * "prepare only" mode (x-generate-prepare), so a batch panel gets the same
 * references, prompt, locks and settings a live panel gets. Reference photos
 * are uploaded to OpenAI once per batch and referenced by file id.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import OpenAI, { toFile } from "openai";
import type { Pool } from "pg";
import { downloadStorageObject } from "@/lib/storageProvider";
import {
  dropboxDownload,
  dropboxSafe,
  dropboxUpload,
  isDropboxConfigured,
  studioBatchDropboxRoot,
} from "@/lib/server/dropbox-upload";
import { recordStudioGeneration } from "@/lib/server/studio-generation-log";
import { notifyStudioBatchResults } from "@/lib/server/web-push";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_TAG_RE = /^[a-z0-9]{4,24}$/;
/** OpenAI states, plus our own "processed" once the results are stored. */
export const OPEN_BATCH_STATUSES = ["submitted", "validating", "in_progress", "finalizing"] as const;
/** What a check (poll) looks at: the open batches, one being cancelled, and one finished but not stored yet. */
const POLL_BATCH_STATUSES = [...OPEN_BATCH_STATUSES, "cancelling", "completed"] as const;
/** An item still on its way: nothing back from OpenAI yet. "Stop generating" works on these. */
export const LIVE_ITEM_STATUSES = ["queued", "preparing", "submitted"] as const;
const TERMINAL_OPENAI = new Set(["completed", "failed", "expired", "cancelled"]);
const MAX_PANELS = 8;
/** One panel body is ~10–25 KB (prompt + spec + look sheet); refuse anything absurd. */
const MAX_ITEM_BYTES = 600_000;

export type PanelBody = Record<string, unknown> & {
  prompt?: unknown;
  panelQa?: {
    panelNumber?: number;
    poseA?: number;
    poseB?: number;
    modelName?: string;
    modelGender?: string;
    itemType?: string;
    accessoryKind?: string;
  };
};
export type BatchPanel = { panel: number; body: PanelBody };
export type PreparedImage = { name: string; type: string; b64: string };
export type PreparedPanel = {
  model: string;
  prompt: string;
  size: string;
  quality: string;
  moderation: string;
  images: PreparedImage[];
};
export type PrepareResult = { prepared: PreparedPanel; meta: Record<string, unknown> } | { error: string };
/** Who queued the run — its panels are prepared with exactly that person's access. */
export type BatchActor = { addedBy: string | null; addedEmail: string | null; addedRole: string | null; locationId: string | null };
export type PrepareFn = (body: PanelBody, actor: BatchActor) => Promise<PrepareResult>;

export type SessionLike = { sub: string; email: string; tid: string; lid: string; role: string };

export type EnqueueInput = {
  matrixId: string;
  runTag: string;
  modelName: string | null;
  modelGender: string | null;
  itemColour: string | null;
  itemType: string | null;
  panels: BatchPanel[];
};

export type PanelResult = {
  path?: string;
  usage?: Record<string, unknown> | null;
  error?: string;
  code?: string;
  meta?: Record<string, unknown>;
};

export function customId(itemId: string, panel: number): string {
  return `${itemId}:${panel}`;
}

export function parseCustomId(v: unknown): { itemId: string; panel: number } | null {
  const m = /^([0-9a-f-]{36}):([1-8])$/i.exec(String(v ?? ""));
  if (!m || !UUID_RE.test(m[1])) return null;
  return { itemId: m[1].toLowerCase(), panel: Number(m[2]) };
}

const str = (v: unknown, max = 120): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** What "Add to batch" sends, checked before anything is stored. */
export function validateEnqueue(raw: unknown): { ok: true; value: EnqueueInput } | { ok: false; error: string } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const matrixId = String(o.matrixId ?? "");
  if (!UUID_RE.test(matrixId)) return { ok: false, error: "Invalid product id." };
  const runTag = String(o.runTag ?? "");
  if (!RUN_TAG_RE.test(runTag)) return { ok: false, error: "Invalid run tag." };
  if (!Array.isArray(o.panels) || o.panels.length === 0) return { ok: false, error: "Pick at least one panel." };
  if (o.panels.length > MAX_PANELS) return { ok: false, error: `At most ${MAX_PANELS} panels per run.` };
  const seen = new Set<number>();
  const panels: BatchPanel[] = [];
  for (const p of o.panels as unknown[]) {
    const e = (p ?? {}) as Record<string, unknown>;
    const panel = Number(e.panel);
    if (!Number.isInteger(panel) || panel < 1 || panel > MAX_PANELS || seen.has(panel)) {
      return { ok: false, error: "Each panel must be a different number from 1 to 8." };
    }
    seen.add(panel);
    const body = e.body as PanelBody | undefined;
    if (!body || typeof body !== "object" || typeof body.prompt !== "string" || !body.prompt.trim()) {
      return { ok: false, error: `Panel ${panel} has no prompt.` };
    }
    if (!Array.isArray(body.modelRefs) || !Array.isArray(body.itemRefs) || !(body.itemRefs as unknown[]).length) {
      return { ok: false, error: `Panel ${panel} has no model or item photos.` };
    }
    if ((body as { anchor?: unknown }).anchor) {
      return { ok: false, error: "A batch run renders each panel on its own — turn off \"Panel 1 sets the look\" or send without it." };
    }
    if (String(body.matrixId ?? "") !== matrixId) return { ok: false, error: `Panel ${panel} is for a different product.` };
    panels.push({ panel, body });
  }
  if (Buffer.byteLength(JSON.stringify(panels)) > MAX_ITEM_BYTES) return { ok: false, error: "This run is too large to queue." };
  panels.sort((a, b) => a.panel - b.panel);
  return {
    ok: true,
    value: {
      matrixId,
      runTag,
      modelName: str(o.modelName),
      modelGender: str(o.modelGender, 20),
      itemColour: str(o.itemColour),
      itemType: str(o.itemType),
      panels,
    },
  };
}

export async function enqueueBatchItem(pool: Pool, session: SessionLike, v: EnqueueInput) {
  const r = await pool.query<{ id: string; added_at: string }>(
    `INSERT INTO studio_batch_items
       (tenant_id, location_id, matrix_id, added_by, added_email, added_role, run_tag,
        model_name, model_gender, item_colour, item_type, panels)
     SELECT $1::uuid, $2::uuid, m.id, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
       FROM matrices m WHERE m.id = $12::uuid
     RETURNING id::text, added_at`,
    [
      session.tid,
      UUID_RE.test(session.lid) ? session.lid : null,
      UUID_RE.test(session.sub) ? session.sub : null,
      session.email,
      session.role,
      v.runTag,
      v.modelName,
      v.modelGender,
      v.itemColour,
      v.itemType,
      JSON.stringify(v.panels),
      v.matrixId,
    ],
  );
  if (!r.rows[0]) throw new Error("Product not found.");
  return r.rows[0];
}

export type BatchItemSummary = {
  id: string;
  matrixId: string;
  productName: string | null;
  status: string;
  addedAt: string;
  addedEmail: string | null;
  runTag: string;
  modelName: string | null;
  modelGender: string | null;
  itemColour: string | null;
  itemType: string | null;
  panels: number[];
  ready: number[];
  failed: { panel: number; error: string }[];
  batchStatus: string | null;
  submittedAt: string | null;
  error: string | null;
  /** The Dropbox folder holding this run's pictures, once any is saved. */
  folder: string | null;
};

export async function listBatchItems(
  pool: Pool,
  tenantId: string,
  opts: { matrixId?: string; statuses?: string[]; limit?: number } = {},
): Promise<BatchItemSummary[]> {
  const where = ["i.tenant_id = $1::uuid"];
  const params: unknown[] = [tenantId];
  if (opts.matrixId) {
    params.push(opts.matrixId);
    where.push(`i.matrix_id = $${params.length}::uuid`);
  }
  if (opts.statuses?.length) {
    params.push(opts.statuses);
    where.push(`i.status = ANY($${params.length}::text[])`);
  }
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  const r = await pool.query<{
    id: string;
    matrix_id: string;
    product_name: string | null;
    status: string;
    added_at: string;
    added_email: string | null;
    run_tag: string;
    model_name: string | null;
    model_gender: string | null;
    item_colour: string | null;
    item_type: string | null;
    panel_numbers: number[] | null;
    results: Record<string, PanelResult>;
    batch_status: string | null;
    submitted_at: string | null;
    error: string | null;
  }>(
    `SELECT i.id::text, i.matrix_id::text, m.description AS product_name, i.status, i.added_at, i.added_email,
            i.run_tag, i.model_name, i.model_gender, i.item_colour, i.item_type,
            ARRAY(SELECT (e->>'panel')::int FROM jsonb_array_elements(i.panels) e ORDER BY 1) AS panel_numbers,
            i.results, b.status AS batch_status, b.submitted_at, i.error
       FROM studio_batch_items i
       JOIN matrices m ON m.id = i.matrix_id
       LEFT JOIN studio_batches b ON b.id = i.batch_id
      WHERE ${where.join(" AND ")}
      ORDER BY i.added_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((x) => {
    const results = x.results ?? {};
    const ready: number[] = [];
    const failed: { panel: number; error: string }[] = [];
    for (const [k, v] of Object.entries(results)) {
      if (v?.path) ready.push(Number(k));
      else if (v?.error) failed.push({ panel: Number(k), error: v.error });
    }
    return {
      id: x.id,
      matrixId: x.matrix_id,
      productName: x.product_name,
      status: x.status,
      addedAt: x.added_at,
      addedEmail: x.added_email,
      runTag: x.run_tag,
      modelName: x.model_name,
      modelGender: x.model_gender,
      itemColour: x.item_colour,
      itemType: x.item_type,
      panels: x.panel_numbers ?? [],
      ready: ready.sort((a, b) => a - b),
      folder: folderOf(Object.values(results).find((v) => v?.path)?.path),
      failed: failed.sort((a, b) => a.panel - b.panel),
      batchStatus: x.batch_status,
      submittedAt: x.submitted_at,
      error: x.error,
    };
  });
}

export async function cancelBatchItem(pool: Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE studio_batch_items SET status = 'cancelled', updated_at = now()
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = 'queued'`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/* ── Stop generating (owner, 2026-10-22) ───────────────────────────────────
   "■ Stop generating" next to "Add to tonight's batch", and Bulk Studio's
   per-item stop and "Cancel pending batch". Works at every stage:
     queued     → cancelled; nothing was sent, nothing is charged.
     preparing  → cancelled; the send in progress re-checks before it builds
                  the file and leaves it out (and cancels the OpenAI batch it
                  just created if every run in it was stopped).
     submitted  → cancelled; when no other live run shares that OpenAI batch,
                  OpenAI is told to cancel it. OpenAI cannot drop one request
                  out of a batch, so otherwise it finishes the batch for the
                  other products and this run's pictures are thrown away when
                  it comes back. Requests OpenAI already finished are billed.
   A cancelled run is never brought back: every later write is guarded. */

/** Only the part of the OpenAI client a stop needs (a test passes a fake). */
export type BatchCanceller = { batches: { cancel: (id: string) => PromiseLike<{ status?: string }> } };

export type StopOutcome =
  | "removed" //          was queued — nothing sent, nothing charged
  | "left_out" //         was being sent — left out of the batch before it went
  | "openai_cancelled" // the whole OpenAI batch was cancelled
  | "discarded" //        OpenAI finishes the batch for others; this run's pictures are thrown away
  | "not_running" //      already back / failed / cancelled — nothing to stop
  | "not_found";

export type StopItemResult = {
  id: string;
  matrixId: string | null;
  productName: string | null;
  modelName: string | null;
  itemColour: string | null;
  was: string | null;
  outcome: StopOutcome;
  message: string;
  openaiBatchId?: string | null;
  openaiError?: string | null;
};

export type StopBatchResult = {
  /** studio_batches.id */
  id: string;
  openaiBatchId: string;
  cancelled: boolean;
  status: string | null;
  error: string | null;
};

const stoppedNote = (who: string | null) => `Stopped${who ? ` by ${who}` : ""} — nothing more is made for this run.`;

/**
 * OpenAI is told to cancel a sent batch only when no run in it is still live,
 * so one product's stop never kills another product's renders.
 * Returns null when nothing was asked of OpenAI (not sent yet, already done).
 */
async function cancelOpenAiBatchIfUnused(
  pool: Pool,
  openai: BatchCanceller | null,
  batchId: string,
  opts: { force?: boolean } = {},
): Promise<(StopBatchResult & { otherLive: number }) | null> {
  const b = await pool.query<{ openai_batch_id: string | null; status: string; live: number }>(
    `SELECT b.openai_batch_id, b.status,
            (SELECT count(*) FROM studio_batch_items i
              WHERE i.batch_id = b.id AND i.status IN ('preparing', 'submitted'))::int AS live
       FROM studio_batches b WHERE b.id = $1::uuid`,
    [batchId],
  );
  const row = b.rows[0];
  if (!row?.openai_batch_id || !(OPEN_BATCH_STATUSES as readonly string[]).includes(row.status)) return null;
  const base = { id: batchId, openaiBatchId: row.openai_batch_id, otherLive: row.live };
  if (row.live > 0 && !opts.force) return { ...base, cancelled: false, status: row.status, error: null };
  if (!openai) return { ...base, cancelled: false, status: row.status, error: "OPENAI_API_KEY is not set on the server." };
  try {
    const ob = await openai.batches.cancel(row.openai_batch_id);
    const status = String(ob?.status || "cancelling");
    await pool.query(
      `UPDATE studio_batches SET status = $2, error = 'Stopped by hand — OpenAI was asked to cancel it.'
        WHERE id = $1::uuid AND status = ANY($3::text[])`,
      [batchId, status, [...OPEN_BATCH_STATUSES]],
    );
    return { ...base, cancelled: true, status, error: null };
  } catch (e) {
    /* Usually: it finished a moment ago. The next check stores it and throws
       the stopped runs' pictures away. */
    return { ...base, cancelled: false, status: row.status, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Pure: the sentence the Studio shows for one stopped run. */
export function stopMessage(was: string | null, outcome: StopOutcome, otherLive = 0, openaiError: string | null = null): string {
  switch (outcome) {
    case "removed":
      return "Removed from tonight's batch — nothing was sent, nothing is charged.";
    case "left_out":
      return "Stopped while the batch was being sent — it is left out of it, nothing is charged for it.";
    case "openai_cancelled":
      return "Stopped — OpenAI was told to cancel the batch. Panels it had already finished are still billed (half price); their pictures are thrown away.";
    case "discarded":
      return openaiError
        ? `Stopped here, but OpenAI could not be told to cancel (${openaiError}). Its pictures are thrown away when the batch comes back; panels OpenAI finishes are still billed.`
        : `Stopped here — its pictures are thrown away when the batch comes back. OpenAI cannot take one run out of a batch, so it keeps rendering ${
            otherLive ? `the other ${otherLive} run${otherLive === 1 ? "" : "s"} in it` : "the batch"
          } and this run's panels are still billed (half price).`;
    case "not_running":
      return was === "cancelled" ? "Already stopped." : `Nothing to stop — this run is ${was ?? "done"}.`;
    default:
      return "This run was not found.";
  }
}

type StopRow = {
  id: string;
  was: string;
  batch_id: string | null;
  matrix_id: string;
  product_name: string | null;
  model_name: string | null;
  item_colour: string | null;
};

/** Mark live runs cancelled and return what each one was. One statement, so nothing slips between read and write. */
async function markStopped(pool: Pool, tenantId: string, ids: string[] | null, who: string | null): Promise<StopRow[]> {
  const r = await pool.query<StopRow>(
    `WITH prev AS (
       SELECT i.id, i.status FROM studio_batch_items i
        WHERE i.tenant_id = $1::uuid AND i.status = ANY($2::text[])
          AND ($3::uuid[] IS NULL OR i.id = ANY($3::uuid[]))
        FOR UPDATE
     )
     UPDATE studio_batch_items i
        SET status = 'cancelled', error = $4, updated_at = now()
       FROM prev, matrices m
      WHERE i.id = prev.id AND m.id = i.matrix_id
     RETURNING i.id::text, prev.status AS was, i.batch_id::text, i.matrix_id::text,
               m.description AS product_name, i.model_name, i.item_colour`,
    [tenantId, [...LIVE_ITEM_STATUSES], ids, stoppedNote(who)],
  );
  return r.rows;
}

/** "■ Stop generating" for one product run, whatever stage it is at. */
export async function stopBatchItem(
  pool: Pool,
  openai: BatchCanceller | null,
  tenantId: string,
  id: string,
  who: string | null = null,
): Promise<StopItemResult> {
  const [row] = await markStopped(pool, tenantId, [id], who);
  if (!row) {
    const cur = await pool.query<{ status: string; matrix_id: string; product_name: string | null; model_name: string | null; item_colour: string | null }>(
      `SELECT i.status, i.matrix_id::text, m.description AS product_name, i.model_name, i.item_colour
         FROM studio_batch_items i JOIN matrices m ON m.id = i.matrix_id
        WHERE i.id = $1::uuid AND i.tenant_id = $2::uuid`,
      [id, tenantId],
    );
    const c = cur.rows[0];
    const outcome: StopOutcome = c ? "not_running" : "not_found";
    return {
      id,
      matrixId: c?.matrix_id ?? null,
      productName: c?.product_name ?? null,
      modelName: c?.model_name ?? null,
      itemColour: c?.item_colour ?? null,
      was: c?.status ?? null,
      outcome,
      message: stopMessage(c?.status ?? null, outcome),
    };
  }
  return describeStopped(row, row.batch_id ? await cancelOpenAiBatchIfUnused(pool, openai, row.batch_id) : null);
}

function describeStopped(row: StopRow, b: (StopBatchResult & { otherLive: number }) | null): StopItemResult {
  let outcome: StopOutcome;
  if (row.was === "queued") outcome = "removed";
  else if (b?.cancelled) outcome = "openai_cancelled";
  else if (b) outcome = "discarded";
  else if (row.was === "preparing") outcome = "left_out";
  else outcome = "discarded"; // submitted, batch already finished at OpenAI — billed, thrown away on store
  const finishedAlready = outcome === "discarded" && !b;
  return {
    id: row.id,
    matrixId: row.matrix_id,
    productName: row.product_name,
    modelName: row.model_name,
    itemColour: row.item_colour,
    was: row.was,
    outcome,
    message: finishedAlready
      ? "Stopped, but OpenAI had already finished this batch — it is billed; its pictures are thrown away instead of saved."
      : stopMessage(row.was, outcome, b?.otherLive ?? 0, b?.error ?? null),
    openaiBatchId: b?.openaiBatchId ?? null,
    openaiError: b?.error ?? null,
  };
}

/**
 * "Cancel pending batch": every queued run, every run being sent, and every
 * batch out with OpenAI (OPEN_BATCH_STATUSES) for this tenant.
 */
export async function stopAllBatches(
  pool: Pool,
  openai: BatchCanceller | null,
  tenantId: string,
  who: string | null = null,
): Promise<{ items: StopItemResult[]; batches: StopBatchResult[] }> {
  const rows = await markStopped(pool, tenantId, null, who);
  const open = await pool.query<{ id: string }>(
    `SELECT id::text FROM studio_batches
      WHERE tenant_id = $1::uuid AND openai_batch_id IS NOT NULL AND status = ANY($2::text[])`,
    [tenantId, [...OPEN_BATCH_STATUSES]],
  );
  const byBatch = new Map<string, StopBatchResult & { otherLive: number }>();
  for (const b of open.rows) {
    /* force: every run of the tenant was just stopped, so a run still "live"
       here is one the send is writing this second — it is cancelled too. */
    const r = await cancelOpenAiBatchIfUnused(pool, openai, b.id, { force: true });
    if (r) byBatch.set(b.id, r);
  }
  if (byBatch.size) {
    await pool.query(
      `UPDATE studio_batch_items SET status = 'cancelled', error = $2, updated_at = now()
        WHERE batch_id = ANY($1::uuid[]) AND status = ANY($3::text[])`,
      [[...byBatch.keys()], stoppedNote(who), [...LIVE_ITEM_STATUSES]],
    );
  }
  return {
    items: rows.map((row) => describeStopped(row, row.batch_id ? (byBatch.get(row.batch_id) ?? null) : null)),
    batches: [...byBatch.values()].map((b) => ({ id: b.id, openaiBatchId: b.openaiBatchId, cancelled: b.cancelled, status: b.status, error: b.error })),
  };
}

/** What "Cancel pending batch" would stop — for its confirm line. */
export async function pendingBatchSummary(
  pool: Pool,
  tenantId: string,
): Promise<{ runs: number; products: number; queued: number; sending: number; withOpenAi: number; openBatches: number }> {
  const r = await pool.query<{ runs: number; products: number; queued: number; sending: number; with_openai: number; open_batches: number }>(
    `SELECT count(*)::int AS runs,
            count(DISTINCT matrix_id)::int AS products,
            count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'preparing')::int AS sending,
            count(*) FILTER (WHERE status = 'submitted')::int AS with_openai,
            (SELECT count(*) FROM studio_batches b
              WHERE b.tenant_id = $1::uuid AND b.openai_batch_id IS NOT NULL AND b.status = ANY($3::text[]))::int AS open_batches
       FROM studio_batch_items WHERE tenant_id = $1::uuid AND status = ANY($2::text[])`,
    [tenantId, [...LIVE_ITEM_STATUSES], [...OPEN_BATCH_STATUSES]],
  );
  const x = r.rows[0];
  return {
    runs: x?.runs ?? 0,
    products: x?.products ?? 0,
    queued: x?.queued ?? 0,
    sending: x?.sending ?? 0,
    withOpenAi: x?.with_openai ?? 0,
    openBatches: x?.open_batches ?? 0,
  };
}

export async function markBatchItemLoaded(pool: Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE studio_batch_items SET status = 'loaded', updated_at = now()
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = 'ready'`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Bulk Studio › Upload: the run's pictures went to Shopify — it leaves the Upload tab. */
export async function markBatchItemPublished(pool: Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE studio_batch_items SET status = 'published', updated_at = now()
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND status IN ('ready', 'loaded')`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Bulk Studio › Upload: "Remove from list" — handled elsewhere, never published from here. */
export async function markBatchItemDismissed(pool: Pool, tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE studio_batch_items SET status = 'dismissed', updated_at = now()
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND status IN ('ready', 'loaded')`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The finished panels of one item, as the base64 PNGs the Studio turns into crops. */
/* Bulk Studio › Upload loads dozens of runs: the four panels come in parallel,
   as JPEG (≈8× smaller than the stored PNGs), and recent runs are kept in
   memory so a reload is instant. A finished run's pictures never change. */
const jpegCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof loadBatchItemImagesRaw>> }>();
const JPEG_CACHE_MAX = 60;

export async function loadBatchItemImages(pool: Pool, tenantId: string, id: string, opts: { jpeg?: boolean } = {}) {
  if (!opts.jpeg) return loadBatchItemImagesRaw(pool, tenantId, id, false);
  const key = `${tenantId}:${id}`;
  const hit = jpegCache.get(key);
  if (hit) return hit.value;
  const value = await loadBatchItemImagesRaw(pool, tenantId, id, true);
  if (value && value.panels.every((p) => p.imageBase64 || p.error)) {
    jpegCache.set(key, { at: Date.now(), value });
    if (jpegCache.size > JPEG_CACHE_MAX) {
      const oldest = [...jpegCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) jpegCache.delete(oldest[0]);
    }
  }
  return value;
}

async function loadBatchItemImagesRaw(pool: Pool, tenantId: string, id: string, jpeg: boolean) {
  const r = await pool.query<{ results: Record<string, PanelResult>; panels: BatchPanel[]; run_tag: string; model_gender: string | null }>(
    `SELECT results, panels, run_tag, model_gender FROM studio_batch_items WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, tenantId],
  );
  const row = r.rows[0];
  if (!row) return null;
  type PanelOut = { panel: number; poseA: number | null; poseB: number | null; imageBase64?: string; mime?: string; error?: string };
  const out: PanelOut[] = await Promise.all(
    (row.panels ?? []).map(async (p): Promise<PanelOut> => {
      const res = row.results?.[String(p.panel)];
      const poseA = Number(p.body?.panelQa?.poseA) || null;
      const poseB = Number(p.body?.panelQa?.poseB) || null;
      if (!res?.path) return { panel: p.panel, poseA, poseB, error: res?.error ?? "Not rendered yet." };
      try {
        let bytes = res.path.startsWith("/") ? await dropboxDownload(res.path) : Buffer.from((await downloadStorageObject(res.path)).body);
        if (jpeg) bytes = await sharp(bytes).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
        return { panel: p.panel, poseA, poseB, imageBase64: bytes.toString("base64"), mime: jpeg ? "image/jpeg" : "image/png" };
      } catch (e) {
        return { panel: p.panel, poseA, poseB, error: `The stored image could not be read (${e instanceof Error ? e.message : "storage error"}).` };
      }
    }),
  );
  return {
    runTag: row.run_tag,
    gender: row.model_gender,
    accessory: Boolean(row.panels?.[0]?.body?.panelQa?.accessoryKind),
    panels: out,
  };
}

const sha = (b64: string) => createHash("sha256").update(b64).digest("hex");

async function deleteOpenAiFiles(openai: OpenAI, ids: (string | null | undefined)[]) {
  for (const id of Array.from(new Set(ids.filter(Boolean) as string[]))) {
    try {
      await openai.files.delete(id);
    } catch {
      /* already gone, or never existed — nothing to clean */
    }
  }
}

type ClaimedItem = {
  id: string;
  matrix_id: string;
  location_id: string | null;
  added_by: string | null;
  added_email: string | null;
  added_role: string | null;
  run_tag: string;
  panels: BatchPanel[];
};

/**
 * A send that never finished (the web app restarted mid-way): its runs go back
 * to the queue and the reference photos it had uploaded are deleted. Only ever
 * called while holding the batch lock, so a 'preparing' batch here is an orphan.
 */
export async function recoverInterruptedSends(pool: Pool, openai: OpenAI, tenantId: string): Promise<number> {
  const r = await pool.query<{ id: string; uploaded_file_ids: string[]; input_file_id: string | null }>(
    `UPDATE studio_batches SET status = 'failed', error = 'Interrupted before it reached OpenAI (the app restarted) — its runs went back to the queue.'
      WHERE tenant_id = $1::uuid AND status = 'preparing'
      RETURNING id::text, uploaded_file_ids, input_file_id`,
    [tenantId],
  );
  if (!r.rows.length) return 0;
  await pool.query(
    `UPDATE studio_batch_items SET status = 'queued', batch_id = NULL, updated_at = now()
      WHERE batch_id = ANY($1::uuid[]) AND status = 'preparing'`,
    [r.rows.map((b) => b.id)],
  );
  await deleteOpenAiFiles(openai, r.rows.flatMap((b) => [...(b.uploaded_file_ids ?? []), b.input_file_id]));
  return r.rows.length;
}

/**
 * Send every queued product run of this tenant to OpenAI in one batch.
 * Returns how many panels went out. Items that could not be prepared stay
 * failed with the reason; if the batch itself cannot be created, the items go
 * back to the queue for the next night.
 */
export async function submitQueuedBatch(
  pool: Pool,
  opts: { tenantId: string; trigger: "nightly" | "manual"; prepare: PrepareFn; openai: OpenAI; log?: (m: string) => void },
): Promise<{ batchId: string | null; items: number; requests: number; failedPanels: number }> {
  const log = opts.log ?? ((m: string) => console.log(`[studio-batch] ${m}`));
  const claimed = await pool.query<ClaimedItem>(
    `UPDATE studio_batch_items SET status = 'preparing', updated_at = now()
      WHERE tenant_id = $1::uuid AND status = 'queued'
      RETURNING id::text, matrix_id::text, location_id::text, added_by::text, added_email, added_role, run_tag, panels`,
    [opts.tenantId],
  );
  const items = claimed.rows;
  if (!items.length) return { batchId: null, items: 0, requests: 0, failedPanels: 0 };
  const batchRow = await pool.query<{ id: string }>(
    `INSERT INTO studio_batches (tenant_id, trigger) VALUES ($1::uuid, $2) RETURNING id::text`,
    [opts.tenantId, opts.trigger],
  );
  const batchId = batchRow.rows[0].id;
  await pool.query(`UPDATE studio_batch_items SET batch_id = $1::uuid WHERE id = ANY($2::uuid[])`, [
    batchId,
    items.map((i) => i.id),
  ]);

  const uploaded = new Map<string, string>(); // sha → OpenAI file id
  let lines: { itemId: string; line: string }[] = [];
  const results = new Map<string, Record<string, PanelResult>>();
  let imageModel: string | null = null;
  let inputFileId: string | null = null;
  let failedPanels = 0;
  /* "Stop generating" may cancel a run while this send is building it. */
  const stillPreparing = async (ids: string[]): Promise<Set<string>> => {
    const r = await pool.query<{ id: string }>(
      `SELECT id::text FROM studio_batch_items WHERE id = ANY($1::uuid[]) AND status = 'preparing'`,
      [ids],
    );
    return new Set(r.rows.map((x) => x.id));
  };
  try {
    for (const item of items) {
      if (!(await stillPreparing([item.id])).has(item.id)) {
        log(`batch ${batchId}: run ${item.id} was stopped — left out`);
        continue;
      }
      const res: Record<string, PanelResult> = {};
      for (const p of item.panels) {
        const actor: BatchActor = {
          addedBy: item.added_by,
          addedEmail: item.added_email,
          addedRole: item.added_role,
          locationId: item.location_id,
        };
        const prep = await opts.prepare(p.body, actor).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
        if ("error" in prep) {
          res[String(p.panel)] = { error: `Could not be prepared: ${prep.error}` };
          failedPanels += 1;
          continue;
        }
        const ids: string[] = [];
        for (const img of prep.prepared.images) {
          const key = sha(img.b64);
          let id = uploaded.get(key);
          if (!id) {
            const f = await opts.openai.files.create({
              file: await toFile(Buffer.from(img.b64, "base64"), img.name || "ref.png", { type: img.type || "image/png" }),
              purpose: "vision",
            });
            id = f.id;
            uploaded.set(key, id);
            await pool.query(`UPDATE studio_batches SET uploaded_file_ids = array_append(uploaded_file_ids, $2) WHERE id = $1::uuid`, [
              batchId,
              id,
            ]);
          }
          ids.push(id);
        }
        imageModel ??= prep.prepared.model;
        lines.push({
          itemId: item.id,
          line: JSON.stringify({
            custom_id: customId(item.id, p.panel),
            method: "POST",
            url: "/v1/images/edits",
            body: {
              model: prep.prepared.model,
              prompt: prep.prepared.prompt,
              images: ids.map((file_id) => ({ file_id })),
              size: prep.prepared.size,
              quality: prep.prepared.quality,
              moderation: prep.prepared.moderation,
              n: 1,
            },
          }),
        });
        res[String(p.panel)] = { meta: { ...prep.meta, imageModel: prep.prepared.model } };
      }
      results.set(item.id, res);
    }
    /* Last look before anything is sent: a run stopped while the others were
       being built is left out of the file. */
    const live = await stillPreparing(items.map((i) => i.id));
    const stopped = items.filter((i) => !live.has(i.id)).length;
    lines = lines.filter((l) => live.has(l.itemId));
    if (!lines.length) {
      /* Nothing to send: every panel was refused while being built (no Back
         photo for a back pose, a photo that cannot be downloaded…), or every
         run was stopped. Retrying tomorrow would refuse them again, so each
         run fails with its reasons; a stopped run stays cancelled. */
      const allStopped = stopped === items.length;
      await pool.query(`UPDATE studio_batches SET status = $2, error = $3 WHERE id = $1::uuid`, [
        batchId,
        allStopped ? "cancelled" : "failed",
        allStopped ? "Every run was stopped before it was sent." : "No panel could be prepared.",
      ]);
      for (const item of items) {
        await pool.query(
          `UPDATE studio_batch_items SET status = 'failed', results = $2::jsonb, error = $3, updated_at = now()
            WHERE id = $1::uuid AND status = 'preparing'`,
          [item.id, JSON.stringify(results.get(item.id) ?? {}), "No panel of this run could be prepared."],
        );
      }
      await deleteOpenAiFiles(opts.openai, [...uploaded.values()]);
      log(`batch ${batchId}: nothing sent (${items.length} run(s), ${stopped} stopped)`);
      return { batchId: null, items: items.length, requests: 0, failedPanels };
    }
    const input = await opts.openai.files.create({
      file: await toFile(Buffer.from(lines.map((l) => l.line).join("\n") + "\n"), `studio-batch-${batchId}.jsonl`, {
        type: "application/jsonl",
      }),
      purpose: "batch",
    });
    inputFileId = input.id;
    const batch = await opts.openai.batches.create({
      input_file_id: input.id,
      endpoint: "/v1/images/edits",
      completion_window: "24h",
      metadata: { studio_batch_id: batchId },
    });
    await pool.query(
      `UPDATE studio_batches
          SET status = 'submitted', openai_batch_id = $2, input_file_id = $3, request_count = $4,
              image_model = $5, submitted_at = now()
        WHERE id = $1::uuid`,
      [batchId, batch.id, input.id, lines.length, imageModel],
    );
    for (const item of items) {
      const res = results.get(item.id) ?? {};
      const anySent = live.has(item.id) && Object.values(res).some((r) => r.meta);
      // `status = 'preparing'`: a run stopped this second stays cancelled.
      await pool.query(
        `UPDATE studio_batch_items SET status = $2, results = $3::jsonb, error = $4, updated_at = now()
          WHERE id = $1::uuid AND status = 'preparing'`,
        [item.id, anySent ? "submitted" : "failed", JSON.stringify(res), anySent ? null : "No panel of this run could be prepared."],
      );
    }
    /* Every run was stopped between the last look and now: OpenAI cancels the
       batch it was just given (nothing in it is wanted any more). */
    const stillSent = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM studio_batch_items WHERE batch_id = $1::uuid AND status = 'submitted'`,
      [batchId],
    );
    if (!stillSent.rows[0]?.n) {
      const c = await cancelOpenAiBatchIfUnused(pool, opts.openai, batchId);
      log(`batch ${batchId}: every run was stopped while sending — OpenAI cancel ${c?.cancelled ? "asked" : `not possible (${c?.error ?? "?"})`}`);
    }
    log(`batch ${batchId} → OpenAI ${batch.id}: ${lines.length} panels from ${live.size} product run(s)`);
    return { batchId, items: items.length, requests: lines.length, failedPanels };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`batch ${batchId} could not be sent: ${msg}`);
    await pool.query(`UPDATE studio_batches SET status = 'failed', error = $2 WHERE id = $1::uuid`, [batchId, msg]);
    await pool.query(
      `UPDATE studio_batch_items SET status = 'queued', batch_id = NULL, error = $2, updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'preparing'`,
      [items.map((i) => i.id), `The last send to OpenAI failed, so it goes again with the next one: ${msg}`],
    );
    await deleteOpenAiFiles(opts.openai, [...uploaded.values(), inputFileId]);
    throw e;
  }
}

/** Read an OpenAI output/error file line by line without holding it whole in memory. */
async function forEachJsonLine(openai: OpenAI, fileId: string, fn: (row: Record<string, unknown>) => Promise<void>) {
  const res = await openai.files.content(fileId);
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body) return;
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) await fn(JSON.parse(line) as Record<string, unknown>);
    }
    if (done) break;
  }
  const rest = (buf + dec.decode()).trim();
  if (rest) await fn(JSON.parse(rest) as Record<string, unknown>);
}

type ItemRow = {
  id: string;
  status: string;
  tenant_id: string;
  location_id: string | null;
  matrix_id: string;
  run_tag: string;
  panels: BatchPanel[];
  results: Record<string, PanelResult>;
  model_name: string | null;
  model_gender: string | null;
  item_type: string | null;
  item_colour: string | null;
  product_name: string | null;
  product_upc: string | null;
  /** The Eastern date the run was queued, YYYY-MM-DD. */
  et_date: string;
  /** 1 for the first run of this product + model + colour that day, 2 for the next… */
  seq: number;
};

/**
 * Where a run's pictures go in Dropbox (owner, 2026-10-17):
 *   <root>/<Product> (<UPC>)/<YYYY-MM-DD> <Model> <Colour>[ (2)]/panel-N.png
 * The second run of the same product, model and colour on one day gets " (2)",
 * so nothing already saved is overwritten.
 */
export function batchRunFolder(v: {
  root: string;
  productName: string | null;
  upc: string | null;
  etDate: string;
  modelName: string | null;
  colour: string | null;
  seq: number;
}): string {
  const product = dropboxSafe(`${v.productName?.trim() || "Product"}${v.upc?.trim() ? ` (${v.upc.trim()})` : ""}`);
  const run = dropboxSafe(
    [v.etDate, v.modelName?.trim(), v.colour?.trim()].filter(Boolean).join(" ") + (v.seq > 1 ? ` (${v.seq})` : ""),
  );
  return `${v.root.replace(/\/+$/, "")}/${product}/${run}`;
}

/** The folder part of a stored Dropbox path, null for anything else. */
function folderOf(path: string | undefined): string | null {
  if (!path || !path.startsWith("/")) return null;
  return path.slice(0, path.lastIndexOf("/")) || null;
}

function errorText(body: unknown, fallback: string): { message: string; code: string } {
  const e = (body as { error?: { message?: string; code?: string; type?: string } } | null)?.error;
  return { message: String(e?.message || fallback), code: String(e?.code || e?.type || "") };
}

/** Where a finished panel's PNG goes — the owner's Dropbox in production (a test passes its own). */
export type StoreImageFn = (path: string, bytes: Buffer) => Promise<{ path: string }>;
const storeInDropbox: StoreImageFn = async (path, bytes) => {
  if (!isDropboxConfigured()) throw new Error("Dropbox is not connected on the server (DROPBOX_* settings missing).");
  return { path: await dropboxUpload(path, bytes) };
};

/** Store one finished OpenAI batch: every panel into Dropbox + the generation log. */
async function processFinishedBatch(
  pool: Pool,
  openai: OpenAI,
  batch: {
    id: string;
    tenant_id: string;
    output_file_id: string | null;
    error_file_id: string | null;
    openai_status: string;
    errors: string | null;
  },
  log: (m: string) => void,
  store: StoreImageFn,
) {
  const rows = await pool.query<ItemRow>(
    `SELECT i.id::text, i.status, i.tenant_id::text, i.location_id::text, i.matrix_id::text, i.run_tag, i.panels, i.results,
            i.model_name, i.model_gender, i.item_type, i.item_colour,
            m.description AS product_name, m.upc AS product_upc,
            to_char(i.added_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS et_date,
            1 + (SELECT count(*) FROM studio_batch_items o
                  WHERE o.matrix_id = i.matrix_id AND o.status NOT IN ('cancelled', 'failed')
                    AND COALESCE(o.model_name, '') = COALESCE(i.model_name, '')
                    AND COALESCE(o.item_colour, '') = COALESCE(i.item_colour, '')
                    AND (o.added_at AT TIME ZONE 'America/New_York')::date = (i.added_at AT TIME ZONE 'America/New_York')::date
                    AND (o.added_at, o.id) < (i.added_at, i.id))::int AS seq
       FROM studio_batch_items i
       JOIN matrices m ON m.id = i.matrix_id
      WHERE i.batch_id = $1::uuid`,
    [batch.id],
  );
  const root = studioBatchDropboxRoot();
  const items = new Map(rows.rows.map((r) => [r.id, { ...r, results: { ...(r.results ?? {}) } }]));
  /* Stopped runs ("Stop generating"): their pictures are thrown away — never
     saved, never shown — but a render OpenAI finished is still billed, so it
     is logged (outcome "aborted") for the cost sums. */
  const stopped = new Set(rows.rows.filter((r) => r.status === "cancelled").map((r) => r.id));
  /* Written only once the whole batch is saved: a save that fails half-way is
     retried from the start, and must not log the same render twice. */
  const logs: Parameters<typeof recordStudioGeneration>[0][] = [];
  const record = async (itemId: string, panel: number, outcome: "ok" | "failed" | "blocked" | "aborted", extra: Partial<PanelResult>) => {
    const item = items.get(itemId);
    if (!item) return;
    const prev = item.results[String(panel)] ?? {};
    if (!stopped.has(itemId)) item.results[String(panel)] = { ...prev, ...extra };
    const body = item.panels.find((p) => p.panel === panel)?.body;
    const meta = (prev.meta ?? {}) as Record<string, unknown>;
    logs.push({
      tenantId: item.tenant_id,
      locationId: item.location_id,
      matrixId: item.matrix_id,
      itemType: body?.panelQa?.itemType ?? item.item_type,
      modelName: body?.panelQa?.modelName ?? item.model_name,
      modelGender: body?.panelQa?.modelGender ?? item.model_gender,
      panelNumber: panel,
      poseA: Number(body?.panelQa?.poseA) || null,
      poseB: Number(body?.panelQa?.poseB) || null,
      imageModel: String(meta.imageModel ?? "") || null,
      imageQuality: String(meta.imageQuality ?? "") || null,
      imageSize: String(meta.imageSize ?? "") || null,
      modelRefCount: Number(meta.modelRefCount) || null,
      itemRefCount: Number(meta.itemRefCount) || null,
      promptBytes: Number(meta.promptBytes) || null,
      promptTrimmed: meta.promptTrimmed === true,
      backState: (meta.backState as "present" | "absent" | "unknown" | "photo" | undefined) ?? null,
      specConfirmed: meta.specConfirmed === true,
      specBytes: Number(meta.specBytes) || null,
      variationSeed: Number(meta.variationSeed) || null,
      outcome,
      /* `batch: true` — billed at the Batch API's half price, so a cost sum over
         studio_generations.usage must halve these rows. */
      usage: extra.usage ? { ...extra.usage, batch: true } : null,
      errorCode: extra.code ?? null,
      errorMessage: extra.error ?? null,
      runTag: item.run_tag,
    });
  };

  const handle = async (row: Record<string, unknown>) => {
    const id = parseCustomId(row.custom_id);
    if (!id) return;
    const item = items.get(id.itemId);
    if (!item) return;
    const response = row.response as { status_code?: number; body?: Record<string, unknown> } | null;
    const b64 = (response?.body?.data as { b64_json?: string }[] | undefined)?.[0]?.b64_json;
    if (stopped.has(id.itemId)) {
      if (response?.status_code === 200 && b64) {
        const usage = (response.body?.usage as Record<string, unknown> | undefined) ?? null;
        await record(id.itemId, id.panel, "aborted", { usage, error: "Stopped by hand — rendered by OpenAI (billed), picture thrown away." });
      }
      return;
    }
    if (response?.status_code === 200 && b64) {
      const folder = batchRunFolder({
        root,
        productName: item.product_name,
        upc: item.product_upc,
        etDate: item.et_date,
        modelName: item.model_name,
        colour: item.item_colour,
        seq: item.seq,
      });
      const stored = await store(`${folder}/panel-${id.panel}.png`, Buffer.from(b64, "base64"));
      const usage = (response.body?.usage as Record<string, unknown> | undefined) ?? null;
      await record(id.itemId, id.panel, "ok", { path: stored.path, usage, error: undefined });
      return;
    }
    const { message, code } = errorText(response?.body ?? row, `OpenAI returned status ${response?.status_code ?? "?"}`);
    const blocked = code === "moderation_blocked" || /safety|moderation/i.test(message);
    await record(id.itemId, id.panel, blocked ? "blocked" : "failed", { error: message, code: code || undefined });
  };

  if (batch.output_file_id) await forEachJsonLine(openai, batch.output_file_id, handle);
  if (batch.error_file_id) await forEachJsonLine(openai, batch.error_file_id, handle);

  for (const item of items.values()) {
    if (stopped.has(item.id)) continue;
    for (const p of item.panels) {
      const r = item.results[String(p.panel)];
      if (r && !r.path && !r.error) {
        const why =
          batch.openai_status === "expired"
            ? "The batch ran out of time (24 h) before this panel was rendered."
            : batch.openai_status === "cancelled"
              ? "The batch was cancelled before this panel was rendered."
              : batch.openai_status === "failed"
                ? `OpenAI refused the whole batch${batch.errors ? `: ${batch.errors}` : "."}`
                : "OpenAI returned no result for this panel.";
        await record(item.id, p.panel, "failed", { error: why });
      }
    }
    const anyOk = Object.values(item.results).some((r) => r?.path);
    // `status <> 'cancelled'`: a run stopped while this was saving stays stopped.
    await pool.query(
      `UPDATE studio_batch_items SET status = $2, results = $3::jsonb, error = $4, updated_at = now()
        WHERE id = $1::uuid AND status <> 'cancelled'`,
      [item.id, anyOk ? "ready" : "failed", JSON.stringify(item.results), anyOk ? null : "No panel of this run was rendered."],
    );
  }
  for (const entry of logs) void recordStudioGeneration(entry);
  log(
    `batch ${batch.id} stored: ${[...items.values()].filter((i) => Object.values(i.results).some((r) => r?.path)).length}/${items.size - stopped.size} product run(s) have images` +
      (stopped.size ? ` (${stopped.size} stopped run(s) thrown away)` : ""),
  );
}

/** Check every open batch with OpenAI; store the ones that finished. */
export async function pollStudioBatches(
  pool: Pool,
  opts: { openai: OpenAI; tenantId?: string; log?: (m: string) => void; store?: StoreImageFn },
): Promise<{ checked: number; processed: number }> {
  const log = opts.log ?? ((m: string) => console.log(`[studio-batch] ${m}`));
  const params: unknown[] = [[...POLL_BATCH_STATUSES]];
  let where = "status = ANY($1::text[]) AND openai_batch_id IS NOT NULL";
  if (opts.tenantId) {
    params.push(opts.tenantId);
    where += ` AND tenant_id = $2::uuid`;
  }
  const open = await pool.query<{
    id: string;
    tenant_id: string;
    openai_batch_id: string;
    input_file_id: string | null;
    uploaded_file_ids: string[];
  }>(`SELECT id::text, tenant_id::text, openai_batch_id, input_file_id, uploaded_file_ids FROM studio_batches WHERE ${where}`, params);
  let processed = 0;
  for (const b of open.rows) {
    /* One batch OpenAI cannot answer for right now must not hold up the rest. */
    try {
      processed += await pollOne(pool, opts.openai, b, log, opts.store ?? storeInDropbox);
    } catch (e) {
      log(`batch ${b.id} check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { checked: open.rows.length, processed };
}

/** One batch: refresh its status; once OpenAI is done with it, store it and clean up. */
async function pollOne(
  pool: Pool,
  openai: OpenAI,
  b: { id: string; tenant_id: string; openai_batch_id: string; input_file_id: string | null; uploaded_file_ids: string[] },
  log: (m: string) => void,
  store: StoreImageFn,
): Promise<number> {
  const ob = await openai.batches.retrieve(b.openai_batch_id);
  const errors = ob.errors?.data?.map((e) => e.message).filter(Boolean).join("; ") || null;
  await pool.query(
    `UPDATE studio_batches
        SET status = $2, output_file_id = $3, error_file_id = $4, last_polled_at = now(),
            completed_at = COALESCE(completed_at, CASE WHEN $5 THEN now() END),
            error = COALESCE($6, error)
      WHERE id = $1::uuid`,
    [
      b.id,
      ob.status,
      ob.output_file_id ?? null,
      ob.error_file_id ?? null,
      TERMINAL_OPENAI.has(ob.status),
      errors,
    ],
  );
  if (!TERMINAL_OPENAI.has(ob.status)) return 0;
  try {
    await processFinishedBatch(
      pool,
      openai,
      {
        id: b.id,
        tenant_id: b.tenant_id,
        output_file_id: ob.output_file_id ?? null,
        error_file_id: ob.error_file_id ?? null,
        openai_status: ob.status,
        errors,
      },
      log,
      store,
    );
  } catch (e) {
    /* The renders are safe in OpenAI's output file until this succeeds (it is
       deleted only afterwards), so the next check simply tries again. */
    const msg = e instanceof Error ? e.message : String(e);
    await pool.query(
      `UPDATE studio_batch_items SET error = $2, updated_at = now() WHERE batch_id = $1::uuid AND status = 'submitted'`,
      [b.id, `Finished at OpenAI, but the pictures could not be saved yet — trying again every 5 minutes: ${msg}`],
    );
    throw e;
  }
  await pool.query(`UPDATE studio_batches SET status = 'processed', processed_at = now() WHERE id = $1::uuid`, [b.id]);
  await deleteOpenAiFiles(openai, [...(b.uploaded_file_ids ?? []), b.input_file_id, ob.output_file_id, ob.error_file_id]);
  /* Phone/computer alert per run (owner 2026-10-19). Once per batch: this line
     is reached only the first time the batch is stored as processed. */
  await notifyStudioBatchResults(pool, b.id, b.tenant_id);
  return 1;
}

/** pg advisory lock id for the Studio night batch (send + check share it). */
const BATCH_LOCK = 70_171_022;

/**
 * Take the batch lock on a dedicated connection, or null while another send /
 * check holds it. Call the returned function once the work is done.
 */
export async function tryBatchLock(pool: Pool): Promise<(() => Promise<void>) | null> {
  const client = await pool.connect();
  try {
    const ok = Boolean((await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [BATCH_LOCK])).rows[0]?.ok);
    if (!ok) {
      client.release();
      return null;
    }
  } catch (e) {
    client.release();
    throw e;
  }
  return async () => {
    await client.query(`SELECT pg_advisory_unlock($1)`, [BATCH_LOCK]).catch(() => {});
    client.release();
  };
}

/** Pure: is the nightly send due? 1:00–5:59 AM Eastern, once per Eastern date. */
export function nightlySendDue(nowEtHour: number, sentToday: boolean, queued: number): boolean {
  return nowEtHour >= 1 && nowEtHour < 6 && !sentToday && queued > 0;
}

export type BatchOverview = {
  queuedRuns: number;
  queuedPanels: number;
  open: { id: string; status: string; requestCount: number; submittedAt: string | null; trigger: string }[];
  lastProcessed: { id: string; requestCount: number; processedAt: string | null } | null;
};

/** What the Studio's batch box shows: what waits for tonight, what OpenAI is working on. */
export async function batchOverview(pool: Pool, tenantId: string): Promise<BatchOverview> {
  const [q, open, last] = await Promise.all([
    pool.query<{ runs: string; panels: string }>(
      `SELECT count(*)::text AS runs, COALESCE(sum(jsonb_array_length(panels)), 0)::text AS panels
         FROM studio_batch_items WHERE tenant_id = $1::uuid AND status = 'queued'`,
      [tenantId],
    ),
    pool.query<{ id: string; status: string; request_count: number; submitted_at: string | null; trigger: string }>(
      `SELECT id::text, status, request_count, submitted_at, trigger FROM studio_batches
        WHERE tenant_id = $1::uuid AND status IN ('preparing', 'submitted', 'validating', 'in_progress', 'finalizing', 'completed')
        ORDER BY created_at DESC LIMIT 10`,
      [tenantId],
    ),
    pool.query<{ id: string; request_count: number; processed_at: string | null }>(
      `SELECT id::text, request_count, processed_at FROM studio_batches
        WHERE tenant_id = $1::uuid AND status = 'processed' ORDER BY processed_at DESC NULLS LAST LIMIT 1`,
      [tenantId],
    ),
  ]);
  return {
    queuedRuns: Number(q.rows[0]?.runs ?? 0),
    queuedPanels: Number(q.rows[0]?.panels ?? 0),
    open: open.rows.map((b) => ({
      id: b.id,
      status: b.status,
      requestCount: b.request_count,
      submittedAt: b.submitted_at,
      trigger: b.trigger,
    })),
    lastProcessed: last.rows[0]
      ? { id: last.rows[0].id, requestCount: last.rows[0].request_count, processedAt: last.rows[0].processed_at }
      : null,
  };
}
