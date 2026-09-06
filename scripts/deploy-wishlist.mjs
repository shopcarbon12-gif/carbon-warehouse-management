#!/usr/bin/env node
/**
 * Deploy the Carbon wishlist to a Shopify theme.
 *
 * Uploads the wishlist files from theme/ and makes the small, idempotent edits
 * to the theme's own files that hook them in (a script tag in the layout, a
 * link in the header, a heart on the product card, a heart in the buy row).
 * Re-running is safe: each hook is skipped if it is already present, and each
 * anchor must appear exactly once or that patch is reported and skipped rather
 * than applied somewhere unintended.
 *
 * The sync snippet carries a shared secret that must match
 * CARBON_WISHLIST_SECRET in the WMS environment. It is substituted here, at
 * upload time, so the copy of the snippet in the repository keeps only a
 * placeholder and the secret is never committed.
 *
 * Usage:
 *   node scripts/deploy-wishlist.mjs                 # preview theme (default)
 *   node scripts/deploy-wishlist.mjs --theme <id>    # a specific theme
 *   node scripts/deploy-wishlist.mjs --no-sync       # skip the logged-in sync layer
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* import.meta.dirname needs Node 20; this repo also runs on 18. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THEME_DIR = path.join(ROOT, "theme");
const DEFAULT_THEME = "161285013756";
const SECRET_PLACEHOLDER = "__CARBON_WISHLIST_SECRET__";

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
const argv = process.argv.slice(2);
const themeId = (() => {
  const i = argv.indexOf("--theme");
  return i > -1 && argv[i + 1] ? argv[i + 1] : DEFAULT_THEME;
})();
const withSync = !argv.includes("--no-sync");
const THEME_GID = `gid://shopify/OnlineStoreTheme/${themeId}`;

if (!env.SHOPIFY_SHOP_DOMAIN || !env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
  console.error("ABORT: SHOPIFY_SHOP_DOMAIN / SHOPIFY_ADMIN_ACCESS_TOKEN missing");
  process.exit(1);
}

async function gql(query, variables = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(
      `https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_ACCESS_TOKEN,
        },
        body: JSON.stringify({ query, variables }),
      },
    );
    const json = await res.json();
    if (json.errors?.some((e) => e?.extensions?.code === "THROTTLED")) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 400));
    return json.data;
  }
  throw new Error("throttled");
}

/* ---------- files that are wholly ours ---------- */

const OWN_FILES = [
  "assets/carbon-wishlist.js",
  "snippets/carbon-wishlist-button.liquid",
  "snippets/carbon-wishlist-card-button.liquid",
  "snippets/carbon-wishlist-global.liquid",
  "snippets/carbon-wishlist-link.liquid",
  "snippets/carbon-wishlist-drawer.liquid",
  "sections/carbon-wishlist.liquid",
  "templates/page.wishlist.json",
];
if (withSync) OWN_FILES.push("snippets/carbon-wishlist-sync.liquid");

const uploads = [];
for (const name of OWN_FILES) {
  let body = readFileSync(path.join(THEME_DIR, name), "utf8");
  if (body.includes(SECRET_PLACEHOLDER)) {
    const secret = (env.CARBON_WISHLIST_SECRET || "").trim();
    if (!secret) {
      console.error(
        `ABORT: ${name} needs CARBON_WISHLIST_SECRET but it is not set.\n` +
          "        Set it in .env.local and in the WMS environment, or pass --no-sync.",
      );
      process.exit(1);
    }
    body = body.split(SECRET_PLACEHOLDER).join(secret);
  }
  uploads.push({ filename: name, body: { type: "TEXT", value: body } });
}

/* ---------- small edits to the theme's own files ---------- */

const PATCHES = [
  {
    file: "layout/theme.liquid",
    guard: "carbon-wishlist.js",
    anchor: "</head>",
    last: true,
    apply: (a) =>
      `{%- comment -%}\n` +
      `  Carbon wishlist store — owns the saved-items list for the whole site.\n` +
      `  Deferred: nothing needs it before DOMContentLoaded, and every consumer\n` +
      `  waits for that event.\n` +
      `{%- endcomment -%}\n` +
      `<script src="{{ 'carbon-wishlist.js' | asset_url }}" defer="defer"></script>\n${a}`,
  },
  {
    file: "layout/theme.liquid",
    guard: "carbon-wishlist-global",
    anchor: `<script src="{{ 'carbon-wishlist.js' | asset_url }}" defer="defer"></script>`,
    apply: (a) => `${a}\n{%- render 'carbon-wishlist-global' -%}`,
  },
  {
    file: "layout/theme.liquid",
    guard: "carbon-wishlist-drawer",
    anchor: `{%- render 'carbon-wishlist-global' -%}`,
    apply: (a) => `${a}\n{%- render 'carbon-wishlist-drawer' -%}`,
  },
  ...(withSync
    ? [
        {
          file: "layout/theme.liquid",
          guard: "carbon-wishlist-sync",
          anchor: `{%- render 'carbon-wishlist-drawer' -%}`,
          apply: (a) => `${a}\n{%- render 'carbon-wishlist-sync' -%}`,
        },
      ]
    : []),
  {
    file: "snippets/header-secondary-area.liquid",
    guard: "carbon-wishlist-link",
    anchor: `<a class="thb-secondary-area-item thb-secondary-cart"`,
    apply: (a) => `{%- render 'carbon-wishlist-link' -%}\n\t${a}`,
  },
  {
    file: "snippets/product-card.liquid",
    guard: "carbon-wishlist-card-button",
    anchor: `{% render 'product-card-badge', product_card_product: product_card_product %}`,
    apply: (a) => `${a}\n    {%- render 'carbon-wishlist-card-button', product: product_card_product -%}`,
  },
  {
    file: "snippets/product-add-to-cart.liquid",
    guard: "carbon-wishlist-button",
    anchor: `{%- if show_dynamic_checkout -%}`,
    apply: (a) => `{%- render 'carbon-wishlist-button', product: product -%}\n\t\t\t\t${a}`,
  },
];

const targets = [...new Set(PATCHES.map((p) => p.file))];
const data = await gql(
  `query($id:ID!,$n:[String!]){ theme(id:$id){ files(filenames:$n, first:20){ nodes{ filename body{ ... on OnlineStoreThemeFileBodyText { content } } } } } }`,
  { id: THEME_GID, n: targets },
);
const current = Object.fromEntries(
  data.theme.files.nodes.map((f) => [f.filename, f.body?.content ?? ""]),
);

let failed = 0;
for (const patch of PATCHES) {
  const src = current[patch.file];
  if (!src) {
    console.error(`FAIL ${patch.file}: not readable`);
    failed++;
    continue;
  }
  if (src.includes(patch.guard)) {
    console.log(`  ok   ${patch.file} — ${patch.guard} already present`);
    continue;
  }
  const occurrences = src.split(patch.anchor).length - 1;
  if (occurrences === 0) {
    console.error(`FAIL ${patch.file}: anchor for ${patch.guard} not found`);
    failed++;
    continue;
  }
  if (occurrences > 1 && !patch.last) {
    console.error(`FAIL ${patch.file}: anchor for ${patch.guard} appears ${occurrences}x`);
    failed++;
    continue;
  }
  const at = patch.last ? src.lastIndexOf(patch.anchor) : src.indexOf(patch.anchor);
  current[patch.file] =
    src.slice(0, at) + patch.apply(patch.anchor) + src.slice(at + patch.anchor.length);
  console.log(`  +    ${patch.file} — added ${patch.guard}`);
}
if (failed) {
  console.error(`\nABORT: ${failed} patch(es) could not be applied; nothing uploaded.`);
  process.exit(1);
}

for (const name of targets) {
  if (current[name] !== (data.theme.files.nodes.find((f) => f.filename === name)?.body?.content ?? ""))
    uploads.push({ filename: name, body: { type: "TEXT", value: current[name] } });
}

const result = await gql(
  `mutation($id:ID!,$f:[OnlineStoreThemeFilesUpsertFileInput!]!){ themeFilesUpsert(themeId:$id, files:$f){ upsertedThemeFiles{ filename } userErrors{ filename message } } }`,
  { id: THEME_GID, f: uploads },
);
const errs = result.themeFilesUpsert.userErrors;
console.log(
  `\nuploaded ${result.themeFilesUpsert.upsertedThemeFiles.length} file(s) to theme ${themeId}` +
    (withSync ? " (with logged-in sync)" : " (no sync)"),
);
if (errs.length) {
  console.error("ERRORS:", JSON.stringify(errs));
  process.exit(1);
}
