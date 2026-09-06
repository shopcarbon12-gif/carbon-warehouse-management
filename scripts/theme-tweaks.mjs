#!/usr/bin/env node
/**
 * Small, idempotent edits to the theme's own vendor files.
 *
 * These are one- or two-line corrections to files we do not own outright, so
 * they are applied as surgical patches rather than by keeping a full copy of a
 * 17KB vendor file in the repo where it would drift. Every patch is guarded:
 * re-running is safe, and a patch whose anchor is missing is reported and
 * skipped rather than applied somewhere unintended.
 *
 * Usage:
 *   node scripts/theme-tweaks.mjs                 # preview theme (default)
 *   node scripts/theme-tweaks.mjs --theme <id>
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_THEME = "161285013756";

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
const i = process.argv.indexOf("--theme");
const themeId = i > -1 && process.argv[i + 1] ? process.argv[i + 1] : DEFAULT_THEME;
const THEME = `gid://shopify/OnlineStoreTheme/${themeId}`;

async function gql(query, variables = {}) {
  for (let a = 0; a < 8; a++) {
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
    if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 300));
    return json.data;
  }
  throw new Error("throttled");
}

/** Snippets we own outright, uploaded verbatim from theme/. */
const OWN_FILES = ["snippets/carbon-scroll-reveal.liquid", "snippets/carbon-home-tweaks.liquid"];

const TWEAKS = [
  {
    file: "layout/theme.liquid",
    name: "render the homepage scroll reveal",
    guard: "carbon-scroll-reveal",
    apply(src) {
      const anchor = "{% render 'carbon-accessibility-widget' %}";
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, anchor + "\n{% render 'carbon-scroll-reveal' %}");
    },
  },
  {
    file: "layout/theme.liquid",
    name: "render homepage tweaks",
    guard: "carbon-home-tweaks",
    apply(src) {
      const anchor = "{% render 'carbon-scroll-reveal' %}";
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, anchor + "\n{% render 'carbon-home-tweaks' %}");
    },
  },
  {
    file: "layout/theme.liquid",
    name: "uppercase breadcrumbs",
    guard: "carbon-uppercase-breadcrumbs",
    /**
     * The breadcrumb was the last place still showing Title Case while every
     * other product name renders uppercase. Casing stays display-only, exactly
     * as the rest of this block does, so Google and screen readers keep reading
     * the real product name.
     */
    apply(src) {
      const anchor =
        "  .product-title-uppercase-true .predictive-search .product-title {\n" +
        "    text-transform: uppercase;\n" +
        "  }";
      if (!src.includes(anchor)) return null;
      return src.replace(
        anchor,
        anchor +
          "\n\n  /* carbon-uppercase-breadcrumbs */\n" +
          "  .product-title-uppercase-true .breadcrumbs {\n" +
          "    text-transform: uppercase;\n" +
          "  }",
      );
    },
  },
  {
    file: "snippets/header-mobile-menu.liquid",
    name: "hide the empty premium link row",
    guard: "premium_link_label != blank",
    /**
     * The theme always renders a "Premium Link" <li> at the end of the mobile
     * menu, even when settings.premium_link_label is blank — which it is. That
     * produced an empty 60px row under REWARDS whose divider read as a stray
     * white line. Guarding the <li> removes the row while leaving the feature
     * intact for whenever a label is set.
     */
    apply(src) {
      const re =
        /([ \t]*)<li>\s*\n([ \t]*)<a href="\{\{ premium_link \}\}" class="link-container premium-feature__link">\{\{ settings\.premium_link_label \}\}<\/a>\s*\n([ \t]*)<\/li>/;
      if (!re.test(src)) return null;
      return src.replace(
        re,
        (_m, i1, i2, i3) =>
          `${i1}{%- if settings.premium_link_label != blank -%}\n` +
          `${i1}<li>\n` +
          `${i2}<a href="{{ premium_link }}" class="link-container premium-feature__link">{{ settings.premium_link_label }}</a>\n` +
          `${i3}</li>\n` +
          `${i1}{%- endif -%}`,
      );
    },
  },
];

const files = [...new Set(TWEAKS.map((t) => t.file))];
const data = await gql(
  `query($id:ID!,$n:[String!]){ theme(id:$id){ files(filenames:$n, first:20){ nodes{ filename body{ ... on OnlineStoreThemeFileBodyText { content } } } } } }`,
  { id: THEME, n: files },
);
const current = Object.fromEntries(
  data.theme.files.nodes.map((f) => [f.filename, f.body?.content ?? ""]),
);

const uploads = OWN_FILES.map((n) => ({
  filename: n,
  body: { type: "TEXT", value: readFileSync(path.join(ROOT, "theme", n), "utf8") },
}));
let failed = 0;
for (const t of TWEAKS) {
  const src = current[t.file];
  if (!src) {
    console.error(`FAIL ${t.file}: not readable`);
    failed++;
    continue;
  }
  if (src.includes(t.guard)) {
    console.log(`  ok   ${t.name} — already applied`);
    continue;
  }
  const next = t.apply(src);
  if (next === null) {
    console.error(`FAIL ${t.name}: anchor not found in ${t.file}`);
    failed++;
    continue;
  }
  current[t.file] = next;
  console.log(`  +    ${t.name}`);
}
for (const f of files) {
  const original = data.theme.files.nodes.find((n) => n.filename === f)?.body?.content ?? "";
  if (current[f] !== original) uploads.push({ filename: f, body: { type: "TEXT", value: current[f] } });
}
if (failed) {
  console.error(`\nABORT: ${failed} tweak(s) could not be applied; nothing uploaded.`);
  process.exit(1);
}
if (!uploads.length) {
  console.log("\nnothing to upload — all tweaks already in place");
  process.exit(0);
}
const r = await gql(
  `mutation($id:ID!,$f:[OnlineStoreThemeFilesUpsertFileInput!]!){ themeFilesUpsert(themeId:$id, files:$f){ upsertedThemeFiles{ filename } userErrors{ filename message } } }`,
  { id: THEME, f: uploads },
);
console.log(`\nuploaded to theme ${themeId}:`, r.themeFilesUpsert.upsertedThemeFiles.map((x) => x.filename).join(", "));
if (r.themeFilesUpsert.userErrors.length) {
  console.error("ERRORS:", JSON.stringify(r.themeFilesUpsert.userErrors));
  process.exit(1);
}
