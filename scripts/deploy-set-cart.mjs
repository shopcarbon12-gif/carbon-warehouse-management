/**
 * Deploy the Carbon storefront snippets to the live theme.
 *
 * Uploads the two snippets and renders them from layout/theme.liquid, next to
 * the other carbon-* snippets. Idempotent: re-running replaces the snippet
 * bodies and leaves the layout untouched once the render tags are present.
 *
 *   node scripts/deploy-set-cart.mjs            # dry run
 *   node scripts/deploy-set-cart.mjs --write
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THEME_ID = process.argv.includes("--theme")
  ? process.argv[process.argv.indexOf("--theme") + 1]
  : "161285013756";
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
const GID = `gid://shopify/OnlineStoreTheme/${THEME_ID}`;

async function gql(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}

const SNIPPETS = [
  "snippets/carbon-set-cart.liquid",
  "snippets/carbon-set-cart-guard.liquid",
  "snippets/carbon-mega-menu.liquid",
  "snippets/carbon-sticky-atc.liquid",
  "snippets/carbon-buy-button-hover.liquid",
  "snippets/carbon-size-availability.liquid",
];
const RENDERS = [
  "{% render 'carbon-set-cart' %}",
  "{% render 'carbon-set-cart-guard' %}",
  "{% render 'carbon-mega-menu' %}",
  "{% render 'carbon-sticky-atc' %}",
  "{% render 'carbon-buy-button-hover' %}",
  "{% render 'carbon-size-availability' %}",
];

const files = await gql(
  `query($id:ID!,$f:[String!]){ theme(id:$id){ name role files(filenames:$f, first:10){
     nodes{ filename body{ ... on OnlineStoreThemeFileBodyText{content} } } } } }`,
  { id: GID, f: ["layout/theme.liquid"] },
);
console.log(`theme: ${files.theme.name} (${files.theme.role})`);
const layout = files.theme.files.nodes[0].body.content;

/* Append the render tags just before </body>, where the other carbon-* snippets
   already live, and only the ones that are not there yet. */
const missing = RENDERS.filter((r) => !layout.includes(r));
let nextLayout = layout;
if (missing.length) {
  const idx = layout.lastIndexOf("</body>");
  if (idx < 0) throw new Error("layout/theme.liquid has no </body>");
  nextLayout = layout.slice(0, idx) + missing.join("\n") + "\n" + layout.slice(idx);
}
console.log(`render tags to add: ${missing.length ? missing.join(" ") : "none (already present)"}`);

const upserts = SNIPPETS.map((name) => ({
  filename: name,
  body: { type: "TEXT", value: readFileSync(path.join(ROOT, "theme", name), "utf8") },
}));
if (missing.length) upserts.push({ filename: "layout/theme.liquid", body: { type: "TEXT", value: nextLayout } });

if (!WRITE) {
  console.log(`\nDRY RUN — would upload: ${upserts.map((u) => u.filename).join(", ")}`);
  process.exit(0);
}

const res = await gql(
  `mutation($id:ID!,$f:[OnlineStoreThemeFilesUpsertFileInput!]!){
     themeFilesUpsert(themeId:$id, files:$f){ upsertedThemeFiles{ filename } userErrors{ filename message } } }`,
  { id: GID, f: upserts },
);
const out = res.themeFilesUpsert;
console.log("uploaded:", out.upsertedThemeFiles.map((f) => f.filename).join(", "));
if (out.userErrors.length) console.log("errors:", JSON.stringify(out.userErrors));
