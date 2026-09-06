#!/usr/bin/env node
/**
 * Make every linked Shopify product title exactly match its WMS name.
 *
 * The WMS is the source of truth for product names: `matrices.description` is
 * what the console shows, and lib/server/shopify-publish.ts already uses it as
 * the Shopify title when it pushes a product. Titles can still drift — edited
 * in Shopify admin, renamed in the WMS without a re-push, or changed by a bulk
 * job on one side only — so this reconciles them.
 *
 * Only products linked by matrices.shopify_product_id are touched. Shopify
 * products with no WMS matrix have no authoritative name and are left alone;
 * they are counted and reported, never edited.
 *
 * Dry run by default. Nothing is written without --apply, and every applied
 * run first writes a JSON backup of the previous titles.
 *
 *   node scripts/sync-shopify-titles-from-wms.mjs           # report only
 *   node scripts/sync-shopify-titles-from-wms.mjs --apply   # write
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");

function loadEnv() {
  const out = {};
  for (const f of [".env.local", ".env.agent-secrets", ".env.coolify.local", ".env"]) {
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

/**
 * DATABASE_URL is read only from .env.coolify.local, never from the merged
 * env: .env.local points at a localhost dev database, and quietly comparing
 * production Shopify titles against dev rows would produce a confident,
 * completely wrong diff.
 */
function prodDatabaseUrl() {
  const p = path.join(ROOT, ".env.coolify.local");
  if (!existsSync(p)) return null;
  const line = readFileSync(p, "utf8")
    .split("\n")
    .find((l) => l.startsWith("DATABASE_URL="));
  return line ? line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "") : null;
}
const DB_URL = prodDatabaseUrl();
if (!DB_URL) {
  console.error("ABORT: DATABASE_URL not found in .env.coolify.local (production WMS database).");
  process.exit(1);
}

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

/* ---------- WMS side ---------- */
const pool = new pg.Pool({ connectionString: DB_URL, ssl: false, max: 4 });
const { rows } = await pool.query(
  `SELECT id, description, shopify_product_id
     FROM matrices
    WHERE shopify_product_id IS NOT NULL
      AND description IS NOT NULL
      AND btrim(description) <> ''`,
);
await pool.end();
console.log(`WMS matrices linked to Shopify: ${rows.length}`);

/* Shopify ids are stored bare or as gids depending on when they were written. */
const wanted = new Map();
for (const r of rows) {
  const raw = String(r.shopify_product_id).trim();
  const id = raw.startsWith("gid://") ? raw : `gid://shopify/Product/${raw}`;
  wanted.set(id, String(r.description).trim());
}

/* ---------- Shopify side ---------- */
const ids = [...wanted.keys()];
const live = new Map();
for (let i = 0; i < ids.length; i += 100) {
  const batch = ids.slice(i, i + 100);
  const d = await gql(`query($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id title } } }`, { ids: batch });
  for (const n of d.nodes) if (n && n.id) live.set(n.id, n.title);
  process.stderr.write(`\rfetched ${Math.min(i + 100, ids.length)}/${ids.length}`);
}
process.stderr.write("\n");

const missing = ids.filter((id) => !live.has(id));
const diffs = [];
for (const [id, title] of wanted) {
  const current = live.get(id);
  if (current === undefined) continue;
  if (current !== title) diffs.push({ id, from: current, to: title });
}

console.log(`resolved in Shopify:        ${live.size}`);
console.log(`linked but gone from Shopify: ${missing.length}`);
console.log(`titles already correct:     ${live.size - diffs.length}`);
console.log(`titles to change:           ${diffs.length}`);

if (diffs.length) {
  console.log("\nsample (up to 15):");
  for (const d of diffs.slice(0, 15)) {
    console.log(`  ${d.id.split("/").pop()}`);
    console.log(`    shopify: ${JSON.stringify(d.from)}`);
    console.log(`    wms    : ${JSON.stringify(d.to)}`);
  }
}

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply to sync.");
  process.exit(0);
}
if (!diffs.length) {
  console.log("\nNothing to do.");
  process.exit(0);
}

const dir = path.join(ROOT, "scripts", ".title-sync");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(dir, `titles-before-${stamp}.json`);
writeFileSync(backup, JSON.stringify(diffs, null, 2));
console.log(`\nbackup of previous titles: ${backup}`);

let done = 0;
const failures = [];
const CONCURRENCY = 4;
const queue = diffs.slice();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      try {
        const r = await gql(
          `mutation($p:ProductUpdateInput!){ productUpdate(product:$p){ product{ id title } userErrors{ field message } } }`,
          { p: { id: job.id, title: job.to } },
        );
        const errs = r.productUpdate?.userErrors || [];
        if (errs.length) failures.push({ id: job.id, message: errs[0].message });
        else done++;
      } catch (e) {
        failures.push({ id: job.id, message: String(e.message).slice(0, 120) });
      }
      process.stderr.write(`\rupdated ${done}/${diffs.length}`);
    }
  }),
);
process.stderr.write("\n");
console.log(`updated: ${done}`);
if (failures.length) {
  console.log(`failures: ${failures.length}`);
  for (const f of failures.slice(0, 10)) console.log(`  ${f.id}: ${f.message}`);
}
