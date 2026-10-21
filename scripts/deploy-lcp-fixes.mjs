/**
 * Storefront speed fix 2 (owner 2026-10-21): show the first picture sooner.
 *
 *  1. snippets/responsive-image.liquid — an image marked priority 'high' (the
 *     product page's first photo, the collection banner) goes out as a normal
 *     image fetched at once at top priority, instead of a 20 px blur the lazy
 *     loader replaces 3–5 s later on a phone.
 *  2. sections/main-collection-banner.liquid — that banner is full width
 *     (display_sizes: '100vw') so phones pick the right size.
 *  3. sections/slideshow.liquid — the home video's cover picture is preloaded
 *     at top priority (browsers fetch video posters late).
 *
 * 1 and 3 upload the repo copies in theme/; each is uploaded only when the
 * target theme still has the version that copy was edited from (the file as
 * committed before this change), so nobody's later theme edit is overwritten.
 * Backups of changed live files go to theme/backups/. Idempotent.
 *
 *   node scripts/deploy-lcp-fixes.mjs --theme <copy id> --write   # test on a copy
 *   node scripts/deploy-lcp-fixes.mjs                             # dry run, live
 *   node scripts/deploy-lcp-fixes.mjs --write
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");
const THEME_ARG = process.argv.includes("--theme") ? process.argv[process.argv.indexOf("--theme") + 1] : null;
const BASE_COMMIT = "a54938f7"; // repo state before this change

function env(key) {
  for (const f of [".env.coolify.local", ".env.local"]) {
    const p = path.join(ROOT, f);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    if (m && m[1].trim()) return m[1].trim().replace(/^['"]|['"]$/g, "");
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

const theme = THEME_ARG
  ? (await gql(`query($id:ID!){ theme(id:$id){ id name role } }`, { id: `gid://shopify/OnlineStoreTheme/${THEME_ARG}` })).theme
  : (await gql(`{ themes(first: 5, roles: [MAIN]) { nodes { id name role } } }`)).themes.nodes[0];
if (!theme) throw new Error("Theme not found");
const isLive = theme.role === "MAIN";
console.log(`${isLive ? "LIVE" : "target"} theme: ${theme.name} (${theme.id})`);

const WHOLE = ["snippets/responsive-image.liquid", "sections/slideshow.liquid"];
const BANNER = "sections/main-collection-banner.liquid";
const got = await gql(
  `query($id:ID!,$f:[String!]){ theme(id:$id){ files(filenames:$f, first:10){ nodes{ filename body{ ... on OnlineStoreThemeFileBodyText{content} } } } } }`,
  { id: theme.id, f: [...WHOLE, BANNER] },
);
const current = Object.fromEntries(got.theme.files.nodes.map((n) => [n.filename, n.body?.content ?? null]));
const next = {};

for (const f of WHOLE) {
  const mine = readFileSync(path.join(ROOT, "theme", f), "utf8");
  const base = execFileSync("git", ["show", `${BASE_COMMIT}:theme/${f}`], { cwd: ROOT, encoding: "utf8" });
  if (current[f] === mine) console.log(`${f}: already up to date`);
  else if (current[f] === base) next[f] = mine;
  else throw new Error(`${f} on the theme differs from the repo version it was edited from — not overwriting; merge first`);
}

{
  const s = current[BANNER];
  const OLD = "{%- render 'responsive-image', image: image, sizes: '0x350,0x700', priority: 'high' -%}";
  const NEW = "{%- render 'responsive-image', image: image, sizes: '0x350,0x700', priority: 'high', display_sizes: '100vw' -%}";
  if (s.includes(NEW)) console.log(`${BANNER}: already up to date`);
  else if (s.includes(OLD)) next[BANNER] = s.replace(OLD, NEW);
  else throw new Error(`${BANNER}: banner image tag not found — theme changed; nothing uploaded`);
}

const changed = Object.keys(next);
if (!WRITE) {
  console.log(`\nDRY RUN — would upload: ${changed.join(", ") || "nothing"}`);
  process.exit(0);
}
if (!changed.length) process.exit(0);
if (isLive) {
  const dir = path.join(ROOT, "theme", "backups");
  mkdirSync(dir, { recursive: true });
  for (const f of changed) {
    const file = path.join(dir, `${path.basename(f, ".liquid")}.PRE-LCP-2026-10-21.liquid`);
    writeFileSync(file, current[f]);
    console.log(`backup: ${path.relative(ROOT, file)}`);
  }
}
const res = await gql(
  `mutation($id:ID!,$f:[OnlineStoreThemeFilesUpsertFileInput!]!){
     themeFilesUpsert(themeId:$id, files:$f){ upsertedThemeFiles{ filename } userErrors{ filename message } } }`,
  { id: theme.id, f: changed.map((f) => ({ filename: f, body: { type: "TEXT", value: next[f] } })) },
);
console.log("uploaded:", res.themeFilesUpsert.upsertedThemeFiles.map((f) => f.filename).join(", "));
if (res.themeFilesUpsert.userErrors.length) {
  console.log("errors:", JSON.stringify(res.themeFilesUpsert.userErrors));
  process.exit(1);
}
