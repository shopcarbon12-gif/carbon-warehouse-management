#!/usr/bin/env node
/**
 * Put every Shopify "Size" option into wearing order.
 *
 * Shopify keeps option values in whatever order they were created, which for
 * this catalogue often means alphabetical — a size dropdown reading L, M, S
 * instead of S, M, L. This sorts them the way a shopper expects:
 *
 *   XXS  XS  XS/S  S  S/M  M  M/L  L  L/XL  XL  XXL  XXXL  4XL
 *   then numeric sizes ascending: 4 6 8 10 ... 28 29 30 ... 36 38 40 ...
 *
 * Letters sort before numbers, though in practice a product uses one or the
 * other. "OS" (one size) sorts first since it is always alone. Anything with
 * no known rank keeps its existing relative position at the end rather than
 * being moved somewhere arbitrary — an unrecognised value is a reason to leave
 * it alone, not to guess.
 *
 * Only the Size option is touched. Every other option (Color and friends) is
 * passed back in its current order, so reordering sizes can never quietly
 * rearrange anything else.
 *
 * Dry run by default; --apply writes, after saving the previous order to
 * scripts/.size-order/.
 *
 *   node scripts/sort-shopify-sizes.mjs           # report only
 *   node scripts/sort-shopify-sizes.mjs --apply   # write
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");

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
  for (let a = 0; a < 10; a++) {
    const res = await fetch(`https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/graphql.json`, {
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
    if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 400));
    return json.data;
  }
  throw new Error("throttled");
}

const LETTER = {
  OS: 1, "ONE SIZE": 1,
  XXS: 10, XS: 20, "XS/S": 25, S: 30, "S/M": 35, M: 40, "M/L": 45,
  L: 50, "L/XL": 55, XL: 60, XXL: 70, "2XL": 70, XXXL: 80, "3XL": 80,
  "4XL": 90, XXXXL: 90,
};
const UNRANKED = 1e6;

function rank(value) {
  const k = String(value).trim().toUpperCase();
  if (k in LETTER) return LETTER[k];
  if (/^\d+(\.\d+)?$/.test(k)) return 1000 + parseFloat(k);
  return UNRANKED;
}

/** Stable: equal ranks (e.g. "4" and "04") keep their original relative order. */
function sortValues(values) {
  return values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => rank(a.v.name) - rank(b.v.name) || a.i - b.i)
    .map((x) => x.v);
}

/* ---------- read ---------- */
let cursor = null;
const products = [];
for (;;) {
  const d = await gql(
    `query($c:String){ products(first:100, after:$c){
        nodes{ id title options{ id name optionValues{ id name } } }
        pageInfo{ hasNextPage endCursor } } }`,
    { c: cursor },
  );
  products.push(...d.products.nodes);
  process.stderr.write(`\rfetched ${products.length}`);
  if (!d.products.pageInfo.hasNextPage) break;
  cursor = d.products.pageInfo.endCursor;
}
process.stderr.write("\n");

const jobs = [];
const unranked = new Set();
for (const p of products) {
  const size = (p.options || []).find((o) => /^size$/i.test(o.name));
  if (!size) continue;
  for (const v of size.optionValues) if (rank(v.name) === UNRANKED) unranked.add(v.name);

  const want = sortValues(size.optionValues);
  const before = size.optionValues.map((v) => v.name);
  const after = want.map((v) => v.name);
  if (before.join("|") === after.join("|")) continue;

  jobs.push({
    id: p.id,
    title: p.title,
    before,
    after,
    /* Every option is sent back, Size resorted and the rest untouched, so this
       cannot disturb Color or any other option's order. */
    options: (p.options || []).map((o) => ({
      id: o.id,
      values: (o.id === size.id ? want : o.optionValues).map((v) => ({ id: v.id })),
    })),
  });
}

const withSize = products.filter((p) => (p.options || []).some((o) => /^size$/i.test(o.name))).length;
console.log(`products:                ${products.length}`);
console.log(`with a Size option:      ${withSize}`);
console.log(`already in order:        ${withSize - jobs.length}`);
console.log(`to reorder:              ${jobs.length}`);
console.log(`values with no rank:     ${unranked.size ? [...unranked].join(", ") : "none"}`);

if (jobs.length) {
  console.log("\nsample:");
  for (const j of jobs.slice(0, 12)) {
    console.log(`  ${j.title.slice(0, 32).padEnd(34)} ${j.before.join(",")}  ->  ${j.after.join(",")}`);
  }
}

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply to reorder.");
  process.exit(0);
}
if (!jobs.length) {
  console.log("\nNothing to do.");
  process.exit(0);
}

const dir = path.join(ROOT, "scripts", ".size-order");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(dir, `sizes-before-${stamp}.json`);
writeFileSync(backup, JSON.stringify(jobs.map(({ id, title, before, after }) => ({ id, title, before, after })), null, 2));
console.log(`\nbackup of previous order: ${backup}`);

let done = 0;
const failures = [];
const queue = jobs.slice();
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      try {
        const r = await gql(
          `mutation($productId:ID!,$options:[OptionReorderInput!]!){
             productOptionsReorder(productId:$productId, options:$options){
               userErrors{ field message } } }`,
          { productId: job.id, options: job.options },
        );
        const errs = r.productOptionsReorder?.userErrors || [];
        if (errs.length) failures.push({ title: job.title, message: errs[0].message });
        else done++;
      } catch (e) {
        failures.push({ title: job.title, message: String(e.message).slice(0, 120) });
      }
      process.stderr.write(`\rreordered ${done}/${jobs.length}`);
    }
  }),
);
process.stderr.write("\n");
console.log(`reordered: ${done}`);
if (failures.length) {
  console.log(`failures: ${failures.length}`);
  for (const f of failures.slice(0, 10)) console.log(`  ${f.title}: ${f.message}`);
}
