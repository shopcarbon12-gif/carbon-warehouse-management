/* eslint-disable no-console */
/**
 * Set products with no stock to DRAFT.
 *
 * A draft product is off every sales channel, which is what "invisible" needs to
 * mean here — hiding it from the online store alone would leave it live on
 * Google, POS and anything else attached.
 *
 * Requires BOTH counts to be zero: the WMS matrix (live in-stock EPCs, the
 * operator's truth) and Shopify's own inventory (what actually governs whether
 * it can be sold). Drafting on one alone would hide a product that the other
 * system still considers sellable.
 *
 *   npx tsx scripts/draft-zero-qty.ts            # report only
 *   npx tsx scripts/draft-zero-qty.ts --write    # apply
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const WRITE = process.argv.includes("--write");
const env = fs.readFileSync(path.join(process.cwd(), ".env.coolify.local"), "utf8");
const get = (k: string) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim() || "";
const SHOP = get("SHOPIFY_SHOP_DOMAIN");
const TOKEN = get("SHOPIFY_ADMIN_ACCESS_TOKEN");

async function gql<T = any>(query: string, variables?: any): Promise<T> {
  for (let a = 0; a < 6; a += 1) {
    const r = await fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (r.status === 429 || r.status >= 500) {
      await new Promise((s) => setTimeout(s, 1500 * (a + 1)));
      continue;
    }
    const j = await r.json();
    if (j.errors) {
      if (/throttl/i.test(JSON.stringify(j.errors))) {
        await new Promise((s) => setTimeout(s, 2000 * (a + 1)));
        continue;
      }
      throw new Error(JSON.stringify(j.errors).slice(0, 300));
    }
    return j.data as T;
  }
  throw new Error("Shopify retries exhausted");
}

async function main() {
  const pool = new Client({ connectionString: get("DATABASE_URL"), ssl: false });
  await pool.connect();

  /* WMS side: in-stock EPCs per matrix, the same definition the catalog grid
     uses so the number matches what the operator sees. */
  const wms = await pool.query<{ pid: string; description: string; qty: number }>(
    `SELECT m.shopify_product_id AS pid, m.description,
            COUNT(i.id) FILTER (WHERE i.status = 'in-stock')::int AS qty
       FROM matrices m
       LEFT JOIN custom_skus cs ON cs.matrix_id = m.id
       LEFT JOIN items i ON i.custom_sku_id = cs.id
      WHERE m.shopify_product_id IS NOT NULL
      GROUP BY m.id, m.shopify_product_id, m.description`,
  );
  const wmsQty = new Map(wms.rows.map((r) => [String(r.pid), r]));

  const products: any[] = [];
  let cursor: string | null = null;
  do {
    const d: any = await gql(
      `query($c:String){ products(first:100, after:$c, query:"status:active"){
         pageInfo{hasNextPage endCursor}
         nodes{ id title status totalInventory isGiftCard tracksInventory: totalInventory
                media(first:1){ nodes{ ... on MediaImage { id } } } } } }`,
      { c: cursor },
    );
    products.push(...d.products.nodes);
    cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (cursor);

  const skipped: string[] = [];
  const candidates = products.filter((p) => {
    /* A gift card reports zero inventory because it is not stocked, not because
       it sold out. Drafting it would pull a sellable product off every channel. */
    if (p.isGiftCard) {
      skipped.push(`${p.title} — gift card, not stock-tracked`);
      return false;
    }
    const w = wmsQty.get(String(p.id));
    /* No WMS matrix means no second opinion on the stock level. Hiding a
       product on one system's word alone is not worth the risk. */
    if (!w) {
      skipped.push(`${p.title} — no WMS matrix, cannot confirm stock`);
      return false;
    }
    return (p.totalInventory ?? 0) <= 0 && w.qty === 0;
  });

  console.log(`${products.length} active products · ${candidates.length} with zero stock in BOTH systems`);
  if (skipped.length) {
    console.log(`\n  left alone (${skipped.length}):`);
    skipped.forEach((sk) => console.log(`    ${sk}`));
  }
  console.log("");
  for (const p of candidates) {
    const w = wmsQty.get(String(p.id));
    const imaged = (p.media?.nodes || []).length > 0;
    console.log(`   ${String(p.title).slice(0, 40).padEnd(42)} shopify=${p.totalInventory ?? 0} wms=${w ? w.qty : "n/a"}${imaged ? " [has photos]" : ""}`);
  }

  if (!WRITE) {
    console.log(`\nDRY RUN — nothing changed. Re-run with --write to set these to draft.`);
    await pool.end();
    return;
  }

  let ok = 0, failed = 0;
  for (const p of candidates) {
    try {
      const d: any = await gql(
        `mutation($input: ProductInput!){ productUpdate(input:$input){ product{ id status } userErrors{ message } } }`,
        { input: { id: p.id, status: "DRAFT" } },
      );
      const errs = d.productUpdate?.userErrors || [];
      if (errs.length) throw new Error(errs.map((e: any) => e.message).join("; "));
      ok += 1;
    } catch (e) {
      failed += 1;
      console.log(`   FAILED ${p.title}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\nset to draft: ${ok} · failed: ${failed}`);
  await pool.end();
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
