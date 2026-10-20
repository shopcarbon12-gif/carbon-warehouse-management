/**
 * Deploy Carbon Shield's storefront snippet to the LIVE theme.
 *
 * Uploads theme/snippets/carbon-shield.liquid and renders it as the very first
 * thing inside <head> of layout/theme.liquid (it must run before the pixels).
 * Saves a copy of the current layout to theme/backups/ before changing it.
 * Idempotent: re-running replaces the snippet body; the layout is touched only
 * when the render tag is missing.
 *
 *   node scripts/deploy-carbon-shield.mjs                # dry run
 *   node scripts/deploy-carbon-shield.mjs --write
 *   node scripts/deploy-carbon-shield.mjs --remove --write   # take it out again
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");
const REMOVE = process.argv.includes("--remove");
const RENDER = "{% render 'carbon-shield' %}";
const SNIPPET = "snippets/carbon-shield.liquid";

function env(key) {
  for (const f of [".env.coolify.local", ".env.local"]) {
    const p = path.join(ROOT, f);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
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

const themes = await gql(`{ themes(first: 20, roles: [MAIN]) { nodes { id name role } } }`);
const main = themes.themes.nodes[0];
if (!main) throw new Error("No live (MAIN) theme found");
console.log(`live theme: ${main.name} (${main.id})`);

const files = await gql(
  `query($id:ID!,$f:[String!]){ theme(id:$id){ files(filenames:$f, first:5){
     nodes{ filename body{ ... on OnlineStoreThemeFileBodyText{content} } } } } }`,
  { id: main.id, f: ["layout/theme.liquid"] },
);
const layout = files.theme.files.nodes[0]?.body?.content;
if (!layout) throw new Error("layout/theme.liquid not found");

let nextLayout = layout;
if (REMOVE) {
  nextLayout = layout.replace(`\n  ${RENDER}`, "").replace(RENDER, "");
} else if (!layout.includes(RENDER)) {
  const m = /<head[^>]*>/i.exec(layout);
  if (!m) throw new Error("layout/theme.liquid has no <head>");
  const at = m.index + m[0].length;
  nextLayout = layout.slice(0, at) + `\n  ${RENDER}` + layout.slice(at);
}
const layoutChanged = nextLayout !== layout;
console.log(
  REMOVE
    ? layoutChanged ? "render tag: will be removed" : "render tag: not present"
    : layoutChanged ? "render tag: will be added right after <head>" : "render tag: already present",
);

const upserts = [];
if (!REMOVE) upserts.push({ filename: SNIPPET, body: { type: "TEXT", value: readFileSync(path.join(ROOT, "theme", SNIPPET), "utf8") } });
if (layoutChanged) upserts.push({ filename: "layout/theme.liquid", body: { type: "TEXT", value: nextLayout } });

if (!WRITE) {
  console.log(`\nDRY RUN — would upload: ${upserts.map((u) => u.filename).join(", ") || "nothing"}`);
  process.exit(0);
}
if (layoutChanged) {
  const dir = path.join(ROOT, "theme", "backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const file = path.join(dir, `theme.PRE-CARBON-SHIELD-${REMOVE ? "REMOVE-" : ""}${stamp}.liquid`);
  writeFileSync(file, layout);
  console.log(`backup: ${path.relative(ROOT, file)}`);
}
if (!upserts.length) process.exit(0);
const res = await gql(
  `mutation($id:ID!,$f:[OnlineStoreThemeFilesUpsertFileInput!]!){
     themeFilesUpsert(themeId:$id, files:$f){ upsertedThemeFiles{ filename } userErrors{ filename message } } }`,
  { id: main.id, f: upserts },
);
const out = res.themeFilesUpsert;
console.log("uploaded:", out.upsertedThemeFiles.map((f) => f.filename).join(", "));
if (out.userErrors.length) {
  console.log("errors:", JSON.stringify(out.userErrors));
  process.exit(1);
}
