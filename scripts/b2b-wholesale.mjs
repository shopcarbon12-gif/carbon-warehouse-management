#!/usr/bin/env node
/**
 * Shopify B2B wholesale — the admin side (owner's rules, 2026-11-03).
 *
 *   - Price: wholesale = retail / 2.1 (a $100 jean is $47.62). Stored as one
 *     price list with a percentage decrease of (1 - 1/2.1), so every product —
 *     including ones added later — follows the formula without per-variant prices.
 *   - Payment: at checkout (no payment terms, no draft review), so a wholesale
 *     order fires orders/paid like a retail one and the WMS takes the stock.
 *   - Minimum (owner 2026-11-07): 3 runs PER ORDER, mixed any way — one run of
 *     one item/colour, one of another colour, one of another item. A run is one
 *     of every size of a colour. Shopify quantity rules are per variant and can't
 *     express that, so the theme enforces it (order grid + cart); `rules` clears
 *     the old per-variant min-3 rules so a single run can go in the cart.
 *   - Catalog (owner 2026-11-07): every CLOTHING product — any status, active,
 *     draft or archived (status is left as it is) — with at least one full run in
 *     stock: one colour where every size has stock ≥ 1 (a one-size colour's run is
 *     3 pieces, so it needs 3). No shoes, no accessories
 *     (sunglasses, belts, jewellery, hats, socks, tights…). `fill` lists the
 *     changes; `fill --apply` makes them (adds new, removes ones that no longer
 *     qualify).
 *   - Market: our plan (Grow) can't attach a catalog to a company directly
 *     (Plus only) — it goes through a B2B market. The "Wholesale" market covers
 *     ALL company locations, so every company the owner approves gets the
 *     catalog with no further step. Grow allows 3 catalog-to-market assignments.
 *   - Tax (owner 2026-11-03): no sales tax on wholesale — company to company,
 *     the buyer resells. Every company location is tax-exempt (`tax`; the WMS
 *     Approve button sets it on new companies).
 *   - Shipping (owner 2026-11-03): not charged at checkout — invoiced separately.
 *     A free-shipping discount limited to the Wholesale market (`shipping`) —
 *     blocked until Shopify support enables B2B discounts for the shop.
 *
 * Every step finds what already exists by name first, so re-running is safe.
 *
 * Usage:
 *   node scripts/b2b-wholesale.mjs setup   # market, catalog, price list
 *   node scripts/b2b-wholesale.mjs fill [--apply]  # clothing with a full run in stock → catalog
 *   node scripts/b2b-wholesale.mjs rules   # clear per-variant quantity rules (3 runs/order is in the theme)
 *   node scripts/b2b-wholesale.mjs tax      # every company location tax-exempt
 *   node scripts/b2b-wholesale.mjs shipping # free-shipping discount, Wholesale market only (needs B2B discounts on)
 *   node scripts/b2b-wholesale.mjs status
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CATALOG_TITLE = "Wholesale";
const PRICE_LIST_NAME = "Wholesale (retail ÷ 2.1)";
const DIVISOR = 2.1;
const DECREASE_PERCENT = Number(((1 - 1 / DIVISOR) * 100).toFixed(6)); // 52.380952
const MARKET_NAME = "Wholesale";
const SHIPPING_DISCOUNT_TITLE = "Shipping billed separately after packing";

function loadEnv() {
  const out = {};
  for (const f of [".env.local", ".env.agent-secrets", ".env"]) {
    const p = path.join(ROOT, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !out[m[1]]) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}
const env = loadEnv();

async function gql(query, variables = {}) {
  for (let a = 0; a < 8; a++) {
    const res = await fetch(`https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/2026-07/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors?.some((e) => e?.extensions?.code === "THROTTLED")) {
      await new Promise((r) => setTimeout(r, 1500 * (a + 1)));
      continue;
    }
    if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 500));
    return json.data;
  }
  throw new Error("throttled");
}

function check(payload, label) {
  const errs = payload?.userErrors ?? [];
  if (errs.length) throw new Error(`${label}: ${JSON.stringify(errs)}`);
  return payload;
}

const CATALOG_FIELDS = `id title status
  priceList { id name parent { adjustment { type value } } }
  publication { id }`;

// Read through the market rather than catalogs(query:) — the search index lags
// a freshly created catalog by minutes.
async function findCatalog() {
  const market = await findMarket();
  if (!market) return null;
  const d = await gql(
    `query($id:ID!){ market(id:$id){ catalogs(first:10){ nodes { ${CATALOG_FIELDS} } } } }`,
    { id: market.id },
  );
  // The owner may rename the catalog in admin (it became "B2B"), so the
  // wholesale price list identifies it first and the title is only a fallback.
  const catalogs = d.market.catalogs.nodes;
  return (
    catalogs.find((c) => c.priceList?.name === PRICE_LIST_NAME) ??
    catalogs.find((c) => c.title === CATALOG_TITLE) ??
    null
  );
}

async function findMarket() {
  const d = await gql(`{ markets(first:25){ nodes { id name status conditions { conditionTypes } } } }`);
  return d.markets.nodes.find((m) => m.name === MARKET_NAME) ?? null;
}

async function ensureMarket() {
  const existing = await findMarket();
  if (existing) return existing;
  const d = await gql(
    `mutation($input: MarketCreateInput!){ marketCreate(input:$input){ market { id name status } userErrors { field message code } } }`,
    {
      input: {
        name: MARKET_NAME,
        status: "ACTIVE",
        conditions: { companyLocationsCondition: { applicationLevel: "ALL" } },
      },
    },
  );
  return check(d.marketCreate, "marketCreate").market;
}

async function setup() {
  const market = await ensureMarket();
  console.log(`market: ${market.name} (${market.id}) ${market.status}`);

  let catalog = await findCatalog();
  if (!catalog) {
    const c = await gql(
      `mutation($input: CatalogCreateInput!){ catalogCreate(input:$input){ catalog { id title } userErrors { field message } } }`,
      { input: { title: CATALOG_TITLE, status: "ACTIVE", context: { marketIds: [market.id] } } },
    );
    const created = check(c.catalogCreate, "catalogCreate").catalog;
    console.log(`catalog created: ${created.id}`);
    catalog = await findCatalog();
  }

  if (!catalog.priceList) {
    const p = await gql(
      `mutation($input: PriceListCreateInput!){ priceListCreate(input:$input){ priceList { id name } userErrors { field message } } }`,
      {
        input: {
          name: PRICE_LIST_NAME,
          currency: "USD",
          catalogId: catalog.id,
          parent: { adjustment: { type: "PERCENTAGE_DECREASE", value: DECREASE_PERCENT } },
        },
      },
    );
    check(p.priceListCreate, "priceListCreate");
    console.log(`price list created: ${PRICE_LIST_NAME} (-${DECREASE_PERCENT}%)`);
  }

  if (!catalog.publication) {
    // EMPTY: the owner chooses the wholesale products; autoPublish off so new
    // retail products do not appear to wholesale buyers on their own.
    const p = await gql(
      `mutation($input: PublicationCreateInput!){ publicationCreate(input:$input){ publication { id } userErrors { field message } } }`,
      { input: { catalogId: catalog.id, defaultState: "EMPTY", autoPublish: false } },
    );
    check(p.publicationCreate, "publicationCreate");
    console.log("publication created (empty)");
  }

  await status();
}

async function rules() {
  const catalog = await findCatalog();
  if (!catalog?.priceList || !catalog.publication) throw new Error("run setup first");
  // The minimum is 3 runs per ORDER now (theme), so the old min-3-per-variant
  // rules would wrongly block a single run of an item — clear them all.
  const ids = [];
  let after = null;
  for (;;) {
    const d = await gql(
      `query($id:ID!, $after:String){ priceList(id:$id){ quantityRules(first:250, after:$after){
         pageInfo { hasNextPage endCursor } nodes { originType minimum productVariant { id } } } } }`,
      { id: catalog.priceList.id, after },
    );
    const page = d.priceList.quantityRules;
    // The list also returns Shopify's implicit default (min 1) for every
    // catalog variant; only FIXED rules were set by us and can be deleted.
    for (const r of page.nodes) if (r.originType === "FIXED") ids.push(r.productVariant.id);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  console.log(`${ids.length} fixed per-variant quantity rules on the wholesale price list`);
  for (let i = 0; i < ids.length; i += 250) {
    const batch = ids.slice(i, i + 250);
    const d = await gql(
      `mutation($pl:ID!, $ids:[ID!]!){ quantityRulesDelete(priceListId:$pl, variantIds:$ids){
         deletedQuantityRulesVariantIds userErrors { field message code } } }`,
      { pl: catalog.priceList.id, ids: batch },
    );
    check(d.quantityRulesDelete, "quantityRulesDelete");
    console.log(`  cleared: ${Math.min(i + 250, ids.length)}/${ids.length}`);
  }
}

// Clothing only. Product type first (ACCESSORIES / SHOES / GIFT / GENERAL are
// out), then Shopify's category must be under Clothing (socks and underwear
// count as accessories here), then a title check for the odd one filed as
// clothing. A product with no category is kept when its type is clothing.
const NOT_CLOTHING_TITLE =
  /\b(socks?|tights|belts?|sunglass(es)?|bracelets?|necklaces?|anklets?|hats?|caps?|beanies?|bags?|wallets?|rings?|earrings?|scarf|scarves|gloves?|mask|candle|cologne|perfume|gift card|tie)\b/i;
function clothingCheck(p) {
  const type = (p.productType || "").toUpperCase();
  const category = p.category?.fullName || "";
  if (/ACCESSOR|SHOE|GIFT|GENERAL/.test(type)) return `type "${p.productType}"`;
  if (category && !category.startsWith("Apparel & Accessories > Clothing >")) return `category "${category}"`;
  if (/Socks|Underwear|Undergarments|Hosiery|Tights/.test(category)) return `category "${category}"`;
  if (!category && !type) return "no type or category";
  if (NOT_CLOTHING_TITLE.test(p.title)) return "title";
  return null;
}

// A full run = one colour where every size has at least one in stock. A
// one-size colour's run is 3 pieces (owner 2026-11-07), so it needs 3.
function fullRuns(p) {
  const groups = new Map();
  for (const v of p.variants.nodes) {
    const colour = v.selectedOptions.find((o) => /colo/i.test(o.name))?.value ?? "—";
    if (!groups.has(colour)) groups.set(colour, []);
    groups.get(colour).push(v);
  }
  const out = [];
  for (const [colour, vs] of groups) {
    const per = vs.length === 1 ? 3 : 1;
    if (vs.every((v) => (v.inventoryQuantity ?? 0) >= per)) {
      out.push({ colour, runs: Math.floor(Math.min(...vs.map((v) => v.inventoryQuantity)) / per), sizes: vs.length });
    }
  }
  return out;
}

async function fill() {
  const apply = process.argv.includes("--apply");
  const catalog = await findCatalog();
  if (!catalog?.publication) throw new Error("run setup first");
  const pub = catalog.publication.id;
  const products = [];
  let after = null;
  for (;;) {
    const d = await gql(
      `query($after:String, $pub:ID!){ products(first:50, after:$after){ pageInfo { hasNextPage endCursor }
         nodes { id title handle status productType category { fullName } mediaCount { count }
           onCatalog: publishedOnPublication(publicationId:$pub)
           variants(first:100){ nodes { inventoryQuantity selectedOptions { name value } } } } } }`,
      { after, pub },
    );
    products.push(...d.products.nodes);
    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }
  const rows = products.map((p) => {
    const excluded = clothingCheck(p);
    const runs = excluded ? [] : fullRuns(p);
    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      status: p.status,
      type: p.productType,
      photos: p.mediaCount?.count ?? 0,
      excluded,
      runs,
      qualifies: !excluded && runs.length > 0,
      onCatalog: p.onCatalog,
    };
  });
  const toAdd = rows.filter((r) => r.qualifies && !r.onCatalog);
  const toRemove = rows.filter((r) => !r.qualifies && r.onCatalog);
  const byStatus = (list) => list.reduce((o, r) => ((o[r.status] = (o[r.status] || 0) + 1), o), {});
  console.log(`${products.length} products; ${rows.filter((r) => r.qualifies).length} qualify`, byStatus(rows.filter((r) => r.qualifies)));
  console.log(`add ${toAdd.length}, remove ${toRemove.length}${apply ? "" : " (dry run — pass --apply)"}`);
  for (const r of toRemove) console.log(`  remove: ${r.title} (${r.excluded ?? "no full run in stock"})`);
  const reportPath = process.env.B2B_REPORT || path.join(ROOT, ".tools", "b2b-catalog-report.json");
  writeFileSync(reportPath, JSON.stringify(rows, null, 1));
  console.log(`report: ${reportPath}`);
  if (!apply) return;
  for (let i = 0; i < toAdd.length; i += 50) {
    const d = await gql(
      `mutation($id:ID!, $input:PublicationUpdateInput!){ publicationUpdate(id:$id, input:$input){ userErrors { field message } } }`,
      { id: pub, input: { publishablesToAdd: toAdd.slice(i, i + 50).map((r) => r.id) } },
    );
    check(d.publicationUpdate, "publicationUpdate add");
    console.log(`  added: ${Math.min(i + 50, toAdd.length)}/${toAdd.length}`);
  }
  if (toRemove.length) {
    const d = await gql(
      `mutation($id:ID!, $input:PublicationUpdateInput!){ publicationUpdate(id:$id, input:$input){ userErrors { field message } } }`,
      { id: pub, input: { publishablesToRemove: toRemove.map((r) => r.id) } },
    );
    check(d.publicationUpdate, "publicationUpdate remove");
    console.log(`  removed: ${toRemove.length}`);
  }
}

async function tax() {
  let after = null;
  let changed = 0;
  let total = 0;
  for (;;) {
    const d = await gql(
      `query($after:String){ companyLocations(first:100, after:$after){
         pageInfo { hasNextPage endCursor }
         nodes { id name company { name } taxSettings { taxExempt } }
       } }`,
      { after },
    );
    for (const l of d.companyLocations.nodes) {
      total++;
      if (l.taxSettings?.taxExempt) continue;
      const r = await gql(
        `mutation($id:ID!){ companyLocationTaxSettingsUpdate(companyLocationId:$id, taxExempt:true){
           companyLocation { id } userErrors { field message } } }`,
        { id: l.id },
      );
      check(r.companyLocationTaxSettingsUpdate, `tax-exempt ${l.company.name}`);
      changed++;
      console.log(`  tax-exempt: ${l.company.name} / ${l.name}`);
    }
    if (!d.companyLocations.pageInfo.hasNextPage) break;
    after = d.companyLocations.pageInfo.endCursor;
  }
  console.log(`${total} company locations, ${changed} newly tax-exempt`);
}

async function shipping() {
  const market = await findMarket();
  if (!market) throw new Error("run setup first");
  // Market-driven shipping and B2B discounts are both off for this shop (2026-11-03:
  // "Discounts cannot be assigned to B2B markets. Contact Shopify support to enable
  // B2B discounts."). Once Shopify support switches B2B discounts on, this creates
  // the free-shipping discount for the Wholesale market only.
  const d = await gql(
    `query($q:String!){ automaticDiscountNodes(first:10, query:$q){ nodes { id automaticDiscount {
       ... on DiscountAutomaticFreeShipping { title status } } } } }`,
    { q: `title:'${SHIPPING_DISCOUNT_TITLE}'` },
  );
  const existing = d.automaticDiscountNodes.nodes.find((n) => n.automaticDiscount?.title === SHIPPING_DISCOUNT_TITLE);
  if (existing) {
    console.log(`free-shipping discount already there (${existing.automaticDiscount.status})`);
    return;
  }
  const r = await gql(
    `mutation($d: DiscountAutomaticFreeShippingInput!){ discountAutomaticFreeShippingCreate(freeShippingAutomaticDiscount:$d){
       automaticDiscountNode { id } userErrors { field message code } } }`,
    {
      d: {
        title: SHIPPING_DISCOUNT_TITLE,
        startsAt: new Date().toISOString(),
        context: { markets: { add: [market.id] } },
        destination: { all: true },
        combinesWith: { productDiscounts: true, orderDiscounts: true, shippingDiscounts: false },
      },
    },
  );
  const node = check(r.discountAutomaticFreeShippingCreate, "discountAutomaticFreeShippingCreate").automaticDiscountNode;
  console.log(`free-shipping discount created for the Wholesale market: ${node.id}`);
}

async function status() {
  const [market, catalog] = [await findMarket(), await findCatalog()];
  console.log(JSON.stringify({ market, catalog }, null, 2));
}

const cmd = process.argv[2];
const run = { setup, fill, rules, tax, shipping, status }[cmd];
if (!run) {
  console.error("usage: node scripts/b2b-wholesale.mjs setup|fill [--apply]|rules|tax|shipping|status");
  process.exit(1);
}
run().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
