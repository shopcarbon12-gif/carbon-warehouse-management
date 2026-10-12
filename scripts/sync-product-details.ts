/**
 * Push product Details (fabric, care, model height) to Shopify metafields and
 * Google Merchant Center now, instead of waiting for the next Sync ads job.
 *
 *   npx tsx scripts/sync-product-details.ts
 */
import { getPool } from "@/lib/db";
import { syncProductDetails } from "@/lib/server/product-details-sync";

async function main() {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL missing");
  const r = await syncProductDetails(pool, (m) => console.log(m));
  console.log(JSON.stringify(r, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
