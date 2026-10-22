/**
 * Deploy the Men's Relaxed Fit T-Shirts size guide (owner 2026-10-22): the new
 * snippet, its router entry and the product page's list of guide types. The
 * live copies of the two edited files are saved to theme/backups first.
 *
 *   node scripts/deploy-relaxed-tee-guide.mjs            # dry run
 *   node scripts/deploy-relaxed-tee-guide.mjs --write
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");
function env(key) {
  for (const f of [".env.coolify.local", ".env.local"]) {
    const p = path.join(ROOT, f);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    if (m) return m[1].trim();
  }
  return "";
}
const SHOP = env("SHOPIFY_SHOP_DOMAIN");
const TOKEN = env("SHOPIFY_ADMIN_ACCESS_TOKEN");
async function gql(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/2026-07/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}
const FILES = ["snippets/carbon-size-guide-mens-tshirt-relaxed.liquid", "snippets/carbon-size-guide-router.liquid", "snippets/product-information.liquid"];
const theme = (await gql(`{ themes(first: 5, roles: [MAIN]) { nodes { id name role } } }`)).themes.nodes[0];
console.log(`theme: ${theme.name} (${theme.role})`);
const read = async (f) => (await gql(
  `query($id:ID!,$f:[String!]){ theme(id:$id){ files(filenames:$f, first:10){ nodes{ filename body{ ... on OnlineStoreThemeFileBodyText{content} } } } } }`,
  { id: theme.id, f },
)).theme.files.nodes;
const live = new Map((await read(FILES)).map((n) => [n.filename, n.body.content]));
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
for (const f of FILES) {
  const local = readFileSync(path.join(ROOT, "theme", f), "utf8");
  console.log(`  ${f}: ${live.has(f) ? (live.get(f) === local ? "same as live" : "differs from live") : "new"}`);
  if (WRITE && live.has(f) && live.get(f) !== local) writeFileSync(path.join(ROOT, `theme/backups/${path.basename(f, ".liquid")}.PRE-RELAXED-TEE-${stamp}.liquid`), live.get(f));
}
if (!WRITE) { console.log("dry run — re-run with --write"); process.exit(0); }
const up = await gql(
  `mutation($id:ID!,$files:[OnlineStoreThemeFilesUpsertFileInput!]!){ themeFilesUpsert(themeId:$id, files:$files){ upsertedThemeFiles{ filename } userErrors{ filename message } } }`,
  { id: theme.id, files: FILES.map((f) => ({ filename: f, body: { type: "TEXT", value: readFileSync(path.join(ROOT, "theme", f), "utf8") } })) },
);
if (up.themeFilesUpsert.userErrors.length) throw new Error(JSON.stringify(up.themeFilesUpsert.userErrors));
const back = new Map((await read(FILES)).map((n) => [n.filename, n.body.content]));
for (const f of FILES) console.log(`read back ${f}: ${back.get(f) === readFileSync(path.join(ROOT, "theme", f), "utf8") ? "matches" : "DIFFERS"}`);
