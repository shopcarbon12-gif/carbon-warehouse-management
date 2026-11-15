/**
 * CarbonWMS Creative — Looks' sample frames through the OpenAI Batch API (owner, 2026-11-15: "whatever
 * I click to generate, it's sent to the batch and we're done" — half price, and the tap never waits).
 *
 * Job `preset_samples` { keys: string[] | "missing" }:
 *   1st run  → spend gate, one batch with 2 frames per Look, then waits;
 *   later    → checks the batch every 5 min; when done, saves the frames onto each Look.
 */
import type { Pool } from "pg";
import type { JobHandler } from "./jobs";
import { enqueue, releaseReservation } from "./jobs";
import { getBrand, PlainError, recordSpend, spendGate } from "./config";
import { collectImageBatch, submitImageBatch } from "./engines";
import { IMAGE_COST } from "./routing";
import { putFile } from "./storage";

const SCENES = ["a model in dark denim and a black hoodie walking toward camera", "a close-up of folded jeans and a jacket on a surface"];
/** Batch price is half of the normal medium-quality picture. */
export const SAMPLE_BATCH_COST_PER_LOOK = SCENES.length * IMAGE_COST.medium * 0.5;

/** Queue a sample-frame batch. `keys` = these Looks, or "missing" = every Look without frames yet. */
export async function queueLookSamples(pool: Pool, tenantId: string, keys: string[] | "missing", by: string | null): Promise<string> {
  return enqueue(pool, tenantId, "preset_samples", { keys }, { requestedBy: by, progress: "Queued for the OpenAI batch (half price)" });
}

/** Looks with a sample-frame batch still out (the page shows "In the batch…"). */
export async function looksInBatch(pool: Pool, tenantId: string): Promise<string[]> {
  const r = await pool.query<{ keys: string[] | null }>(
    `SELECT COALESCE(payload->'looks', payload->'keys') AS keys FROM creative_jobs WHERE tenant_id = $1::uuid AND kind = 'preset_samples' AND status IN ('queued','waiting','running')`,
    [tenantId],
  );
  return r.rows.flatMap((x) => (Array.isArray(x.keys) ? x.keys : ["*"]));
}

export const presetSamples: JobHandler = async (pool, job, setProgress, savePayload) => {
  const p = job.payload as { keys?: string[] | "missing"; looks?: string[]; batchId?: string };
  const brand = await getBrand(pool, job.tenant_id);
  if (!p.batchId) {
    const looks = brand.presets.filter((x) => (p.keys === "missing" ? !x.samples?.length : (p.keys ?? []).includes(x.key)));
    if (!looks.length) return { status: "done", progress: "Every Look already has sample frames" };
    const cost = looks.length * SAMPLE_BATCH_COST_PER_LOOK;
    await spendGate(pool, job.tenant_id, "openai", cost);
    const lines = looks.flatMap((x) =>
      SCENES.map((scene, i) => ({
        customId: `${x.key}|${i}`,
        prompt: `Fashion campaign sample frame for the "${x.name}" look: ${x.look}. ${scene}. Photoreal, no text, no logos.`,
      })),
    );
    await setProgress(`Sending ${lines.length} pictures to the OpenAI batch…`);
    const { batchId } = await submitImageBatch(lines, { purpose: "creative_look_samples", tenant: job.tenant_id });
    await recordSpend(pool, job.tenant_id, { provider: "openai", what: "Look sample frames in the batch (reserved)", cost, estimated: true });
    const reservedAt = new Date().toISOString();
    return { status: "waiting", afterSeconds: 300, payload: { ...p, looks: looks.map((x) => x.key), batchId, reserved: cost, reservedAt }, progress: `In the OpenAI batch: ${looks.map((x) => x.name).join(", ")}` };
  }
  const out = await collectImageBatch(p.batchId);
  if (out.state === "pending") return { status: "waiting", afterSeconds: 300, progress: `OpenAI batch ${out.status}` };
  if (out.state === "failed") {
    await releaseReservation(pool, job.tenant_id, p as Record<string, unknown>);
    await savePayload({ ...(p as Record<string, unknown>), reserved: 0 });
  }
  if (out.state === "failed") throw new PlainError(`The OpenAI batch did not finish (${out.error}). Tap Sample frames again.`);
  const byLook = new Map<string, string[]>();
  let made = 0;
  for (const r of out.results.sort((a, b) => a.customId.localeCompare(b.customId))) {
    if (!r.bytes) continue;
    const [key] = r.customId.split("|");
    const path = await putFile(`creative/brand/${job.tenant_id}/preset-${key}-${Date.now()}-${made}.png`, r.bytes, "image/png");
    byLook.set(key, [...(byLook.get(key) ?? []), path]);
    made++;
  }
  await releaseReservation(pool, job.tenant_id, p as Record<string, unknown>);
  await recordSpend(pool, job.tenant_id, { provider: "openai", what: `Look sample frames, batch (${made} pictures)`, cost: made * IMAGE_COST.medium * 0.5 });
  // Re-read: the owner may have edited a Look while the batch ran; only the frames change.
  const fresh = await getBrand(pool, job.tenant_id);
  const presets = fresh.presets.map((x) => (byLook.has(x.key) ? { ...x, samples: byLook.get(x.key)! } : x));
  await pool.query(`UPDATE creative_brand SET presets = $2::jsonb, updated_at = now() WHERE tenant_id = $1::uuid`, [job.tenant_id, JSON.stringify(presets)]);
  const failed = out.results.length - made;
  return { status: "done", result: { made, failed }, progress: `${made} sample frames saved${failed ? ` · ${failed} blocked by the safety filter` : ""}` };
};
