/* eslint-disable no-console */
/**
 * Publish the in-stock WMS products that have photos but no Shopify listing.
 *
 * Goes through the same path as Check & Publish in the Matrix window: validate
 * first, then enqueue a shopify_product_push job for the worker. Creating the
 * product here by hand would skip the validation and the variant/inventory/
 * channel handling that job already does correctly.
 *
 *   npx tsx scripts/publish-instock-unlisted.ts            # report only
 *   npx tsx scripts/publish-instock-unlisted.ts --write    # enqueue
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { validateMatrixForPublish, type PublishVariantRow } from "@/lib/server/shopify-publish-validate";

const WRITE = process.argv.includes("--write");
const env = fs.readFileSync(path.join(process.cwd(), ".env.coolify.local"), "utf8");
const get = (k: string) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim() || "";

async function main() {
  const ids = JSON.parse(fs.readFileSync("/tmp/seobulk/ids.json", "utf8"));
  const pool = new Client({ connectionString: get("DATABASE_URL"), ssl: false });
  await pool.connect();

  const IMG =
    "(jsonb_array_length(coalesce(m.shopify_image_urls,'[]'::jsonb))>0 OR m.shopify_featured_image_url IS NOT NULL)";
  /* Photos, no Shopify listing, and actual stock. Zero-stock ones are excluded
     on purpose — they would be drafted the moment they landed. */
  const r = await pool.query<{ id: string; upc: string | null; description: string; qty: number }>(
    `SELECT m.id::text AS id, m.upc, m.description,
            COUNT(i.id) FILTER (WHERE i.status='in-stock')::int AS qty
       FROM matrices m
       LEFT JOIN custom_skus cs ON cs.matrix_id = m.id
       LEFT JOIN items i ON i.custom_sku_id = cs.id
      WHERE ${IMG}
        AND m.shopify_product_id IS NULL
      GROUP BY m.id
     HAVING COUNT(i.id) FILTER (WHERE i.status='in-stock') > 0
      ORDER BY 4 DESC`,
  );
  console.log(`${r.rows.length} in-stock products with photos and no Shopify listing\n`);

  for (const m of r.rows) {
    const vr = await pool.query<PublishVariantRow>(
      `SELECT id::text, sku, color_code, size, retail_price::text AS retail_price
         FROM custom_skus WHERE matrix_id = $1::uuid AND archived = FALSE`,
      [m.id],
    );
    const val = await validateMatrixForPublish(pool as never, m.id, vr.rows);
    const state = val.ok ? "ready" : `BLOCKED — ${val.errors.join("; ")}`;
    console.log(`   ${String(m.qty).padStart(4)}  ${String(m.upc || "—").padEnd(9)} ${m.description.slice(0, 32).padEnd(34)} ${state}`);

    if (!WRITE || !val.ok) continue;

    await pool.query(
      `UPDATE matrices SET checked_at = now(), checked_by = $2::uuid, shopify_sync_status = 'pending'
        WHERE id = $1::uuid`,
      [m.id, ids.uid],
    );
    const active = await pool.query(
      `SELECT id FROM sync_jobs
        WHERE job_type='shopify_product_push' AND status IN ('queued','running')
          AND payload->>'matrixId' = $1`,
      [m.id],
    );
    if (active.rows[0]) {
      console.log(`         already queued`);
      continue;
    }
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
       VALUES ($1::uuid, $2::uuid, 'shopify_product_push', 'queued', $3, $4::jsonb)
       RETURNING id::text`,
      [
        ids.tid,
        ids.lid,
        `shopify_product_push:${m.id}:${Date.parse(new Date().toISOString())}`,
        JSON.stringify({ matrixId: m.id, locationId: ids.lid, user_id: ids.uid, trigger: "check_and_publish" }),
      ],
    );
    console.log(`         queued job ${ins.rows[0].id}`);
  }

  if (!WRITE) console.log(`\nDRY RUN — nothing queued. Re-run with --write.`);
  await pool.end();
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
