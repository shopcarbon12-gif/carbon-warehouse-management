/**
 * Backfill Shopify variant shipping weights.
 *
 * Every variant in the store currently has weight = 0 lb while `requiresShipping`
 * is true and every domestic/international rate except one is carrier-calculated
 * (UPS / USPS / DHL). Carriers price from weight, so a 0 lb parcel produces
 * garbage quotes at the first checkout step — which is exactly where 50 of 62
 * checkout sessions were abandoned in the last 12 months.
 *
 * This script derives a weight per variant from the product's `productType`
 * (falling back to the Shopify taxonomy category, then to a catch-all default)
 * and writes it via `inventoryItemUpdate`.
 *
 * Usage:
 *   npx tsx scripts/shopify-variant-weights.ts                 # dry run + report
 *   npx tsx scripts/shopify-variant-weights.ts --apply         # write to Shopify
 *   npx tsx scripts/shopify-variant-weights.ts --apply --limit 50
 *   npx tsx scripts/shopify-variant-weights.ts --restore <backup.json>
 *
 * Dry run is the default. `--apply` writes a timestamped backup of every prior
 * weight to scripts/.weight-backups/ before touching anything, so the whole run
 * is reversible with --restore.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- env loading

function loadEnv() {
  const files = [".env.local", ".env.agent-secrets", ".env"];
  const out: Record<string, string> = {};
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      if (out[key]) continue; // first file wins
      out[key] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

const env = loadEnv();
const SHOP = env.SHOPIFY_SHOP_DOMAIN;
const TOKEN = env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const API_VERSION = env.SHOPIFY_API_VERSION || "2025-01";

if (!SHOP || !TOKEN) {
  console.error("Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN.");
  process.exit(1);
}

// ------------------------------------------------------------- weight mapping

/**
 * Shipping weight in POUNDS: garment + polybag + a share of the mailer.
 *
 * Keyed on the store's own `productType` taxonomy, which is consistently
 * formatted as "GENDER >> GARMENT" and is a far more reliable signal than the
 * Shopify taxonomy category (which is null or "Uncategorized" on a large share
 * of the catalog, and whose wording cross-contaminates fuzzy matching).
 *
 * All 55 product types present in the catalog on 2026-09-05 are listed
 * explicitly. Women's garments are set lighter than the men's equivalent.
 *
 * These are category estimates, not measured values. Where uncertain they lean
 * HEAVY on purpose: overestimating means the customer is quoted slightly more
 * than the true label cost, whereas underestimating means Carbon absorbs the
 * difference on every parcel.
 */
const EXPLICIT_WEIGHTS: Record<string, number> = {
  // ---- OWNER OVERRIDES (Elior, 2026-09-05): every shirt 1 lb, every pair of
  //      jeans 2 lb, every coat/jacket 2 lb. These supersede the estimates
  //      below and are applied to ALL shirt types including T-shirts and tees.
  // ---- bottoms
  "MEN >> JEANS": 2.0,
  "WOMEN >> JEANS": 2.0,
  "JEANS": 2.0,
  "MEN >> PANTS": 0.9,
  "MEN >> EVENING PANTS": 0.9,
  "WOMEN >> PANTS": 0.75,
  "WOMEN >> LEGGING": 0.5,
  "MEN >> SWEATPANTS": 1.0,
  "WOMEN >> SWEATPANTS": 0.85,
  "MEN >> SHORTS": 0.55,
  "WOMEN >> SHORTS": 0.45,
  "SHORTS": 0.5,
  "WOMEN >> SKIRT": 0.55,

  // ---- shirts (owner override: 1 lb across the board, tees included)
  "MEN >> T-SHIRT": 1.0,
  "MEN >> T- SHIRT": 1.0, // typo variant present in the catalog
  "WOMEN >> T-SHIRT": 1.0,
  "T-SHIRT": 1.0,
  "WOMEN >> TEES": 1.0,
  "MEN >> SHIRTS": 1.0,
  "MEN >> BUTTON SHIRT": 1.0,
  "MEN >> DENIM SHIRT": 1.0, // a shirt, not denim bottoms

  // ---- other tops (not "shirts" — left at estimate)
  "MEN >> TOP": 0.5,
  "WOMEN >> TOP": 0.4,
  "WOMEN >> TOPS": 0.4,
  "WOMEN >> BLOUSE": 0.4,
  "MEN >> TANK TOP": 0.35,
  "WOMEN >> BODYSUIT": 0.4,

  // ---- knitwear / fleece
  "MEN >> SWEATSHIRTS": 1.25,
  "WOMEN >> SWEATSHIRTS": 1.1,
  "WOMEN >> SWEATSHIRT": 1.1,
  "SWEATSHIRTS": 1.2,
  "WOMEN >> HOODIE": 1.15,
  "MEN >> SWEATER": 1.1,

  // ---- outerwear (owner override: 2 lb for every coat and jacket)
  "MEN >> JACKET": 2.0,
  "MEN >> DENIM JACKET": 2.0,
  "MEN >> COAT": 2.0,
  "WOMEN >> JACKET": 2.0,
  "WOMEN >> COAT": 2.0,
  "JACKET": 2.0,
  "MEN >> VEST": 0.9,
  "WOMEN >> VEST": 0.7,

  // ---- one-pieces & sets
  "WOMEN >> DRESS": 0.8,
  "DRESS": 0.8,
  "WOMEN >> ROMPER": 0.7,
  "MEN >> OVERALL": 1.6,
  "WOMEN >> SET": 1.3,

  // ---- swim
  "MEN >> SWIMWEAR": 0.4,
  "WOMEN >> SWIMSUIT": 0.3,

  // ---- footwear (boxed — heaviest line in the catalog)
  "MEN >> SHOES": 2.2,
  "WOMEN >> SHOES": 1.7,

  // ---- accessories: belts, jewelry, sunglasses, masks. Wide spread, small
  //      population; 0.35 is a safe middle that never undercharges the belts.
  "MEN >> ACCESSORIES": 0.35,
  "WOMEN >> ACCESSORIES": 0.35,

  // ---- unclassified
  "MEN": 0.75,
  "GENERAL": 0.75,
};

/**
 * Fallback only — for product types added to the catalog after this table was
 * written. Matched against productType alone, never the taxonomy category.
 */
const FALLBACK_RULES: Array<[pattern: RegExp, lb: number]> = [
  // Order is significant: the first match wins, so every pattern that is a
  // SUBSTRING of another must come first. "T-SHIRT" contains "SHIRT" and
  // "TANK TOP" contains "TOP", so those go above their broader cousins.
  [/SHOES?|SNEAKER|HEEL|BOOT|SANDAL/, 2.0],
  [/DENIM JACKET|JACKET|COAT|OUTERWEAR|PUFFER|BLAZER/, 2.0], // owner override
  [/OVERALL|JUMPSUIT|DUNGAREE/, 1.6],
  [/SET|TRACKSUIT|OUTFIT/, 1.3],
  // "DENIM SHIRT" is a shirt, not bottoms — must precede the JEANS/DENIM rule
  [/DENIM SHIRT/, 1.0],
  [/JEANS|DENIM/, 2.0], // owner override
  [/SWEATSHIRT|HOODIE|SWEATER|KNIT|CARDIGAN|PULLOVER/, 1.15],
  [/SWEATPANT|JOGGER/, 0.95],
  [/PANTS|TROUSER|CHINO/, 0.85],
  [/LEGGING/, 0.5],
  [/VEST/, 0.8],
  [/DRESS|GOWN/, 0.8],
  [/ROMPER|PLAYSUIT/, 0.7],
  [/BLOUSE/, 0.4], // not treated as a "shirt" — keep before the SHIRT rule
  [/T-\s?SHIRTS?|TEES?/, 1.0], // owner override; must precede SHIRT
  [/TANK/, 0.35], // must precede TOP
  [/BODYSUIT/, 0.4],
  [/SHIRTS?|POLO/, 1.0], // owner override
  [/SKIRT/, 0.55],
  [/SHORTS?/, 0.5],
  [/TOPS?/, 0.45],
  [/BELT/, 0.4],
  [/SWIMSUIT|SWIMWEAR|BIKINI|SWIM/, 0.35],
  [/SUNGLASS|EYEWEAR/, 0.35],
  [/SOCK|UNDERWEAR|BRIEF/, 0.2],
  [/HAT|CAP|BEANIE/, 0.3],
  [/BAG|PURSE|WALLET/, 0.8],
  [/JEWELRY|BRACELET|NECKLACE|EARRING/, 0.15],
  [/MASK/, 0.15],
  [/ACCESSOR/, 0.35],
];

const DEFAULT_WEIGHT = 0.75; // mid-weight garment; used when nothing matches

/**
 * OWNER BANDING (Elior, 2026-09-05). Carbon ships in three parcel sizes, so
 * every per-category estimate above is rounded into one of three buckets:
 *
 *   above 1.5 lb        -> 2.0
 *   above 1.0, to 1.5   -> 1.5
 *   1.0 and below       -> 1.0   (1.0 is the floor, NOT rounded up to 1.5)
 *
 * Exactly 1.0 stays at 1.0 — that band holds every shirt and tee, which the
 * owner set to 1 lb deliberately. The tables above are kept as the record of
 * relative intent; this is what actually ships to Shopify.
 */
function band(lb: number): number {
  if (lb > 1.5) return 2.0;
  if (lb > 1.0) return 1.5;
  return 1.0;
}

function normalizeType(productType: string) {
  return (productType || "").toUpperCase().replace(/\s+/g, " ").trim();
}

function weightFor(
  productType: string,
  _category: string | null,
  title = "",
): { lb: number; rule: string } {
  const key = normalizeType(productType);
  if (key in EXPLICIT_WEIGHTS) {
    return { lb: band(EXPLICIT_WEIGHTS[key]), rule: `exact:${key}` };
  }
  for (const [pattern, lb] of FALLBACK_RULES) {
    if (pattern.test(key)) return { lb: band(lb), rule: `fallback:${pattern.source}` };
  }
  // 88 variants carry no productType at all but name the garment in the title
  // ("EXCELLENT T-SHIRT", "HARPER SHIRT SET"). Reading the title beats charging
  // all of them the 0.75 lb catch-all.
  const fromTitle = normalizeType(title);
  if (fromTitle) {
    for (const [pattern, lb] of FALLBACK_RULES) {
      if (pattern.test(fromTitle)) return { lb: band(lb), rule: `title:${pattern.source}` };
    }
  }
  return { lb: band(DEFAULT_WEIGHT), rule: "(default)" };
}

// ------------------------------------------------------------------- graphql

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const json: any = await res.json().catch(() => ({}));
    const throttled =
      res.status === 429 ||
      (Array.isArray(json?.errors) &&
        json.errors.some((e: any) => e?.extensions?.code === "THROTTLED"));
    if (throttled) {
      const cost = json?.extensions?.cost?.throttleStatus;
      const needed = Math.max(
        0,
        Number(json?.extensions?.cost?.requestedQueryCost ?? 0) -
          Number(cost?.currentlyAvailable ?? 0),
      );
      const wait = cost?.restoreRate
        ? Math.ceil((needed / Number(cost.restoreRate)) * 1000) || 1000
        : 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(15000, wait) + 200));
      continue;
    }
    if (Array.isArray(json?.errors) && json.errors.length) {
      throw new Error(JSON.stringify(json.errors));
    }
    return json.data as T;
  }
  throw new Error("Shopify throttled after max retries");
}

// -------------------------------------------------------------------- fetch

type Row = {
  productId: string;
  productTitle: string;
  productType: string;
  category: string | null;
  variantId: string;
  variantTitle: string;
  sku: string | null;
  inventoryItemId: string;
  requiresShipping: boolean;
  currentLb: number;
  targetLb: number;
  rule: string;
};

const FETCH = /* GraphQL */ `
  query ($cursor: String) {
    products(first: 50, after: $cursor) {
      nodes {
        id
        title
        productType
        category { fullName }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            inventoryItem {
              id
              requiresShipping
              measurement { weight { value unit } }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function fetchAll(): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | null = null;
  let page = 0;
  for (;;) {
    const data: any = await gql(FETCH, { cursor });
    const conn = data.products;
    for (const p of conn.nodes) {
      const { lb, rule } = weightFor(p.productType, p.category?.fullName ?? null, p.title);
      for (const v of p.variants.nodes) {
        const w = v.inventoryItem?.measurement?.weight;
        // normalize any non-pound units so comparisons are apples-to-apples
        const raw = Number(w?.value ?? 0);
        const unit = w?.unit ?? "POUNDS";
        const currentLb =
          unit === "KILOGRAMS" ? raw * 2.20462
          : unit === "GRAMS" ? raw / 453.592
          : unit === "OUNCES" ? raw / 16
          : raw;
        rows.push({
          productId: p.id,
          productTitle: p.title,
          productType: p.productType || "",
          category: p.category?.fullName ?? null,
          variantId: v.id,
          variantTitle: v.title,
          sku: v.sku,
          inventoryItemId: v.inventoryItem.id,
          requiresShipping: !!v.inventoryItem?.requiresShipping,
          currentLb,
          targetLb: lb,
          rule,
        });
      }
    }
    page++;
    process.stderr.write(`\rfetched page ${page} — ${rows.length} variants`);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  process.stderr.write("\n");
  return rows;
}

// -------------------------------------------------------------------- write

/**
 * One mutation per PRODUCT rather than one per variant. A product averages 6.5
 * variants, so this turns ~4,984 round trips into ~771. Combined with a small
 * concurrency pool it takes minutes instead of an hour — the per-variant
 * version was throttle-bound at ~95 writes/min.
 */
const BULK_UPDATE = /* GraphQL */ `
  mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }
`;

const CONCURRENCY = 4;

async function applyWeights(rows: Row[]) {
  const byProduct = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byProduct.get(r.productId) ?? [];
    list.push(r);
    byProduct.set(r.productId, list);
  }
  const groups = [...byProduct.entries()];

  let done = 0;
  let ok = 0;
  const failures: Array<{ sku: string | null; message: string }> = [];
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= groups.length) return;
      const [productId, group] = groups[i];
      try {
        const data: any = await gql(BULK_UPDATE, {
          productId,
          variants: group.map((r) => ({
            id: r.variantId,
            inventoryItem: {
              measurement: { weight: { value: r.targetLb, unit: "POUNDS" } },
            },
          })),
        });
        const errs = data?.productVariantsBulkUpdate?.userErrors ?? [];
        if (errs.length) {
          failures.push({ sku: group[0].sku, message: JSON.stringify(errs) });
        } else {
          ok += group.length;
        }
      } catch (e: any) {
        failures.push({ sku: group[0].sku, message: e?.message ?? String(e) });
      }
      done++;
      if (done % 10 === 0 || done === groups.length) {
        process.stderr.write(
          `\rproducts ${done}/${groups.length} — variants ok ${ok}, failed ${failures.length}   `,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  process.stderr.write("\n");
  return { ok, failures };
}

// ------------------------------------------------------------------ reporting

function summarize(rows: Row[]) {
  const byRule = new Map<string, { count: number; lb: number; types: Set<string> }>();
  for (const r of rows) {
    const k = `${r.targetLb} lb`;
    const e = byRule.get(k) ?? { count: 0, lb: r.targetLb, types: new Set<string>() };
    e.count++;
    if (r.productType) e.types.add(r.productType);
    byRule.set(k, e);
  }
  const sorted = [...byRule.entries()].sort((a, b) => b[1].lb - a[1].lb);
  console.log("\n  weight     variants   product types");
  console.log("  " + "-".repeat(76));
  for (const [k, e] of sorted) {
    const types = [...e.types].sort().slice(0, 4).join(", ");
    const more = e.types.size > 4 ? ` +${e.types.size - 4} more` : "";
    console.log(
      `  ${k.padEnd(10)} ${String(e.count).padStart(8)}   ${types}${more}`.slice(0, 118),
    );
  }
  console.log("  " + "-".repeat(76));

  const defaulted = rows.filter((r) => r.rule === "(default)");
  if (defaulted.length) {
    const types = [...new Set(defaulted.map((r) => r.productType || "(blank)"))].sort();
    console.log(
      `\n  ${defaulted.length} variants fell through to the ${DEFAULT_WEIGHT} lb default.`,
    );
    console.log(`  product types: ${types.join(", ")}`);
  }
}

// ----------------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
  const restoreArg = args.indexOf("--restore");

  if (restoreArg >= 0) {
    const path = args[restoreArg + 1];
    const backup: Row[] = JSON.parse(readFileSync(path, "utf8"));
    console.log(`Restoring ${backup.length} variants from ${path}`);
    const restoreRows = backup.map((b) => ({ ...b, targetLb: b.currentLb }));
    const { ok, failures } = await applyWeights(restoreRows);
    console.log(`Restored ${ok}; ${failures.length} failed.`);
    return;
  }

  console.log(`Shop: ${SHOP}  (API ${API_VERSION})`);
  console.log(apply ? "MODE: APPLY — will write to Shopify\n" : "MODE: DRY RUN — no writes\n");

  const all = await fetchAll();
  const shippable = all.filter((r) => r.requiresShipping);
  const needsChange = shippable
    .filter((r) => Math.abs(r.currentLb - r.targetLb) > 0.001)
    .slice(0, limit);

  console.log(`\nTotal variants:            ${all.length}`);
  console.log(`Requires shipping:         ${shippable.length}`);
  console.log(`Currently 0 lb:            ${shippable.filter((r) => r.currentLb === 0).length}`);
  console.log(`Will be changed:           ${needsChange.length}`);

  summarize(needsChange);

  const outDir = join("scripts", ".weight-backups");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const planPath = join(outDir, `plan-${stamp}.csv`);
  writeFileSync(
    planPath,
    "sku,product,variant,product_type,current_lb,target_lb\n" +
      needsChange
        .map((r) =>
          [
            r.sku ?? "",
            `"${r.productTitle.replace(/"/g, '""')}"`,
            `"${r.variantTitle.replace(/"/g, '""')}"`,
            `"${r.productType}"`,
            r.currentLb,
            r.targetLb,
          ].join(","),
        )
        .join("\n"),
  );
  console.log(`\nPlan written to ${planPath}`);

  if (!apply) {
    console.log("\nDry run complete. Re-run with --apply to write these weights.");
    return;
  }

  const backupPath = join(outDir, `backup-${stamp}.json`);
  writeFileSync(backupPath, JSON.stringify(needsChange, null, 2));
  console.log(`Backup of prior weights written to ${backupPath}`);
  console.log(`Restore with: npx tsx scripts/shopify-variant-weights.ts --restore ${backupPath}\n`);

  const { ok, failures } = await applyWeights(needsChange);
  console.log(`\nDone. ${ok} updated, ${failures.length} failed.`);
  if (failures.length) {
    console.log("First failures:");
    for (const f of failures.slice(0, 10)) console.log(`  ${f.sku}: ${f.message}`);
  }
}

main().catch((e) => {
  console.error("\n" + (e?.stack ?? e));
  process.exit(1);
});
