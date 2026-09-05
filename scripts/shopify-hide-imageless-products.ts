/**
 * Enforce: a product with no image is visible on no ONLINE sales channel.
 *
 * POINT OF SALE IS EXEMPT, deliberately. The brick-and-mortar store sells by
 * scanning a tag at the counter — nobody browses a listing, so a missing photo
 * costs nothing there. Holding imageless stock back from POS just makes it
 * unsellable in the shop. Every other channel is a browsable listing (Online
 * Store, Shop) or a product feed (Google, Meta, TikTok, Pinterest, Snapchat)
 * where an imageless item is dead or outright disapproved.
 *
 * Keep POS publishing in sync with scripts/shopify-sync-pos-channel.ts, which
 * pushes every active product TO Point of Sale. The two must not fight: this
 * script must never remove a POS publication that one adds.
 *
 * Why this is a sweep rather than a pre-publish check: images can only be
 * attached to a product that already exists in Shopify — see
 * lib/server/shopify-image-push.ts, which refuses to run without a
 * shopify_product_id. Blocking publish on "has an image" would deadlock: no
 * product, so no media, so no product.
 *
 * Safe to run repeatedly. It only ever REMOVES publications, never adds them,
 * so it cannot make a product visible.
 *
 * Usage:
 *   npx tsx scripts/shopify-hide-imageless-products.ts            # dry run
 *   npx tsx scripts/shopify-hide-imageless-products.ts --apply    # unpublish
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Channels this rule does NOT apply to. Matched on Shopify's publication name.
 * Point of Sale is in-store only: the sale starts by scanning a tag, so a
 * product without a photo is perfectly sellable there.
 */
const EXEMPT_CHANNELS = new Set(["Point of Sale"]);

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

type Offender = {
  id: string;
  title: string;
  productType: string;
  status: string;
  mediaCount: number;
  publications: Array<{ id: string; name: string }>;
  units: number;
  retailValue: number;
};

const SCAN = /* GraphQL */ `
  query ($cursor: String) {
    products(first: 25, after: $cursor) {
      nodes {
        id
        title
        status
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

const UNPUBLISH = /* GraphQL */ `
  mutation ($id: ID!, $input: [PublicationInput!]!) {
    publishableUnpublish(id: $id, input: $input) {
      publishable { availablePublicationsCount { count } }
      userErrors { field message }
    }
  }
`;

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Shop: ${SHOP}`);
  console.log(apply ? "MODE: APPLY — will unpublish\n" : "MODE: DRY RUN — no writes\n");

  const offenders: Offender[] = [];
  let scanned = 0;
  let imageless = 0;
  let cursor: string | null = null;

  for (;;) {
    const d: any = await gql(SCAN, { cursor });
    for (const p of d.products.nodes) {
      scanned++;
      const media = p.mediaCount?.count ?? 0;
      if (media > 0) continue;
      imageless++;
      const pubs = p.resourcePublicationsV2.nodes
        .filter((n: any) => n.isPublished)
        .map((n: any) => ({ id: n.publication.id, name: n.publication.name }))
        // Point of Sale is exempt — the shop scans a tag, it never shows a listing.
        .filter((pub: { name: string }) => !EXEMPT_CHANNELS.has(pub.name));
      if (!pubs.length) continue; // already correct — nothing to do
      const units = p.variants.nodes.reduce(
        (a: number, v: any) => a + Math.max(0, v.inventoryQuantity ?? 0), 0);
      const retailValue = p.variants.nodes.reduce(
        (a: number, v: any) => a + Math.max(0, v.inventoryQuantity ?? 0) * Number(v.price ?? 0), 0);
      offenders.push({
        id: p.id, title: p.title, productType: p.productType || "",
        status: p.status, mediaCount: media, publications: pubs, units, retailValue,
      });
    }
    process.stderr.write(`\rscanned ${scanned} products — ${imageless} imageless, ${offenders.length} visible  `);
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
  process.stderr.write("\n");

  console.log(`\nProducts scanned                    : ${scanned}`);
  console.log(`Products with no image              : ${imageless}`);
  console.log(`  ...already off every online channel: ${imageless - offenders.length}`);
  console.log(`  ...VISIBLE on an online channel    : ${offenders.length}`);

  if (!offenders.length) {
    console.log("\nNothing to do — every imageless product is already hidden from all ONLINE channels.");
    console.log("(Point of Sale is exempt by design — the shop sells by scanning a tag.)");
    return;
  }

  console.log("\nviolations:");
  for (const o of offenders.slice(0, 40)) {
    console.log(`  ${o.title.slice(0, 40).padEnd(42)} ${o.units} units  $${o.retailValue.toFixed(0).padStart(7)}  -> ${o.publications.map((p) => p.name).join(", ")}`);
  }
  if (offenders.length > 40) console.log(`  …and ${offenders.length - 40} more`);

  const outDir = join("scripts", ".imageless-sweeps");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(outDir, `unpublished-${stamp}.json`);
  writeFileSync(backup, JSON.stringify(offenders, null, 2));
  console.log(`\nRecord of what was visible written to ${backup}`);
  console.log("(re-publishing is a manual decision — this script never publishes)");

  if (!apply) {
    console.log("\nDry run complete. Re-run with --apply to unpublish these.");
    return;
  }

  let ok = 0;
  const failures: string[] = [];
  for (const o of offenders) {
    try {
      const d: any = await gql(UNPUBLISH, {
        id: o.id,
        input: o.publications.map((p) => ({ publicationId: p.id })),
      });
      const errs = d?.publishableUnpublish?.userErrors ?? [];
      if (errs.length) failures.push(`${o.title}: ${JSON.stringify(errs)}`);
      else ok++;
    } catch (e: any) {
      failures.push(`${o.title}: ${e?.message ?? e}`);
    }
    process.stderr.write(`\runpublished ${ok}/${offenders.length}  `);
  }
  process.stderr.write("\n");
  console.log(`\nDone. ${ok} hidden, ${failures.length} failed.`);
  for (const f of failures.slice(0, 10)) console.log(`  ${f}`);
}

main().catch((e) => {
  console.error("\n" + (e?.stack ?? e));
  process.exit(1);
});
