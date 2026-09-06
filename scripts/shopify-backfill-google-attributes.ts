/**
 * Fix the Google Shopping attributes that are demoting almost the whole catalog.
 *
 * Merchant Center (account 779385360) reports, for the US alone:
 *     7,842 demoted — missing age group
 *     7,835 demoted — missing gender
 *     4,709 demoted — missing color
 *     4,622 demoted — missing size
 * against 8,263 active items. "Demoted" is not a rejection: the listing stays
 * live but ranks below competitors, so it is invisible suppression.
 *
 * ORDER MATTERS. Writing shopify.target-gender / shopify.age-group directly
 * fails with "Owner subtype does not match the metafield definition's
 * constraints" — those standard taxonomy metafields are scoped to a product
 * CATEGORY, so a product with no category cannot carry them. 537 of the 758
 * active products have no category. So this script runs in two passes:
 *     pass 1  assign the Shopify Standard Product Taxonomy category
 *     pass 2  write gender + age group, now that they are permitted
 * Colour and size then flow from the Color/Size variant options automatically
 * once the category is present.
 *
 * CATEGORY comes from the store's own productType ("MEN >> JEANS"), mapped to
 * taxonomy IDs looked up live from Shopify's taxonomy — NOT inferred from the
 * products that already have one. That inference was tried and rejected: the
 * existing data maps MEN >> SHORTS to "Outfit Sets" (3 samples) and
 * WOMEN >> BLOUSE to "Bodysuits" (1 sample), so propagating it would have
 * misfiled ~500 products into the wrong Google shopping verticals.
 *
 * Accessories are a mixed bucket (belts, bracelets, necklaces, sunglasses,
 * hats, socks, anklets) that productType cannot separate, so they are split on
 * title keyword per the owner's instruction.
 *
 * GENDER comes from the barcode, per the owner's rule: leading "1" is male,
 * leading "2" is female. Verified before writing — all 4,981 barcoded variants
 * start with 1 or 2, and the digit agrees with the MEN>>/WOMEN>> productType on
 * every item but JORDAN SUNGLASSES (barcode 1721918, typed WOMEN >>
 * ACCESSORIES). The barcode wins, as instructed.
 *
 * AGE GROUP is "Adults" throughout — there is no kidswear in the catalog.
 *
 * Gaps only: anything already carrying a category or an attribute is untouched.
 *
 * Usage:
 *   npx tsx scripts/shopify-backfill-google-attributes.ts             # dry run
 *   npx tsx scripts/shopify-backfill-google-attributes.ts --apply --limit 5
 *   npx tsx scripts/shopify-backfill-google-attributes.ts --apply
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
if (!SHOP || !TOKEN) { console.error("Missing Shopify env."); process.exit(1); }

const T = (id: string) => `gid://shopify/TaxonomyCategory/${id}`;

/** Shopify taxonomy metaobjects for this shop, resolved 2026-09-05. */
const GENDER_MALE = "gid://shopify/Metaobject/131973546236";
const GENDER_FEMALE = "gid://shopify/Metaobject/131978494204";
const AGE_ADULTS = "gid://shopify/Metaobject/131978690812";

/** Title keywords for the accessories bucket — checked before productType. */
const TITLE_CATEGORY: Array<[RegExp, string]> = [
  [/BRACELET/i, T("aa-6-3")],   // Jewelry > Bracelets
  [/NECKLACE|\bCHAIN\b/i, T("aa-6-8")],   // Jewelry > Necklaces
  [/ANKLET/i, T("aa-6-1")],   // Jewelry > Anklets
  [/EARRING/i, T("aa-6-6")],   // Jewelry > Earrings
  [/SUNGLASS/i, T("aa-2-27")],  // Clothing Accessories > Sunglasses
  [/\bBELT\b/i, T("aa-2-6")],   // Clothing Accessories > Belts
  [/\bHAT\b|\bCAP\b|BEANIE/i, T("aa-2-17")],  // Clothing Accessories > Hats
  [/\bSOCKS?\b/i, T("aa-1-18")],  // Clothing > Socks
  [/BOXER|BRIEF|UNDERWEAR/i, T("aa-1-8-3")], // Men's Undergarments > Underwear
];

/** productType -> taxonomy category. Keys are normalised (upper, single-spaced). */
const TYPE_CATEGORY: Record<string, string> = {
  // bottoms
  "MEN >> JEANS": T("aa-1-12-4"), "WOMEN >> JEANS": T("aa-1-12-4"), "JEANS": T("aa-1-12-4"),
  "MEN >> PANTS": T("aa-1-12-11"), "WOMEN >> PANTS": T("aa-1-12-11"),
  "MEN >> EVENING PANTS": T("aa-1-12-11"),
  "MEN >> SWEATPANTS": T("aa-1-1-1-4"), "WOMEN >> SWEATPANTS": T("aa-1-1-1-4"),
  "WOMEN >> LEGGING": T("aa-1-12"),
  "MEN >> SHORTS": T("aa-1-14"), "WOMEN >> SHORTS": T("aa-1-14"), "SHORTS": T("aa-1-14"),
  "WOMEN >> SKIRT": T("aa-1-15"),
  // tops
  "MEN >> T-SHIRT": T("aa-1-13-8"), "MEN >> T- SHIRT": T("aa-1-13-8"),
  "WOMEN >> T-SHIRT": T("aa-1-13-8"), "T-SHIRT": T("aa-1-13-8"), "WOMEN >> TEES": T("aa-1-13-8"),
  "MEN >> SHIRTS": T("aa-1-13-7"), "MEN >> BUTTON SHIRT": T("aa-1-13-7"),
  "MEN >> DENIM SHIRT": T("aa-1-13-7"),
  "WOMEN >> BLOUSE": T("aa-1-13-1"),
  "MEN >> TOP": T("aa-1-13"), "WOMEN >> TOP": T("aa-1-13"), "WOMEN >> TOPS": T("aa-1-13"),
  "MEN >> TANK TOP": T("aa-1-13-9"),
  "WOMEN >> BODYSUIT": T("aa-1-13-2"),
  // knitwear
  "MEN >> SWEATSHIRTS": T("aa-1-13-14"), "WOMEN >> SWEATSHIRTS": T("aa-1-13-14"),
  "WOMEN >> SWEATSHIRT": T("aa-1-13-14"), "SWEATSHIRTS": T("aa-1-13-14"),
  "WOMEN >> HOODIE": T("aa-1-13-14"), "MEN >> SWEATER": T("aa-1-13-12"),
  // outerwear
  "MEN >> JACKET": T("aa-1-10-2"), "WOMEN >> JACKET": T("aa-1-10-2"),
  "MEN >> DENIM JACKET": T("aa-1-10-2"), "MEN >> COAT": T("aa-1-10-2"),
  "WOMEN >> COAT": T("aa-1-10-2"), "JACKET": T("aa-1-10-2"),
  "MEN >> VEST": T("aa-1-10-6"), "WOMEN >> VEST": T("aa-1-10-6"),
  // one-pieces & sets
  "WOMEN >> DRESS": T("aa-1-4"), "DRESS": T("aa-1-4"),
  "WOMEN >> ROMPER": T("aa-1-9"), "MEN >> OVERALL": T("aa-1-9"),
  "WOMEN >> SET": T("aa-1-11"),
  // swim
  "MEN >> SWIMWEAR": T("aa-1-20"), "WOMEN >> SWIMSUIT": T("aa-1-20"),
  // footwear
  "MEN >> SHOES": T("aa-8"), "WOMEN >> SHOES": T("aa-8"),
};

async function gql<T2>(query: string, variables: Record<string, unknown> = {}): Promise<T2> {
  for (let a = 0; a < 10; a++) {
    const res = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const j: any = await res.json();
    if (j.errors?.some((e: any) => e?.extensions?.code === "THROTTLED")) {
      await new Promise((r) => setTimeout(r, 2000 * (a + 1))); continue;
    }
    if (j.errors) throw new Error(JSON.stringify(j.errors, null, 2));
    return j.data as T2;
  }
  throw new Error("throttled");
}

const SCAN = /* GraphQL */ `
  query ($cursor: String) {
    products(first: 50, after: $cursor, query: "status:active") {
      nodes {
        id title productType
        category { id fullName }
        variants(first: 100) { nodes { barcode } }
        gender: metafield(namespace: "shopify", key: "target-gender") { value }
        age: metafield(namespace: "shopify", key: "age-group") { value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const UPDATE = /* GraphQL */ `
  mutation ($input: ProductInput!) {
    productUpdate(input: $input) { product { id category { fullName } } userErrors { field message } }
  }
`;
const SET = /* GraphQL */ `
  mutation ($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { key } userErrors { field message code } }
  }
`;

const norm = (s: string) => (s || "").toUpperCase().replace(/\s+/g, " ").trim();

function categoryFor(title: string, type: string): string | null {
  for (const [re, id] of TITLE_CATEGORY) if (re.test(title)) return id;
  const k = norm(type);
  return TYPE_CATEGORY[k] ?? null;
}

type Row = {
  id: string; title: string; type: string;
  newCategory: string | null; hasCategory: boolean;
  gender: "male" | "female" | null; needGender: boolean; needAge: boolean;
};

async function main() {
  const apply = process.argv.includes("--apply");
  const li = process.argv.indexOf("--limit");
  const limit = li >= 0 ? Number(process.argv[li + 1]) : Infinity;
  console.log(`Shop: ${SHOP}`);
  console.log(apply ? "MODE: APPLY\n" : "MODE: DRY RUN\n");

  const rows: Row[] = [];
  let cursor: string | null = null, scanned = 0, unmapped = new Map<string, number>();

  for (;;) {
    const d: any = await gql(SCAN, { cursor });
    for (const p of d.products.nodes) {
      scanned++;
      let ones = 0, twos = 0;
      for (const v of p.variants.nodes) {
        const b = (v.barcode || "").trim();
        if (b.startsWith("1")) ones++; else if (b.startsWith("2")) twos++;
      }
      const gender: "male" | "female" | null = (ones || twos) ? (ones >= twos ? "male" : "female") : null;
      const hasCategory = !!p.category?.id && p.category.fullName !== "Uncategorized";
      const mapped = categoryFor(p.title, p.productType || "");
      if (!hasCategory && !mapped) {
        const k = p.productType || "(blank)";
        unmapped.set(k, (unmapped.get(k) || 0) + 1);
      }
      rows.push({
        id: p.id, title: p.title, type: p.productType || "",
        newCategory: hasCategory ? null : mapped, hasCategory,
        gender, needGender: gender !== null && !p.gender?.value, needAge: !p.age?.value,
      });
    }
    process.stderr.write(`\rscanned ${scanned}  `);
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
  process.stderr.write("\n");

  const needCat = rows.filter((r) => r.newCategory).slice(0, limit);
  const needAttr = rows.filter((r) => r.needGender || r.needAge).slice(0, limit);

  console.log(`\nActive products                 : ${scanned}`);
  console.log(`  already categorised           : ${rows.filter((r) => r.hasCategory).length}`);
  console.log(`  category to assign            : ${rows.filter((r) => r.newCategory).length}`);
  console.log(`  still unmapped (no rule)      : ${[...unmapped.values()].reduce((a, b) => a + b, 0)}`);
  for (const [k, v] of [...unmapped.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`      ${String(v).padStart(3)}  ${k}`);
  console.log(`\n  missing gender                : ${rows.filter((r) => r.needGender).length}`);
  console.log(`  missing age group             : ${rows.filter((r) => r.needAge).length}`);
  console.log(`     male / female              : ${rows.filter((r) => r.needGender && r.gender === "male").length} / ${rows.filter((r) => r.needGender && r.gender === "female").length}`);

  const outDir = join("scripts", ".attribute-backfills");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(outDir, `plan-${stamp}.json`), JSON.stringify({ needCat, needAttr }, null, 2));
  console.log(`\nPlan -> ${join(outDir, `plan-${stamp}.json`)}`);
  if (!apply) { console.log("\nDry run. Re-run with --apply."); return; }

  // ---- pass 1: categories
  console.log(`\n== PASS 1: assigning ${needCat.length} categories ==`);
  let catOk = 0; const catErr: string[] = [];
  for (let i = 0; i < needCat.length; i++) {
    const r = needCat[i];
    try {
      const d: any = await gql(UPDATE, { input: { id: r.id, category: r.newCategory } });
      const ue = d?.productUpdate?.userErrors ?? [];
      if (ue.length) catErr.push(`${r.title}: ${JSON.stringify(ue)}`); else catOk++;
    } catch (e: any) { catErr.push(`${r.title}: ${e?.message ?? e}`); }
    if ((i + 1) % 10 === 0 || i === needCat.length - 1)
      process.stderr.write(`\r  ${i + 1}/${needCat.length} — ok ${catOk}, err ${catErr.length}  `);
  }
  process.stderr.write("\n");
  for (const e of [...new Set(catErr)].slice(0, 5)) console.log(`   ${e}`);

  // ---- pass 2: gender + age (now permitted by the category)
  const inputs: any[] = [];
  for (const r of needAttr) {
    if (r.needGender && r.gender) inputs.push({
      ownerId: r.id, namespace: "shopify", key: "target-gender",
      type: "list.metaobject_reference",
      value: JSON.stringify([r.gender === "male" ? GENDER_MALE : GENDER_FEMALE]),
    });
    if (r.needAge) inputs.push({
      ownerId: r.id, namespace: "shopify", key: "age-group",
      type: "list.metaobject_reference", value: JSON.stringify([AGE_ADULTS]),
    });
  }
  console.log(`\n== PASS 2: writing ${inputs.length} attribute metafields ==`);
  let ok = 0; const errs: string[] = [];
  for (let i = 0; i < inputs.length; i += 25) {
    try {
      const d: any = await gql(SET, { metafields: inputs.slice(i, i + 25) });
      ok += d?.metafieldsSet?.metafields?.length ?? 0;
      for (const e of d?.metafieldsSet?.userErrors ?? []) errs.push(`${e.code || ""} ${e.message}`);
    } catch (e: any) { errs.push(e?.message ?? String(e)); }
    process.stderr.write(`\r  ${ok}/${inputs.length} written, ${errs.length} errors  `);
  }
  process.stderr.write("\n");
  console.log(`\nDone. categories ${catOk}/${needCat.length}, attributes ${ok}/${inputs.length}.`);
  for (const e of [...new Set(errs)].slice(0, 8)) console.log(`   ${e}`);
}

main().catch((e) => { console.error("\n" + (e?.stack ?? e)); process.exit(1); });
