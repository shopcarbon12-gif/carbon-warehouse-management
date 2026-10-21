/**
 * Deploy the Men's Slim Fit Denim Shorts size guide (John Denim Shorts) to the
 * live theme: the snippet and its measuring pictures. Owner's package,
 * 2026-10-20. The live snippet is saved to theme/backups first.
 *
 *   node scripts/deploy-slim-shorts-guide.mjs            # dry run
 *   node scripts/deploy-slim-shorts-guide.mjs --write
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

const SNIPPET = "snippets/carbon-size-guide-mens-slim-shorts.liquid";
/* Jeans-style guide (owner, 2026-10-20): three photos of the real John Denim Shorts. */
const IMAGES = ["waist", "hip", "inseam"].map((k) => `assets/carbon-denim-shorts-john-${k}.webp`);

const theme = (await gql(`{ themes(first: 5, roles: [MAIN]) { nodes { id name role } } }`)).themes.nodes[0];
console.log(`theme: ${theme.name} (${theme.role}) ${theme.id}`);

const live = await gql(
  `query($id:ID!,$f:[String!]){ theme(id:$id){ files(filenames:$f, first:20){ nodes{ filename size body{ ... on OnlineStoreThemeFileBodyText{content} } } } } }`,
  { id: theme.id, f: [SNIPPET, ...IMAGES, "assets/carbon-size-guide-tape-icon.png"] },
);
const have = new Map(live.theme.files.nodes.map((n) => [n.filename, n]));
for (const f of [SNIPPET, ...IMAGES, "assets/carbon-size-guide-tape-icon.png"]) console.log(`  live ${have.has(f) ? "has" : "lacks"} ${f}`);

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const prev = have.get(SNIPPET)?.body?.content;
if (prev && WRITE) {
  const bak = path.join(ROOT, `theme/backups/carbon-size-guide-mens-slim-shorts.PRE-JEANS-STYLE-${stamp}.liquid`);
  writeFileSync(bak, prev);
  console.log(`backup: ${path.relative(ROOT, bak)}`);
}

const files = [
  { filename: SNIPPET, body: { type: "TEXT", value: readFileSync(path.join(ROOT, "theme", SNIPPET), "utf8") } },
  ...IMAGES.map((f) => ({ filename: f, body: { type: "BASE64", value: readFileSync(path.join(ROOT, "theme", f)).toString("base64") } })),
];
if (!WRITE) {
  console.log(`dry run — would upload ${files.length} files. Re-run with --write.`);
  process.exit(0);
}
const up = await gql(
  `mutation($id:ID!,$files:[OnlineStoreThemeFilesUpsertFileInput!]!){ themeFilesUpsert(themeId:$id, files:$files){
     upsertedThemeFiles{ filename } userErrors{ filename message } } }`,
  { id: theme.id, files },
);
const errs = up.themeFilesUpsert.userErrors;
if (errs.length) throw new Error(JSON.stringify(errs));
console.log(`uploaded: ${up.themeFilesUpsert.upsertedThemeFiles.map((f) => f.filename).join(", ")}`);

const back = await gql(
  `query($id:ID!,$f:[String!]){ theme(id:$id){ files(filenames:$f, first:20){ nodes{ filename size body{ ... on OnlineStoreThemeFileBodyText{content} } } } } }`,
  { id: theme.id, f: [SNIPPET, ...IMAGES] },
);
const ok = back.theme.files.nodes.find((n) => n.filename === SNIPPET)?.body?.content === files[0].body.value;
console.log(`read back: snippet ${ok ? "matches" : "DIFFERS"}; images present ${back.theme.files.nodes.filter((n) => n.filename.endsWith(".webp")).length}/${IMAGES.length}`);
