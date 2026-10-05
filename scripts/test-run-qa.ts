/**
 * Run-level QA, against a real render of a real product.
 *
 * The judge that this replaced kept failing correct pictures: a chain seen from
 * behind, a head "visible" in a frame with no head, footwear "not visible"
 * reported as a bare foot. Those were prompt faults, so only a prompt run
 * against real photographs can show whether they are gone. This generates one
 * panel from the live product's own reference photos and prints what the two
 * judges say about it.
 *
 *   npx tsx scripts/test-run-qa.ts [matrixId]
 *
 * Costs one image generation and two vision calls. Nothing is written back.
 */
import OpenAI, { toFile } from "openai";
import { Pool } from "pg";
import { runRunQa, type ItemRefView } from "@/lib/server/run-qa";
import type { RunPanelImage } from "@/lib/server/run-qa-store";

const MATRIX = process.argv[2] || "";

function env(name: string): string {
  const v = (process.env[name] || "").trim();
  // Coolify stores some values wrapped in quotes; the container sees them bare.
  return v.replace(/^['"]|['"]$/g, "");
}

async function toDataUrl(url: string): Promise<string | null> {
  try {
    const { fetchRemoteImageBytes, normalizeRemoteImageUrl } = await import("@/lib/remoteImage");
    const { downloadStorageObject, tryGetStoragePathFromUrl } = await import("@/lib/storageProvider");
    const path = tryGetStoragePathFromUrl(url);
    if (path) {
      const { body, contentType } = await downloadStorageObject(path);
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      return `data:${contentType || "image/jpeg"};base64,${bytes.toString("base64")}`;
    }
    const { bytes, contentType } = await fetchRemoteImageBytes(normalizeRemoteImageUrl(url), {
      timeoutMs: 30_000,
      maxBytes: 20 * 1024 * 1024,
    });
    return `data:${contentType || "image/jpeg"};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch (e) {
    console.warn("  ! could not load", url.slice(0, 80), (e as Error).message);
    return null;
  }
}

async function main() {
  const dbUrl = env("DATABASE_URL");
  if (!dbUrl) throw new Error("DATABASE_URL is not set — source .env.coolify.local first.");
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");

  const pool = new Pool({ connectionString: dbUrl, ssl: false, max: 2 });
  const where = MATRIX ? "WHERE matrix_id = $1" : "WHERE item_type ILIKE '%EVENING%'";
  const { rows } = await pool.query(
    `SELECT matrix_id, item_type, instruction, item_spec, item_refs
       FROM studio_matrix_state ${where} ORDER BY updated_at DESC LIMIT 1`,
    MATRIX ? [MATRIX] : [],
  );
  if (!rows.length) throw new Error("No studio_matrix_state row found.");
  const state = rows[0];
  const refs: { url: string; view: ItemRefView }[] = Array.isArray(state.item_refs)
    ? state.item_refs
        .map((r: unknown) => {
          const o = r as { url?: string; view?: string };
          const view = o?.view === "front" || o?.view === "back" ? (o.view as ItemRefView) : "general";
          return { url: String(o?.url ?? ""), view };
        })
        .filter((r: { url: string }) => r.url)
    : [];
  // RUN_QA_MODEL=<name> picks a stored model (e.g. the one the real run used).
  const modelName = (process.env.RUN_QA_MODEL || "").trim();
  const models = await pool.query(
    `SELECT name, ref_image_urls FROM models WHERE ref_image_urls IS NOT NULL
        AND jsonb_array_length(ref_image_urls) > 0 ${modelName ? "AND name = $1" : ""} ORDER BY name LIMIT 1`,
    modelName ? [modelName] : [],
  );
  await pool.end();

  console.log(`Product : ${state.item_type}  (matrix ${state.matrix_id})`);
  console.log(`Operator: ${state.instruction || "(no instruction)"}`);
  console.log(`Spec    : ${String(state.item_spec || "").split("\n").length} lines`);
  console.log(`Refs    : ${refs.length} item, model "${models.rows[0]?.name || "none"}"`);

  const itemData = (await Promise.all(refs.slice(0, 8).map((r) => toDataUrl(r.url)))).map((d, i) => ({
    data: d,
    view: refs[i].view,
  }));
  const itemRefs = itemData.filter((d) => d.data).map((d) => d.data!) as string[];
  const itemRefViews = itemData.filter((d) => d.data).map((d) => d.view);
  const modelUrls: string[] = (models.rows[0]?.ref_image_urls as string[]) || [];
  const modelRefs = ((await Promise.all(modelUrls.slice(0, 4).map(toDataUrl))).filter(Boolean) as string[]) || [];
  if (!itemRefs.length) throw new Error("No item reference image could be loaded.");
  console.log(`Loaded  : ${itemRefs.length} item + ${modelRefs.length} model reference image(s)\n`);

  const openai = new OpenAI({ apiKey });

  console.log("Generating one 2-up panel from the real reference photos…");
  const files = await Promise.all(
    [...itemRefs.slice(0, 6), ...modelRefs.slice(0, 2)].map(async (d, i) => {
      const [meta, b64] = d.split(",");
      const type = /data:([^;]+)/.exec(meta)?.[1] || "image/jpeg";
      return toFile(Buffer.from(b64, "base64"), `ref-${i}.jpg`, { type });
    }),
  );
  const prompt = [
    `A single 1536x1024 image split into TWO equal frames side by side, of the SAME male model wearing the SAME outfit.`,
    `The product is: ${state.item_type}. ${state.instruction || ""}`.trim(),
    `Reproduce the product exactly as the reference photographs show it.`,
    `LEFT frame: the model standing, facing the camera, full body from head to shoes.`,
    `RIGHT frame: the same model from BEHIND, full body from head to shoes.`,
    `Styling in BOTH frames, identical: a plain black crew-neck short-sleeve t-shirt, plain white low-top sneakers, no accessories at all.`,
    `Plain light grey studio background, even lighting.`,
  ].join("\n");

  const fs = await import("node:fs");
  const scratch = process.env.SCRATCH || "/tmp";
  const render = async (tag: string, text: string): Promise<string> => {
    const cached = `${scratch}/run-qa-panel-${tag}.png`;
    if (fs.existsSync(cached)) {
      console.log(`Panel ${tag}: reusing ${cached}`);
      return fs.readFileSync(cached).toString("base64");
    }
    const t0 = Date.now();
    const result = (await openai.images.edit({
      model: (process.env.OPENAI_IMAGE_MODEL || "gpt-image-2").trim(),
      image: files,
      prompt: text,
      size: "1536x1024",
      quality: "high",
      ...({ moderation: "low" } as Record<string, unknown>),
    } as Parameters<typeof openai.images.edit>[0])) as { data?: { b64_json?: string }[] };
    const out = result.data?.[0]?.b64_json || "";
    if (!out) throw new Error("No image came back.");
    fs.writeFileSync(cached, Buffer.from(out, "base64"));
    console.log(`Panel ${tag} rendered in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${cached}`);
    return out;
  };

  const b64 = await render("a", prompt);
  const panels: RunPanelImage[] = [{ panel: 1, poseA: 1, poseB: 2, b64, logId: null }];

  /* The consistency judge is the whole point of the rewrite, and a run where
     everything already agrees cannot show that it works. This renders a second
     panel styled deliberately differently — black high-top boots and a white
     t-shirt instead of white sneakers and a black tee — so the judge has a real
     disagreement to find, and so we can check it flags ONLY the odd frames. */
  if (process.env.RUN_QA_INCONSISTENT === "1") {
    const odd = prompt
      .replace(
        "a plain black crew-neck short-sleeve t-shirt, plain white low-top sneakers, no accessories at all",
        "a plain WHITE crew-neck short-sleeve t-shirt, BLACK high-top leather boots, and a silver wristwatch on the left wrist",
      )
      .replace("LEFT frame: the model standing, facing the camera", "LEFT frame: the model standing at a slight angle, facing the camera");
    panels.push({ panel: 2, poseA: 3, poseB: 4, b64: await render("b", odd), logId: null });
  }
  console.log("");

  console.log("Running both judges…");
  const t1 = Date.now();
  const verdict = await runRunQa({
    openai,
    panels,
    itemRefs,
    itemRefViews,
    modelRefs,
    itemSpec: String(state.item_spec || ""),
    itemType: String(state.item_type || ""),
    timeoutMs: 120_000,
  });
  console.log(`Judged in ${((Date.now() - t1) / 1000).toFixed(0)}s\n`);

  console.log(`unavailable : ${verdict.unavailable}`);
  console.log(`findings    : ${verdict.findings.length}`);
  for (const f of verdict.findings) console.log(`  [P${f.panel}${f.frame[0].toUpperCase()}] ${f.text}`);
  console.log(`notes       : ${verdict.notes.length}`);
  for (const n of verdict.notes) console.log(`  - ${n}`);

  /* The shapes that made the old judge useless. Any of these coming back means
     the prompt has not actually been fixed. */
  const banned = /\b(not visible|cannot tell|head is visible|full standing|barefoot|out of frame|should not be visible|coverage|nudity|cropped)\b/i;
  const bad = [...verdict.findings.map((f) => f.text), ...verdict.notes].filter((t) => banned.test(t));
  console.log(`\nold-judge false-positive shapes: ${bad.length}`);
  for (const b of bad) console.log(`  !! ${b}`);
  process.exitCode = bad.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
