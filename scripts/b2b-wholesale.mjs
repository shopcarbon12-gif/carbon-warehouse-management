#!/usr/bin/env node
/**
 * Shopify B2B wholesale — the admin side (owner's rules, 2026-11-03).
 *
 *   - Price: wholesale = retail / 2.1 (a $100 jean is $47.62). Stored as one
 *     price list with a percentage decrease of (1 - 1/2.1), so every product —
 *     including ones added later — follows the formula without per-variant prices.
 *   - Payment: at checkout (no payment terms, no draft review), so a wholesale
 *     order fires orders/paid like a retail one and the WMS takes the stock.
 *   - Minimum: 3 runs of each colour ordered. The theme's order grid adds whole
 *     runs; the quantity rule here (min 3 per variant) stops the cart going under.
 *   - Catalog: a separate "Wholesale" catalog the owner fills by hand
 *     (Products → Catalogs → Wholesale). It starts empty.
 *   - Market: our plan (Grow) can't attach a catalog to a company directly
 *     (Plus only) — it goes through a B2B market. The "Wholesale" market covers
 *     ALL company locations, so every company the owner approves gets the
 *     catalog with no further step. Grow allows 3 catalog-to-market assignments.
 *
 * Every step finds what already exists by name first, so re-running is safe.
 *
 * Usage:
 *   node scripts/b2b-wholesale.mjs setup   # price list, catalog, test company
 *   node scripts/b2b-wholesale.mjs rules   # min-3 rule on every variant in the catalog
 *   node scripts/b2b-wholesale.mjs status
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CATALOG_TITLE = "Wholesale";
const PRICE_LIST_NAME = "Wholesale (retail ÷ 2.1)";
const DIVISOR = 2.1;
const DECREASE_PERCENT = Number(((1 - 1 / DIVISOR) * 100).toFixed(6)); // 52.380952
const MIN_PER_VARIANT = 3;
const TEST_COMPANY = "Carbon Wholesale TEST";
const MARKET_NAME = "Wholesale";

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
  return d.market.catalogs.nodes.find((c) => c.title === CATALOG_TITLE) ?? null;
}

async function findCompany() {
  const d = await gql(
    `query($q:String!){ companies(first:5, query:$q){ nodes { id name locations(first:5){ nodes { id name } } } } }`,
    { q: `name:'${TEST_COMPANY}'` },
  );
  return d.companies.nodes.find((c) => c.name === TEST_COMPANY) ?? null;
}

async function ensureCompany() {
  const existing = await findCompany();
  if (existing) return existing;
  const d = await gql(
    `mutation($input: CompanyCreateInput!){ companyCreate(input:$input){
       company { id name locations(first:5){ nodes { id name } } } userErrors { field message } } }`,
    {
      input: {
        company: {
          name: TEST_COMPANY,
          note: "Test buyer for the wholesale theme. Add a contact you can log in as; delete when done.",
        },
        companyLocation: {
          name: "Test location",
          billingSameAsShipping: true,
          shippingAddress: {
            address1: "TEST",
            city: "Miami",
            zoneCode: "FL",
            countryCode: "US",
            zip: "33101",
          },
          // Pay at checkout: no payment terms, and orders are not held as drafts.
          buyerExperienceConfiguration: { checkoutToDraft: false, editableShippingAddress: true },
        },
      },
    },
  );
  return check(d.companyCreate, "companyCreate").company;
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
  const company = await ensureCompany();
  console.log(`company: ${company.name} (${company.id})`);
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

async function catalogVariantIds(catalog) {
  const ids = [];
  let after = null;
  for (;;) {
    const d = await gql(
      `query($id:ID!, $after:String){ publication(id:$id){ products(first:50, after:$after){
         pageInfo { hasNextPage endCursor }
         nodes { variants(first:100){ nodes { id } } }
       } } }`,
      { id: catalog.publication.id, after },
    );
    const page = d.publication.products;
    for (const p of page.nodes) for (const v of p.variants.nodes) ids.push(v.id);
    if (!page.pageInfo.hasNextPage) return ids;
    after = page.pageInfo.endCursor;
  }
}

async function rules() {
  const catalog = await findCatalog();
  if (!catalog?.priceList || !catalog.publication) throw new Error("run setup first");
  const ids = await catalogVariantIds(catalog);
  console.log(`${ids.length} variants in the Wholesale catalog`);
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const d = await gql(
      `mutation($pl:ID!, $rules:[QuantityRuleInput!]!){ quantityRulesAdd(priceListId:$pl, quantityRules:$rules){
         quantityRules { minimum } userErrors { field message code } } }`,
      {
        pl: catalog.priceList.id,
        rules: batch.map((variantId) => ({ variantId, minimum: MIN_PER_VARIANT, increment: 1 })),
      },
    );
    check(d.quantityRulesAdd, "quantityRulesAdd");
    console.log(`  rules set: ${Math.min(i + 100, ids.length)}/${ids.length}`);
  }
}

async function status() {
  const [market, catalog, company] = [await findMarket(), await findCatalog(), await findCompany()];
  console.log(JSON.stringify({ market, catalog, company }, null, 2));
}

const cmd = process.argv[2];
const run = { setup, rules, status }[cmd];
if (!run) {
  console.error("usage: node scripts/b2b-wholesale.mjs setup|rules|status");
  process.exit(1);
}
run().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
