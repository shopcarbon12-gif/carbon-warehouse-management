/**
 * Deploy the Escape-key fix to a theme: pressing Escape closes the open side
 * panel (cart drawer, product information, menu, search) again.
 *
 * The theme's side-panel close handler checked whether the click landed on a
 * dropdown with e.target.closest(); Escape sends its close signal from
 * `document`, which has no closest(), so the handler threw before closing
 * anything. theme/assets/app.js runs that check on elements only.
 *
 * assets/app.js is only replaced when the theme's copy is still the one this
 * edit was made from (theme/backups/app.PRE-ESCAPE-FIX-2026-10-14.js) or
 * already this version.
 *
 *   node scripts/deploy-escape-fix.mjs                    # dry run, live theme
 *   node scripts/deploy-escape-fix.mjs [--theme <id>] --write
 *   node scripts/deploy-escape-fix.mjs [--theme <id>] --restore --write   # put the backup back
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

const FILE = "assets/app.js";
const BEFORE = readFileSync(path.join(ROOT, "theme/backups/app.PRE-ESCAPE-FIX-2026-10-14.js"), "utf8");
const AFTER = readFileSync(path.join(ROOT, "theme", FILE), "utf8");

const files = await gql(
  `query($id:ID!,$f:[String!]){ theme(id:$id){ name role files(filenames:$f, first:1){
     nodes{ filename body{ ... on OnlineStoreThemeFileBodyText{content} } } } } }`,
  { id: GID, f: [FILE] },
);
console.log(`theme: ${files.theme.name} (${files.theme.role})`);
const remote = files.theme.files.nodes[0]?.body?.content ?? "";
const state = md5(remote) === md5(BEFORE) ? "original" : md5(remote) === md5(AFTER) ? "deployed" : "changed";
console.log(`${FILE}: ${state}`);
if (state === "changed") {
  console.error("The theme's app.js is neither the backed-up original nor this version — not overwriting it.");
  process.exit(1);
}

const value = RESTORE ? BEFORE : AFTER;
if (!WRITE) {
  console.log(`\nDRY RUN — would upload ${FILE} (${RESTORE ? "original" : "fixed"})`);
  process.exit(0);
}
const res = await gql(
  `mutation($id:ID!,$f:[OnlineStoreThemeFilesUpsertFileInput!]!){
     themeFilesUpsert(themeId:$id, files:$f){ upsertedThemeFiles{ filename } userErrors{ filename message } } }`,
  { id: GID, f: [{ filename: FILE, body: { type: "TEXT", value } }] },
);
const out = res.themeFilesUpsert;
if (out.userErrors.length) {
  console.error("errors:", JSON.stringify(out.userErrors));
  process.exit(1);
}
console.log("uploaded:", out.upsertedThemeFiles.map((f) => f.filename).join(", "));
