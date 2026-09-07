/* eslint-disable no-console */
/**
 * Push the "Complete the Look" banner to every product flagged as part of a set.
 *
 * Idempotent by construction: each product's description is rewritten from what
 * Shopify currently holds, so re-running changes nothing and a product whose
 * flag was cleared has its banner removed.
 *
 *   npx tsx scripts/push-set-banners.ts            # report only
 *   npx tsx scripts/push-set-banners.ts --write    # apply
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { resolveShopContext } from "@/lib/server/shopify-write";
import { syncSetBanners } from "@/lib/server/set-banner";

async function main() {
  const root = process.cwd();
  const env = fs.readFileSync(path.join(root, ".env.coolify.local"), "utf8");
  const get = (k: string) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim() || "";
  for (const k of ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_ADMIN_ACCESS_TOKEN"]) process.env[k] = get(k);

  const WRITE = process.argv.includes("--write");
  const pool = new Client({ connectionString: get("DATABASE_URL"), ssl: false });
  await pool.connect();
  const ctx = await resolveShopContext();
  if (!ctx) throw new Error("Shop not connected");

  const r = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM matrices
      WHERE is_set = true AND shopify_product_id IS NOT NULL
      ORDER BY description`,
  );
  const ids = r.rows.map((x) => x.id);
  console.log(`${ids.length} set products live on Shopify · mode: ${WRITE ? "WRITE" : "DRY RUN"}\n`);
  if (!WRITE) {
    console.log("Nothing written. Re-run with --write.");
    await pool.end();
    return;
  }

  let changed = 0, already = 0, failed = 0;
  const pics = { 1: 0, 2: 0 };
  /* Small batches so one bad product cannot strand a long run, and so progress
     is visible on a job that makes two Shopify calls per product. */
  for (let i = 0; i < ids.length; i += 10) {
    const slice = ids.slice(i, i + 10);
    const results = await syncSetBanners(pool as never, ctx, slice);
    for (const res of results) {
      if (res.error) failed += 1;
      else if (res.changed) changed += 1;
      else already += 1;
      if (res.picture) pics[res.picture] += 1;
      if (res.error) console.log(`   FAILED ${res.matrixId}: ${res.error}`);
    }
    process.stdout.write(`\r  ${Math.min(i + 10, ids.length)}/${ids.length}`);
  }
  console.log(`\n\nbanner added or corrected: ${changed}`);
  console.log(`already correct          : ${already}`);
  console.log(`failed                   : ${failed}`);
  console.log(`artwork: pic1 ${pics[1]} · pic2 ${pics[2]}`);
  await pool.end();
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
