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
  outcome: "ok" | "failed" | "blocked";
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
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown) => (typeof v === "string" && UUID_RE.test(v.trim()) ? v.trim() : null);
const int = (v: unknown) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
const str = (v: unknown, max = 200) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const strList = (v: unknown, max = 12) =>
  Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, max) : [];

export function recordStudioGeneration(entry: StudioGenerationLog): void {
  // Fire and forget — never block the response, never throw into it.
  void (async () => {
    try {
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO studio_generations (
           tenant_id, location_id, matrix_id, item_type, model_name, model_gender,
           panel_number, pose_a, pose_b,
           image_model, image_quality, image_size,
           model_ref_count, item_ref_count, prompt_bytes, prompt_trimmed,
           outcome, duration_ms, qa_decisive, qa_pass, qa_warnings, back_unknown, error_code,
           qa_reasons, qa_notes, qa_dropped, back_state, spec_confirmed, spec_bytes, error_message
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
           $7, $8, $9,
           $10, $11, $12,
           $13, $14, $15, $16,
           $17, $18, $19, $20, $21, $22, $23,
           $24::jsonb, $25::jsonb, $26, $27, $28, $29, $30
         )`,
        [
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
        ]
      );
    } catch (e) {
      console.warn("[studio-generation-log] not recorded:", (e as Error)?.message || e);
    }
  })();
}
