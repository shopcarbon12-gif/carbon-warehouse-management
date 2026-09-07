/**
 * Convert ALL-CAPS product names to Title Case, in the WMS and in Shopify.
 *
 * Google Merchant Center flags 310 items for "Excessive capitalization
 * [title]". The storefront keeps showing caps regardless: the theme already
 * carries a `product_title_uppercase` setting (currently ON) that applies
 * `text-transform: uppercase` via CSS to product cards, the cart, the sticky
 * add-to-cart bar and the PDP title. CSS is display-only, so Google, Googlebot,
 * admin exports and screen readers all see the real Title Case text while
 * shoppers still see CAPS.
 *
 * BOTH SIDES MUST CHANGE, and the WMS is the one that matters. Shopify product
 * titles are not authored in Shopify — lib/server/shopify-publish.ts line 140
 * derives them from `matrices.description`:
 *
 *     const title = (matrix.description || variants[0]?.sku || "Untitled...").trim()
 *
 * 1,711 of 1,771 matrix descriptions are ALL CAPS, so fixing only Shopify would
 * be silently undone the next time each product is republished. The WMS is
 * converted first for that reason.
 *
 * Nothing downstream depends on the caps: Carbon POS reads `description` only
 * to label rows in its by-product report, no label or ZPL path touches it, and
 * the two toUpperCase() calls in the WMS are case-insensitive search filters
 * that keep working either way.
 *
 * CASING RULES — style codes must survive:
 *   • all-digit tokens kept as-is                    "73"      -> "73"
 *   • tokens of 1-2 letters kept uppercase           "AL" "H"  -> "AL" "H"
 *   • size tokens kept uppercase                     "XXL" "OS"
 *   • hyphenated tokens cased per part               "T-SHIRT" -> "T-Shirt"
 *   • apostrophes do not start a new word            "MEN'S"   -> "Men's"
 *   • everything else Title Case                     "DRESS"   -> "Dress"
 *
 * Usage:
 *   npx tsx scripts/titlecase-product-names.ts                  # dry run, both
 *   npx tsx scripts/titlecase-product-names.ts --apply --wms    # WMS only
 *   npx tsx scripts/titlecase-product-names.ts --apply          # WMS + Shopify
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

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

function prodDbUrl(): string {
  const p = ".env.coolify.local";
  if (!existsSync(p)) throw new Error("missing .env.coolify.local");
  const line = readFileSync(p, "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("no DATABASE_URL in .env.coolify.local");
  return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
}

/** Size / one-size tokens that stay uppercase even though they are 3+ chars. */
const KEEP_UPPER = new Set(["OS", "XS", "XXS", "XL", "XXL", "XXXL", "XXXXL", "USA", "UK", "EU", "SS", "LS", "PU"]);

/**
 * Two-letter tokens that are ENGLISH WORDS, not style codes.
 *
 * The catalog uses two-letter style codes heavily — AI(38) AB(37) AC(35)
 * AD(28) AK(22) BC(16) AE(14) AL(13) and the rest of an A-/B-prefixed
 * sequence — so a blanket "two letters means a code" rule is right far more
 * often than not. It is wrong for the graphic-tee names, which are short
 * phrases: "MY RULES", "KEEP ON MOVING", "BE YOU", "NO INTERFERENCE". Those
 * became "MY Rules", "Keep ON Moving", "BE You", "NO Interference".
 *
 * So: default two-letter tokens to uppercase, and Title Case only the words
 * below. Single letters always stay uppercase — every one in the catalog is a
 * style code (BRACELET V, NECKLACE H) or the "T" of T-SHIRT.
 */
const WORDS_2 = new Set([
  "ON", "GO", "NO", "IN", "ME", "MY", "UP", "IT", "BE", "IS", "IF",
  "AT", "TO", "OF", "OR", "SO", "AN", "AS", "BY", "WE", "HE", "DO", "US",
]);

function caseToken(tok: string): string {
  if (!tok) return tok;
  if (/^\d+$/.test(tok)) return tok;                       // pure number
  const upper = tok.toUpperCase();
  if (KEEP_UPPER.has(upper)) return upper;
  const letters = tok.replace(/[^A-Za-z]/g, "");
  if (letters.length === 1) return upper;                  // style code, or the T of T-SHIRT
  if (letters.length === 2 && !WORDS_2.has(upper)) return upper; // style code
  // capitalise first letter, lowercase the rest, but never capitalise after '
  return tok
    .toLowerCase()
    .replace(/(^|[^A-Za-z'])([a-z])/g, (_m, pre, ch) => pre + ch.toUpperCase());
}

export function titleCase(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .map((word) =>
      word
        .split("-")
        .map(caseToken)
        .join("-"),
    )
    .join(" ");
}

const isAllCaps = (s: string) => s === s.toUpperCase() && /[A-Z]/.test(s);

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const SHOP = env.SHOPIFY_SHOP_DOMAIN, TOKEN = env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const API = env.SHOPIFY_API_VERSION || "2025-01";
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
    return j.data as T;
  }
  throw new Error("throttled");
}

async function main() {
  const apply = process.argv.includes("--apply");
  const wmsOnly = process.argv.includes("--wms");
  console.log(apply ? "MODE: APPLY\n" : "MODE: DRY RUN\n");

  const outDir = join("scripts", ".titlecase");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // ---------------------------------------------------------------- WMS
  const client = new pg.Client({ connectionString: prodDbUrl(), ssl: false, connectionTimeoutMillis: 20000 });
  await client.connect();
  const { rows } = await client.query<{ id: string; description: string }>(
    `SELECT id::text, description FROM matrices WHERE description IS NOT NULL AND description <> ''`,
  );
  const wmsChanges = rows
    .map((r) => ({ id: r.id, from: r.description, to: titleCase(r.description) }))
    .filter((r) => r.from !== r.to && isAllCaps(r.from));

  console.log(`WMS matrices with a description : ${rows.length}`);
  console.log(`  ALL CAPS, would change        : ${wmsChanges.length}`);
  console.log(`\n  sample transformations:`);
  for (const c of wmsChanges.slice(0, 18)) console.log(`    ${c.from.padEnd(34)} ->  ${c.to}`);
  writeFileSync(join(outDir, `wms-${stamp}.json`), JSON.stringify(wmsChanges, null, 2));

  if (apply) {
    let ok = 0;
    for (const c of wmsChanges) {
      await client.query(`UPDATE matrices SET description = $2 WHERE id = $1::uuid`, [c.id, c.to]);
      ok++;
      if (ok % 100 === 0) process.stderr.write(`\r  WMS updated ${ok}/${wmsChanges.length}  `);
    }
    process.stderr.write("\n");
    console.log(`\n  WMS: ${ok} descriptions updated.`);
  }
  await client.end();

  if (wmsOnly) { console.log("\n--wms given; Shopify untouched."); return; }

  // ------------------------------------------------------------ SHOPIFY
  const shopRows: Array<{ id: string; from: string; to: string }> = [];
  let cursor: string | null = null;
  for (;;) {
    const d: any = await gql(
      `query($c:String){ products(first:100, after:$c, query:"status:active"){ nodes{ id title } pageInfo{ hasNextPage endCursor } } }`,
      { c: cursor },
    );
    for (const p of d.products.nodes) {
      const to = titleCase(p.title);
      if (to !== p.title && isAllCaps(p.title)) shopRows.push({ id: p.id, from: p.title, to });
    }
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
  console.log(`\nShopify active products ALL CAPS : ${shopRows.length}`);
  writeFileSync(join(outDir, `shopify-${stamp}.json`), JSON.stringify(shopRows, null, 2));
  console.log(`\nPlans written to ${outDir}/`);

  if (!apply) { console.log("\nDry run. Re-run with --apply."); return; }

  let ok = 0; const errs: string[] = [];
  for (const r of shopRows) {
    try {
      const d: any = await gql(
        `mutation($input:ProductInput!){ productUpdate(input:$input){ userErrors{ field message } } }`,
        { input: { id: r.id, title: r.to } },
      );
      const ue = d?.productUpdate?.userErrors ?? [];
      if (ue.length) errs.push(`${r.from}: ${JSON.stringify(ue)}`); else ok++;
    } catch (e: any) { errs.push(`${r.from}: ${e?.message ?? e}`); }
    if (ok % 25 === 0) process.stderr.write(`\r  Shopify updated ${ok}/${shopRows.length}  `);
  }
  process.stderr.write("\n");
  console.log(`\nShopify: ${ok} titles updated, ${errs.length} errors.`);
  for (const e of errs.slice(0, 6)) console.log(`   ${e}`);
}

main().catch((e) => { console.error("\n" + (e?.stack ?? e)); process.exit(1); });
