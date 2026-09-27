import { getPool } from "@/lib/db";

/**
 * Best-effort record of one Studio panel generation.
 *
 * Written AFTER the image has been served, and every failure is swallowed: a
 * logging problem must never cost a render the operator already paid OpenAI
 * for. That is also why nothing here is awaited on the response path.
 *
 * It exists so the Studio's open questions stop being arguments. Rendering
 * poses separately costs about 50% more — is it worth it? Which model drifts?
 * How often does the prompt actually overflow? None of that was answerable,
 * because nothing recorded a generation at all.
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
  qaDecisive?: boolean | null;
  qaPass?: boolean | null;
  qaWarnings?: number | null;
  backUnknown?: boolean;
  errorCode?: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown) => (typeof v === "string" && UUID_RE.test(v.trim()) ? v.trim() : null);
const int = (v: unknown) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
const str = (v: unknown, max = 200) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

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
           outcome, duration_ms, qa_decisive, qa_pass, qa_warnings, back_unknown, error_code
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
           $7, $8, $9,
           $10, $11, $12,
           $13, $14, $15, $16,
           $17, $18, $19, $20, $21, $22, $23
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
        ]
      );
    } catch (e) {
      console.warn("[studio-generation-log] not recorded:", (e as Error)?.message || e);
    }
  })();
}
