/* eslint-disable no-console */
/**
 * One-off backfill: record the model in each live product's photos and push the
 * hidden "Model is … and wears size …" metafields (lib/server/model-profiles).
 *
 *   npx tsx scripts/backfill-model-profiles.ts <assignments.json> [--write]
 *
 * assignments.json: [{ shopify_product_id, code, via }] — produced from Studio's
 * generation log (AI images) and face matching over the product photos (real
 * shoots), 2026-10-11. A matrix whose model was already set (Studio publish or
 * chosen in the Matrix tab) is left alone. Dry run unless --write.
 */
import fs from "node:fs";
import { getPool } from "@/lib/db";
import { listModelProfiles, setMatrixModel } from "@/lib/server/model-profiles";

async function main() {
  const file = process.argv[2];
  const write = process.argv.includes("--write");
  const rows = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ shopify_product_id: string; code: string; via: string }>;
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL missing");
  const byCode = new Map((await listModelProfiles(pool)).map((p) => [p.code, p]));
  let done = 0, skipped = 0, failed = 0;
  for (const r of rows) {
    const profile = byCode.get(r.code);
    const m = await pool.query<{ id: string; model_profile_id: string | null }>(
      `SELECT id::text, model_profile_id::text FROM matrices WHERE shopify_product_id = $1`,
      [r.shopify_product_id],
    );
    if (!profile || !m.rows.length) { skipped++; continue; }
    for (const row of m.rows) {
      if (row.model_profile_id) { skipped++; continue; }
      if (!write) { done++; continue; }
      const res = await setMatrixModel(pool, row.id, profile, "photos");
      if (res.warning) { failed++; console.log("warn", r.shopify_product_id, res.warning); } else done++;
    }
  }
  console.log(`${write ? "written" : "would write"} ${done}, skipped ${skipped}, failed ${failed}`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
