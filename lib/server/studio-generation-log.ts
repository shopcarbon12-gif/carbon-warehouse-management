import { getPool } from "@/lib/db";

/**
 * Best-effort record of one Studio panel generation.
 *
 * Written AFTER the response is decided, and every failure is swallowed: a
 * logging problem must never cost a render the operator already paid OpenAI
 * for. That is also why nothing here is awaited on the response path.
 *
 * It exists so the Studio's open questions stop being arguments. Which model
 * drifts? How often does the judge flag a panel, and for what? How often is a
 * back-facing panel asked for without a back photo? None of that was
 * answerable while only successes were recorded and the verdict was dropped.
 */
export type StudioGenerationLog = {
  /** Supply one when the QA verdict will be attached later (deferred judge). */
  id?: string | null;
  tenantId?: string | null;
  locationId?: string | null;
  matrixId?: string | null;
  itemType?: string | null;
  modelName?: string | null;
  modelGender?: string | null;
  panelNumber?: number | null;
  poseA?: number | null;
  poseB?: number | null;
  imageModel?: string | null;
  imageQuality?: string | null;
  imageSize?: string | null;
  modelRefCount?: number | null;
  itemRefCount?: number | null;
  promptBytes?: number | null;
  promptTrimmed?: boolean;
  outcome: "ok" | "failed" | "blocked" | "aborted";
  durationMs?: number | null;
  /** The judge reached a verdict (vs. unavailable / unparsable). */
  qaDecisive?: boolean | null;
  /** The judge's own pass flag, before our confirmation / confidence filters. */
  qaPass?: boolean | null;
  /** Failures that survived the filters — what the operator saw as red. */
  qaWarnings?: number | null;
  qaReasons?: string[] | null;
  qaNotes?: string[] | null;
  /** Reasons dropped as self-contradictions or confirmations. */
  qaDropped?: number | null;
  /** Kept for the old column; `backState` is the useful one. */
  backUnknown?: boolean;
  backState?: "present" | "absent" | "unknown" | "photo" | null;
  /** A human edited the spec text before this run (false = raw analyzer output). */
  specConfirmed?: boolean;
  specBytes?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  // Migration 0114 — what a render cost and how the run was tied together.
  /** OpenAI's `usage` for the image call (input text/image tokens, output tokens). */
  usage?: Record<string, unknown> | null;
  /** `source` = panel 1 of an anchored run; `follower` = waited for it; `stored` = attached a saved look. */
  anchorRole?: "source" | "follower" | "stored" | null;
  anchorWaitMs?: number | null;
  /** The panel-1 gate as this follower saw it: pass | flagged | forced | unavailable. */
  anchorGate?: string | null;
  variationSeed?: number | null;
  lookSheetBytes?: number | null;
  /** Reference photos left out to stay inside the 16-image limit, 1-based per section. */
  imagesDropped?: Record<string, number[]> | null;
  /** The Studio run this panel belongs to (x-generate-run). */
  runTag?: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown) => (typeof v === "string" && UUID_RE.test(v.trim()) ? v.trim() : null);
const int = (v: unknown) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
const str = (v: unknown, max = 200) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const strList = (v: unknown, max = 12) =>
  Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, max) : [];

/**
 * Write the row. Fire-and-forget by design — callers normally ignore the
 * returned promise — but it IS returned so the deferred-QA path can wait for
 * the INSERT before updating the same row.
 */
/** jsonb text for a small object, or null; never more than `max` characters. */
const jsonOrNull = (v: unknown, max = 4000): string | null => {
  if (!v || typeof v !== "object" || !Object.keys(v as object).length) return null;
  try {
    const s = JSON.stringify(v);
    return s.length <= max ? s : null;
  } catch {
    return null;
  }
};

const BASE_INSERT = `INSERT INTO studio_generations (
           id,
           tenant_id, location_id, matrix_id, item_type, model_name, model_gender,
           panel_number, pose_a, pose_b,
           image_model, image_quality, image_size,
           model_ref_count, item_ref_count, prompt_bytes, prompt_trimmed,
           outcome, duration_ms, qa_decisive, qa_pass, qa_warnings, back_unknown, error_code,
           qa_reasons, qa_notes, qa_dropped, back_state, spec_confirmed, spec_bytes, error_message
         ) VALUES (
           COALESCE($31::uuid, gen_random_uuid()),
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
           $7, $8, $9,
           $10, $11, $12,
           $13, $14, $15, $16,
           $17, $18, $19, $20, $21, $22, $23,
           $24::jsonb, $25::jsonb, $26, $27, $28, $29, $30
         )`;

const FULL_INSERT = `INSERT INTO studio_generations (
           id,
           tenant_id, location_id, matrix_id, item_type, model_name, model_gender,
           panel_number, pose_a, pose_b,
           image_model, image_quality, image_size,
           model_ref_count, item_ref_count, prompt_bytes, prompt_trimmed,
           outcome, duration_ms, qa_decisive, qa_pass, qa_warnings, back_unknown, error_code,
           qa_reasons, qa_notes, qa_dropped, back_state, spec_confirmed, spec_bytes, error_message,
           usage, anchor_role, anchor_wait_ms, anchor_gate, variation_seed, look_sheet_bytes, images_dropped, run_tag
         ) VALUES (
           COALESCE($31::uuid, gen_random_uuid()),
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
           $7, $8, $9,
           $10, $11, $12,
           $13, $14, $15, $16,
           $17, $18, $19, $20, $21, $22, $23,
           $24::jsonb, $25::jsonb, $26, $27, $28, $29, $30,
           $32::jsonb, $33, $34, $35, $36::bigint, $37, $38::jsonb, $39
         )`;

/* Set once the 0114 columns turned out to be missing (migration not applied
   yet), so later rows go straight to the old column set instead of failing
   first every time. */
let consistencyColumnsMissing = false;

export function recordStudioGeneration(entry: StudioGenerationLog): Promise<void> {
  return (async () => {
    try {
      const pool = getPool();
      if (!pool) return;
      const base = [
        uuid(entry.tenantId),
        uuid(entry.locationId),
        uuid(entry.matrixId),
        str(entry.itemType),
        str(entry.modelName),
        str(entry.modelGender, 32),
        int(entry.panelNumber),
        int(entry.poseA),
        int(entry.poseB),
        str(entry.imageModel, 64),
        str(entry.imageQuality, 32),
        str(entry.imageSize, 32),
        int(entry.modelRefCount),
        int(entry.itemRefCount),
        int(entry.promptBytes),
        entry.promptTrimmed === true,
        entry.outcome,
        int(entry.durationMs),
        entry.qaDecisive ?? null,
        entry.qaPass ?? null,
        int(entry.qaWarnings) ?? 0,
        entry.backUnknown === true,
        str(entry.errorCode, 120),
        JSON.stringify(strList(entry.qaReasons)),
        JSON.stringify(strList(entry.qaNotes)),
        int(entry.qaDropped) ?? 0,
        str(entry.backState, 16),
        entry.specConfirmed === true,
        int(entry.specBytes),
        str(entry.errorMessage, 600),
        uuid(entry.id),
      ];
      if (!consistencyColumnsMissing) {
        const seed = entry.variationSeed == null ? NaN : Number(entry.variationSeed);
        try {
          await pool.query(FULL_INSERT, [
            ...base,
            jsonOrNull(entry.usage),
            str(entry.anchorRole, 16),
            entry.anchorWaitMs == null ? null : int(entry.anchorWaitMs),
            str(entry.anchorGate, 32),
            Number.isSafeInteger(seed) ? String(seed) : null,
            entry.lookSheetBytes == null ? null : int(entry.lookSheetBytes),
            jsonOrNull(entry.imagesDropped),
            str(entry.runTag, 96),
          ]);
          return;
        } catch (e) {
          // 42703 = undefined_column: 0114 not applied yet. Keep the old row
          // rather than losing it.
          if ((e as { code?: string })?.code !== "42703") throw e;
          consistencyColumnsMissing = true;
          console.warn("[studio-generation-log] migration 0114 columns missing — logging the base columns only.");
        }
      }
      await pool.query(BASE_INSERT, base);
    } catch (e) {
      console.warn("[studio-generation-log] not recorded:", (e as Error)?.message || e);
    }
  })();
}

/**
 * Attach the judge's verdict to a row written earlier.
 *
 * The judge now runs AFTER the image is served, so the row exists before the
 * verdict does. Without this the log would say "QA never ran" for every panel
 * and the measurements the log exists for would be worthless.
 */
export function updateStudioGenerationQa(
  id: string,
  qa: Pick<StudioGenerationLog, "qaDecisive" | "qaPass" | "qaWarnings" | "qaReasons" | "qaNotes" | "qaDropped">,
): void {
  void (async () => {
    try {
      const pool = getPool();
      if (!pool || !uuid(id)) return;
      await pool.query(
        `UPDATE studio_generations
            SET qa_decisive = $2, qa_pass = $3, qa_warnings = $4,
                qa_reasons = $5::jsonb, qa_notes = $6::jsonb, qa_dropped = $7
          WHERE id = $1::uuid`,
        [
          id,
          qa.qaDecisive ?? null,
          qa.qaPass ?? null,
          int(qa.qaWarnings) ?? 0,
          JSON.stringify(strList(qa.qaReasons)),
          JSON.stringify(strList(qa.qaNotes)),
          int(qa.qaDropped) ?? 0,
        ]
      );
    } catch (e) {
      console.warn("[studio-generation-log] QA not attached:", (e as Error)?.message || e);
    }
  })();
}
