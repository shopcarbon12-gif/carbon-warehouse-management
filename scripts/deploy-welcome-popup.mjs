/**
 * Deploy the email popup (WMS → Shopify → Email Popup) to a theme.
 *
 * Uploads theme/snippets/carbon-welcome-popup.liquid and renders it just
 * before </body> of layout/theme.liquid. With --disable-popconvert it also
 * switches off the pop-convert app embed it replaces (config/settings_data.json).
 * Backs up every live file it changes to theme/backups/ first. Idempotent.
 * Whether the popup actually opens is the WMS switch (shop metafield
 * carbon.welcome_popup), not this script.
 *
 *   node scripts/deploy-welcome-popup.mjs                      # dry run, live theme
 *   node scripts/deploy-welcome-popup.mjs --theme <id> --write # an unpublished copy first
 *   node scripts/deploy-welcome-popup.mjs --write --disable-popconvert
 *   node scripts/deploy-welcome-popup.mjs --remove --write     # take the render tag out again
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");
const REMOVE = process.argv.includes("--remove");
const NO_POPCONVERT = process.argv.includes("--disable-popconvert");
const THEME_ARG = process.argv.includes("--theme") ? process.argv[process.argv.indexOf("--theme") + 1] : null;
const RENDER = "{% render 'carbon-welcome-popup' %}";
const SNIPPET = "snippets/carbon-welcome-popup.liquid";

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

const theme = THEME_ARG
  ? (await gql(`query($id:ID!){ theme(id:$id){ id name role } }`, { id: `gid://shopify/OnlineStoreTheme/${THEME_ARG}` })).theme
  : (await gql(`{ themes(first: 5, roles: [MAIN]) { nodes { id name role } } }`)).themes.nodes[0];
if (!theme) throw new Error("Theme not found");
const isLive = theme.role === "MAIN";
console.log(`${isLive ? "LIVE" : "target"} theme: ${theme.name} (${theme.id})`);

const FILES = ["layout/theme.liquid", "config/settings_data.json"];
const got = await gql(
  `query($id:ID!,$f:[String!]){ theme(id:$id){ files(filenames:$f, first:5){ nodes{ filename body{ ... on OnlineStoreThemeFileBodyText{content} } } } } }`,
  { id: theme.id, f: FILES },
);
const current = Object.fromEntries(got.theme.files.nodes.map((n) => [n.filename, n.body?.content ?? null]));
for (const f of FILES) if (current[f] == null) throw new Error(`missing ${f}`);
const next = { ...current };

// ── layout/theme.liquid: the render tag right before </body> ───────────────
{
  const s = current["layout/theme.liquid"];
  if (REMOVE) {
    next["layout/theme.liquid"] = s.replace(`${RENDER}\n`, "").replace(RENDER, "");
  } else if (!s.includes(RENDER)) {
    const i = s.lastIndexOf("</body>");
    if (i < 0) throw new Error("layout/theme.liquid has no </body>; nothing uploaded");
    next["layout/theme.liquid"] = s.slice(0, i) + `${RENDER}\n` + s.slice(i);
  }
}

// ── config/settings_data.json: switch off the pop-convert app embed ─────────
if (NO_POPCONVERT && !REMOVE) {
  const raw = current["config/settings_data.json"];
  const m = /^(\s*\/\*[\s\S]*?\*\/\s*)?([\s\S]*)$/.exec(raw);
  const prefix = m?.[1] ?? "";
  const data = JSON.parse(m?.[2] ?? raw);
  const blocks = data.current?.blocks ?? {};
  const pop = Object.entries(blocks).find(([, b]) => String(b.type).includes("/apps/pop-convert"));
  if (!pop) console.log("pop-convert app embed: not in this theme");
  else if (pop[1].disabled === true) console.log("pop-convert app embed: already off");
  else {
    pop[1].disabled = true;
    next["config/settings_data.json"] = prefix + JSON.stringify(data, null, 2);
    console.log("pop-convert app embed: will be switched off");
  }
}

const changed = FILES.filter((f) => next[f] !== current[f]);
console.log(`render tag: ${REMOVE ? (changed.includes("layout/theme.liquid") ? "will be removed" : "not present") : changed.includes("layout/theme.liquid") ? "will be added before </body>" : "already present"}`);

const upserts = [];
if (!REMOVE) upserts.push({ filename: SNIPPET, body: { type: "TEXT", value: readFileSync(path.join(ROOT, "theme", SNIPPET), "utf8") } });
for (const f of changed) upserts.push({ filename: f, body: { type: "TEXT", value: next[f] } });

if (!WRITE) {
  console.log(`\nDRY RUN — would upload: ${upserts.map((u) => u.filename).join(", ") || "nothing"}`);
  process.exit(0);
}
if (isLive && changed.length) {
  const dir = path.join(ROOT, "theme", "backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  for (const f of changed) {
    const base = path.basename(f).replace(/\.(liquid|json)$/, "");
    const ext = f.endsWith(".json") ? "json" : "liquid";
    const file = path.join(dir, `${base}.PRE-WELCOME-POPUP-${REMOVE ? "REMOVE-" : ""}${stamp}.${ext}`);
    writeFileSync(file, current[f]);
    console.log(`backup: ${path.relative(ROOT, file)}`);
  }
}
if (!upserts.length) process.exit(0);
const res = await gql(
  `mutation($id:ID!,$f:[OnlineStoreThemeFilesUpsertFileInput!]!){
     themeFilesUpsert(themeId:$id, files:$f){ upsertedThemeFiles{ filename } userErrors{ filename message } } }`,
  { id: theme.id, f: upserts },
);
const out = res.themeFilesUpsert;
console.log("uploaded:", out.upsertedThemeFiles.map((f) => f.filename).join(", "));
if (out.userErrors.length) {
  console.log("errors:", JSON.stringify(out.userErrors));
  process.exit(1);
}
