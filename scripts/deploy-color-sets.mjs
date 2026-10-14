/**
 * Deploy "color photo sets" to a theme: choosing a color puts that color's
 * whole photo set first on the product page (not just its one linked photo).
 *
 * Uploads theme/snippets/carbon-color-set.liquid, carbon-color-gallery.liquid
 * and theme/sections/main-product.liquid. main-product is only replaced when
 * the theme's copy is still the one this edit was made from
 * (theme/backups/main-product.PRE-COLOR-SETS-2026-10-14.liquid) or already
 * this version — anything else means someone changed it since, and the edit
 * has to be redone on top of that copy rather than overwrite it.
 *
 *   node scripts/deploy-color-sets.mjs                    # dry run, live theme
 *   node scripts/deploy-color-sets.mjs --theme <id>       # dry run, other theme
 *   node scripts/deploy-color-sets.mjs [--theme <id>] --write
 *   node scripts/deploy-color-sets.mjs [--theme <id>] --restore --write   # put the backup back
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THEME_ID = process.argv.includes("--theme")
  ? process.argv[process.argv.indexOf("--theme") + 1]
  : "166971539708";
const WRITE = process.argv.includes("--write");
const RESTORE = process.argv.includes("--restore");

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
const GID = `gid://shopify/OnlineStoreTheme/${THEME_ID}`;

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

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const local = (name) => readFileSync(path.join(ROOT, "theme", name), "utf8");

const SECTION = "sections/main-product.liquid";
const BEFORE = readFileSync(path.join(ROOT, "theme/backups/main-product.PRE-COLOR-SETS-2026-10-14.liquid"), "utf8");
const AFTER = local(SECTION);

const files = await gql(
  `query($id:ID!,$f:[String!]){ theme(id:$id){ name role files(filenames:$f, first:10){
     nodes{ filename body{ ... on OnlineStoreThemeFileBodyText{content} } } } } }`,
  { id: GID, f: [SECTION] },
);
console.log(`theme: ${files.theme.name} (${files.theme.role})`);
const remote = files.theme.files.nodes[0]?.body?.content ?? "";
const state = md5(remote) === md5(BEFORE) ? "original" : md5(remote) === md5(AFTER) ? "deployed" : "changed";
console.log(`${SECTION}: ${state}`);
if (state === "changed") {
  console.error("The theme's main-product.liquid is neither the backed-up original nor this version — not overwriting it.");
  process.exit(1);
}

const upserts = RESTORE
  ? [{ filename: SECTION, body: { type: "TEXT", value: BEFORE } }]
  : [
      { filename: "snippets/carbon-color-set.liquid", body: { type: "TEXT", value: local("snippets/carbon-color-set.liquid") } },
      { filename: "snippets/carbon-color-gallery.liquid", body: { type: "TEXT", value: local("snippets/carbon-color-gallery.liquid") } },
      { filename: SECTION, body: { type: "TEXT", value: AFTER } },
    ];

if (!WRITE) {
  console.log(`\nDRY RUN — would upload: ${upserts.map((u) => u.filename).join(", ")}`);
  process.exit(0);
}

/* Snippets first: the section renders them, so it must never land without them. */
for (const u of upserts) {
  const res = await gql(
    `mutation($id:ID!,$f:[OnlineStoreThemeFilesUpsertFileInput!]!){
       themeFilesUpsert(themeId:$id, files:$f){ upsertedThemeFiles{ filename } userErrors{ filename message } } }`,
    { id: GID, f: [u] },
  );
  const out = res.themeFilesUpsert;
  if (out.userErrors.length) {
    console.error("errors:", JSON.stringify(out.userErrors));
    process.exit(1);
  }
  console.log("uploaded:", out.upsertedThemeFiles.map((f) => f.filename).join(", "));
}
