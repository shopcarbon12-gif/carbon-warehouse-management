/**
 * Publish every sellable product to the Point of Sale channel.
 *
 * The brick-and-mortar store sells by scanning a tag at the counter — there is
 * no listing for a customer to browse, so a missing product photo costs
 * nothing. Anything the WMS considers sellable should therefore be ringable in
 * the shop, whether or not it has been photographed yet.
 *
 * This is the counterpart to scripts/shopify-hide-imageless-products.ts, which
 * hides imageless products from the ONLINE channels (Online Store, Shop,
 * Google, Meta, TikTok, Pinterest, Snapchat) and deliberately exempts POS. The
 * two scripts must not fight: this one only ever adds a POS publication, that
 * one never removes one.
 *
 * "Sellable" here means Shopify status ACTIVE. Draft and archived products are
 * skipped — draft means the buyer hasn't finished setting it up, and archived
 * means it is retired.
 *
 * Usage:
 *   npx tsx scripts/shopify-sync-pos-channel.ts            # dry run
 *   npx tsx scripts/shopify-sync-pos-channel.ts --apply    # publish to POS
 */

import { readFileSync, existsSync } from "node:fs";

function loadEnv() {
  const out: Record<string, string> = {};
  for (const f of [".env.local", ".env.agent-secrets", ".env"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !out[m[1]]) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}
const env = loadEnv();
const SHOP = env.SHOPIFY_SHOP_DOMAIN;
const TOKEN = env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const API = env.SHOPIFY_API_VERSION || "2025-01";
if (!SHOP || !TOKEN) {
  console.error("Missing SHOPIFY_SHOP_DOMAIN / SHOPIFY_ADMIN_ACCESS_TOKEN.");
  process.exit(1);
}

const POS_CHANNEL_NAME = "Point of Sale";

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  for (let a = 0; a < 10; a++) {
    const res = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const j: any = await res.json();
    if (j.errors?.some((e: any) => e?.extensions?.code === "THROTTLED")) {
      await new Promise((r) => setTimeout(r, 2000 * (a + 1)));
      continue;
    }
    if (j.errors) throw new Error(JSON.stringify(j.errors, null, 2));
    return j.data as T;
  }
  throw new Error("Shopify throttled after max retries");
}

const SCAN = /* GraphQL */ `
  query ($cursor: String) {
    products(first: 25, after: $cursor, query: "status:active") {
      nodes {
        id
        title
        productType
        mediaCount { count }
        resourcePublicationsV2(first: 15) {
          nodes { isPublished publication { id name } }
        }
        variants(first: 100) { nodes { price inventoryQuantity } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PUBLISH = /* GraphQL */ `
  mutation ($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Shop: ${SHOP}`);
  console.log(apply ? "MODE: APPLY — will publish to Point of Sale\n" : "MODE: DRY RUN — no writes\n");

  const pubs = await gql<{ publications: { nodes: Array<{ id: string; name: string }> } }>(
    `query { publications(first: 25) { nodes { id name } } }`,
  );
  const pos = pubs.publications.nodes.find((p) => p.name === POS_CHANNEL_NAME);
  if (!pos) {
    console.error(`Could not find a "${POS_CHANNEL_NAME}" publication on this shop.`);
    process.exit(1);
  }
  console.log(`Point of Sale publication: ${pos.id}\n`);

  const missing: Array<{ id: string; title: string; type: string; media: number; units: number; value: number }> = [];
  let active = 0;
  let already = 0;
  let cursor: string | null = null;

  for (;;) {
    const d: any = await gql(SCAN, { cursor });
    for (const p of d.products.nodes) {
      active++;
      const onPos = p.resourcePublicationsV2.nodes.some(
        (n: any) => n.isPublished && n.publication.name === POS_CHANNEL_NAME,
      );
      if (onPos) { already++; continue; }
      const units = p.variants.nodes.reduce(
        (a: number, v: any) => a + Math.max(0, v.inventoryQuantity ?? 0), 0);
      const value = p.variants.nodes.reduce(
        (a: number, v: any) => a + Math.max(0, v.inventoryQuantity ?? 0) * Number(v.price ?? 0), 0);
      missing.push({
        id: p.id, title: p.title, type: p.productType || "",
        media: p.mediaCount?.count ?? 0, units, value,
      });
    }
    process.stderr.write(`\rscanned ${active} active — ${missing.length} missing from POS  `);
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
  process.stderr.write("\n");

  const units = missing.reduce((a, b) => a + b.units, 0);
  const value = missing.reduce((a, b) => a + b.value, 0);
  const imageless = missing.filter((m) => m.media === 0).length;

  console.log(`\nActive products              : ${active}`);
  console.log(`  already on Point of Sale   : ${already}`);
  console.log(`  MISSING from Point of Sale : ${missing.length}`);
  console.log(`    ...of which imageless    : ${imageless}`);
  console.log(`  stock locked out of the shop: ${units} units, $${value.toFixed(2)} retail`);

  if (!missing.length) {
    console.log("\nNothing to do — every active product is already sellable in the shop.");
    return;
  }

  console.log("\nfirst 15 to be added:");
  for (const m of missing.slice(0, 15)) {
    console.log(`  ${m.title.slice(0, 38).padEnd(40)} ${String(m.units).padStart(4)} units  $${m.value.toFixed(0).padStart(7)}  ${m.media === 0 ? "(no image)" : ""}`);
  }
  if (missing.length > 15) console.log(`  …and ${missing.length - 15} more`);

  if (!apply) {
    console.log("\nDry run complete. Re-run with --apply to publish these to Point of Sale.");
    return;
  }

  let ok = 0;
  const failures: string[] = [];
  for (const m of missing) {
    try {
      const d: any = await gql(PUBLISH, { id: m.id, input: [{ publicationId: pos.id }] });
      const errs = d?.publishablePublish?.userErrors ?? [];
      if (errs.length) failures.push(`${m.title}: ${JSON.stringify(errs)}`);
      else ok++;
    } catch (e: any) {
      failures.push(`${m.title}: ${e?.message ?? e}`);
    }
    process.stderr.write(`\rpublished ${ok}/${missing.length}  `);
  }
  process.stderr.write("\n");
  console.log(`\nDone. ${ok} published to Point of Sale, ${failures.length} failed.`);
  for (const f of failures.slice(0, 10)) console.log(`  ${f}`);
}

main().catch((e) => {
  console.error("\n" + (e?.stack ?? e));
  process.exit(1);
});
