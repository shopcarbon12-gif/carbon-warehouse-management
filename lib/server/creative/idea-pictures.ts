/**
 * CarbonWMS Creative — one picture per idea card (owner, 2026-11-15: "the idea should come with a picture, so I
 * can see what it looks like — use the batch, a one-time picture"). Each idea is drawn ONCE through the OpenAI
 * Batch (half price, medium quality: it's a preview): the real product (its cut-out, or its Shopify photo) on one
 * of the cast models, in the idea's scene. A desktop alert says when they're ready.
 *
 * Job `idea_pictures` { ids }: 1st run → one batch; later runs → collect, save onto creative_ideas.picture_path.
 */
import type { Pool } from "pg";
import type { JobHandler } from "./jobs";
import { getBrand, presetOf, recordSpend, spendGate, UGC_LOOK } from "./config";
import { collectImageBatch, submitImageEditBatch, type ImageRef } from "./engines";
import { listModels, modelRefBytes } from "./casting";
import { twinRefs } from "./twin";
import { fetchBytes, putFile } from "./storage";
import { IMAGE_COST } from "./routing";
import { notifyCreative } from "./notify";
import { inStockCatalog } from "@/lib/server/email/catalog";

type Row = { id: string; idea: string; scene: string | null; prefill: { products?: string[]; kind?: string; preset?: string } };
const COST = (refs: number) => (IMAGE_COST.medium + refs * 0.01) * 0.5;

async function refsFor(pool: Pool, tenantId: string, row: Row, i: number, models: Awaited<ReturnType<typeof listModels>>, catalog: Awaited<ReturnType<typeof inStockCatalog>>) {
  const refs: ImageRef[] = [];
  const pid = row.prefill.products?.[0];
  let title = "";
  if (pid) {
    const tw = await twinRefs(pool, tenantId, [pid]).catch(() => []);
    if (tw.length) {
      title = tw[0].title;
      tw.slice(0, 2).forEach((g, k) => refs.push({ name: `garment-${k}.png`, bytes: g.bytes, mime: "image/png" }));
    } else {
      const p = catalog.find((x) => x.id === pid);
      title = p?.title ?? "";
      if (p?.image) {
        const b = await fetchBytes(p.image, 15 * 1024 * 1024).catch(() => null);
        if (b) refs.push({ name: "product.jpg", bytes: b.bytes, mime: "image/jpeg" });
      }
    }
  }
  // One cast model, matched to the product (dress / women → a woman), rotating so the cards don't all show one face.
  // The model the idea names wins; else match the product (whole words: "brand" is not "bra").
  const named = models.find((m) => m.active && new RegExp(`\\b${m.name.replace(/[.*+?^${}()|[\]\\]/g, "")}\\b`, "i").test(row.idea));
  const female = /\b(dress(es)?|skirts?|wom[ae]n|ladies|bras?|corsets?|rompers?|bodysuits?|bikinis?)\b/i.test(`${title} ${row.idea}`);
  const male = /\b(men|man|guy|his)\b/i.test(row.idea);
  const pool2 = models.filter((m) => m.active && (female ? m.gender === "female" : male ? m.gender === "male" : true));
  const m = named ?? (pool2.length ? pool2 : models)[i % Math.max(1, (pool2.length ? pool2 : models).length)];
  if (m) (await modelRefBytes(m, 2).catch(() => [] as Buffer[])).forEach((b, k) => refs.push({ name: `person-${k}.jpg`, bytes: b, mime: "image/jpeg" }));
  return { refs, title, model: m?.name ?? null };
}

export const ideaPictures: JobHandler = async (pool, job, setProgress) => {
  const p = job.payload as { ids?: string[]; batchId?: string };
  const tid = job.tenant_id;
  if (!p.batchId) {
    const rows = (
      await pool.query<Row>(
        `SELECT id::text, idea, scene, prefill FROM creative_ideas WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) AND picture_path IS NULL AND status = 'new'`,
        [tid, p.ids ?? []],
      )
    ).rows;
    if (!rows.length) return { status: "done", progress: "Every idea already has its picture" };
    const brand = await getBrand(pool, tid);
    const models = await listModels(pool, tid);
    const catalog = await inStockCatalog().catch(() => []);
    const lines: { customId: string; prompt: string; refs: ImageRef[]; quality: "medium" }[] = [];
    const costs: Record<string, number> = {};
    let est = 0;
    for (const [i, r] of rows.entries()) {
      const { refs, title } = await refsFor(pool, tid, r, i, models, catalog);
      const look = r.prefill.kind === "ugc" ? UGC_LOOK : `LOOK: ${presetOf(brand, r.prefill.preset ?? null).look}.`;
      lines.push({
        customId: r.id,
        quality: "medium",
        refs,
        prompt: [
          `Preview picture of an ad idea for CARBON (shopcarbon.com): ${r.idea}`,
          r.scene ? `SCENE: ${r.scene}` : "",
          look,
          refs.some((x) => x.name.startsWith("person")) ? "The person is the person in the person references — same face, hair and body." : "",
          refs.some((x) => !x.name.startsWith("person")) ? `CLOTHES: the product references are the real CARBON ${title || "product"} — show EXACTLY that piece (colour, wash, print, hardware), worn or held as the idea says.` : "",
          "One vertical photoreal frame, the moment that best shows the idea. No added text, captions, watermarks or other brands' logos.",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      costs[r.id] = COST(refs.length);
      est += costs[r.id];
    }
    // Ideas that weren't picked up (no longer new, already drawn) never stay "on the way".
    await pool.query(`UPDATE creative_ideas SET picture_status = NULL WHERE id = ANY($1::uuid[]) AND picture_path IS NULL AND NOT (id = ANY($2::uuid[]))`, [p.ids ?? [], rows.map((r) => r.id)]);
    await spendGate(pool, tid, "openai", est);
    await setProgress(`Sending ${lines.length} idea pictures to the OpenAI batch (half price)`);
    const { batchId } = await submitImageEditBatch(lines, { purpose: "creative_idea_pictures" });
    await recordSpend(pool, tid, { provider: "openai", what: "idea pictures in the batch (reserved)", cost: est, estimated: true });
    await pool.query(`UPDATE creative_ideas SET picture_status = 'batch' WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
    return { status: "waiting", afterSeconds: 120, payload: { ...p, ids: rows.map((r) => r.id), batchId, costs, reserved: est }, progress: `${lines.length} idea pictures in the OpenAI batch — a desktop alert comes when they're ready` };
  }
  const out = await collectImageBatch(p.batchId);
  if (out.state === "pending") return { status: "waiting", afterSeconds: 120, progress: `Idea pictures in the OpenAI batch — ${out.status}` };
  if (out.state === "failed") {
    await pool.query(`UPDATE creative_ideas SET picture_status = 'failed' WHERE id = ANY($1::uuid[]) AND picture_path IS NULL`, [p.ids ?? []]);
    return { status: "done", progress: `The batch did not finish (${out.error})` };
  }
  let made = 0;
  let cost = 0;
  const costs = (p as { costs?: Record<string, number> }).costs ?? {};
  try {
    for (const r of out.results) {
      if (!r.bytes) {
        await pool.query(`UPDATE creative_ideas SET picture_status = 'failed' WHERE id = $1::uuid AND tenant_id = $2::uuid`, [r.customId, tid]);
        continue;
      }
      const path = await putFile(`creative/ideas/${tid}/${r.customId}.png`, r.bytes, "image/png");
      await pool.query(`UPDATE creative_ideas SET picture_path = $2, picture_status = 'done' WHERE id = $1::uuid AND tenant_id = $3::uuid`, [r.customId, path, tid]);
      made++;
      cost += costs[r.customId] ?? COST(4);
    }
  } finally {
    // Anything the batch didn't return is marked failed, so no card says "on the way" forever.
    await pool.query(`UPDATE creative_ideas SET picture_status = 'failed' WHERE id = ANY($1::uuid[]) AND picture_status = 'batch'`, [p.ids ?? []]);
  }
  await recordSpend(pool, tid, { provider: "openai", what: `idea pictures, batch (${made})`, cost: cost - Number((p as { reserved?: number }).reserved ?? 0) });
  if (made)
    await notifyCreative(pool, tid, { title: "Creative · idea pictures ready", body: `${made} idea${made === 1 ? "" : "s"} now show what they'd look like. Tap to look.`, url: "/creative", tag: `creative-ideas-${p.batchId}` });
  return { status: "done", progress: `${made} idea pictures ready` };
};
