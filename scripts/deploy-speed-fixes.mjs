/**
 * Storefront speed fixes (owner 2026-10-20, after the Lighthouse run:
 * phone scores 32–41). Applies to the LIVE theme, with a backup of every file
 * it changes in theme/backups/ and a copy of the new version in theme/.
 *
 *  1. carbon-perf-fixes (CSS in <head>): stop the 48 invisible product-card
 *     spinners animating forever (CPU ~100% → ~30–40% on a throttled phone).
 *  2. Home slideshow video: phones get Shopify's 480p rendition (2.8 MB),
 *     computers keep 720p (7.6 MB). Always a video (owner).
 *  3. Product-card photos load when scrolled near (native loading="lazy"),
 *     except the first 4 cards of a collection grid.
 *  4. Tawk.to chat: app embed switched off, same widget loaded 5 s after the
 *     page (or on the first scroll / tap / key) by carbon-tawk-delayed.
 *  5. Google Tag Manager (GTM-WHVPQVSC) removed from the layout — it sent
 *     Google Analytics a second time (the Google & YouTube app already does).
 *  6. Metricool tracker removed.
 *
 * Every edit checks its anchor first and the script stops if the theme no
 * longer looks as expected. Idempotent.
 *
 *   node scripts/deploy-speed-fixes.mjs          # dry run (prints what changes)
 *   node scripts/deploy-speed-fixes.mjs --write
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");
const STAMP = "2026-10-20";

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

/* --theme <id>: apply to another (unpublished) theme first — e.g. a copy to
   preview with ?preview_theme_id=<id>. No backups are written for it. */
const THEME_ARG = process.argv.includes("--theme") ? process.argv[process.argv.indexOf("--theme") + 1] : null;
const main = THEME_ARG
  ? (await gql(`query($id:ID!){ theme(id:$id){ id name role } }`, { id: `gid://shopify/OnlineStoreTheme/${THEME_ARG}` })).theme
  : (await gql(`{ themes(first: 5, roles: [MAIN]) { nodes { id name } } }`)).themes.nodes[0];
if (!main) throw new Error("Theme not found");
console.log(`${THEME_ARG ? "target" : "live"} theme: ${main.name} (${main.id})`);

const FILES = [
  "layout/theme.liquid",
  "config/settings_data.json",
  "sections/slideshow.liquid",
  "sections/main-collection-product-grid.liquid",
  "snippets/product-card.liquid",
  "snippets/responsive-image.liquid",
];
const got = await gql(
  `query($id:ID!,$f:[String!]){ theme(id:$id){ files(filenames:$f, first:20){ nodes{ filename body{ ... on OnlineStoreThemeFileBodyText{content} } } } } }`,
  { id: main.id, f: FILES },
);
const live = Object.fromEntries(got.theme.files.nodes.map((n) => [n.filename, n.body?.content ?? null]));
for (const f of FILES) if (live[f] == null) throw new Error(`missing ${f}`);
const next = { ...live };

function must(cond, msg) {
  if (!cond) throw new Error(`theme changed — ${msg}; nothing uploaded`);
}

// ── layout/theme.liquid ─────────────────────────────────────────────────────
{
  let s = next["layout/theme.liquid"];
  const PERF = "{% render 'carbon-perf-fixes' %}";
  if (!s.includes(PERF)) {
    must(s.includes("{% render 'carbon-shield' %}"), "carbon-shield render tag not found");
    s = s.replace("{% render 'carbon-shield' %}", `{% render 'carbon-shield' %}\n  ${PERF}`);
  }
  const GTM_ASSIGN = "{%- assign gtm_container_id = 'GTM-WHVPQVSC' -%}";
  const GTM_HEAD = "{% render 'carbon-gtm-head', gtm_container_id: gtm_container_id %}";
  const GTM_BODY = "{% render 'carbon-gtm-body', gtm_container_id: gtm_container_id %}";
  if (s.includes(GTM_HEAD) || s.includes(GTM_BODY) || s.includes(GTM_ASSIGN)) {
    s = s
      .replace(
        GTM_ASSIGN,
        "{%- comment -%} Google Tag Manager (GTM-WHVPQVSC) removed 2026-10-20 for speed: it sent Google Analytics a second time — GA4 + Google Ads run through the Google & YouTube app. Restore from theme/backups/theme.PRE-SPEED-2026-10-20.liquid {%- endcomment -%}",
      )
      .replace(GTM_HEAD, "")
      .replace(GTM_BODY, "");
  }
  const metricool = /<script>function loadScript\(a\)\{[^<]*tracker\.metricool\.com[^<]*<\/script>\n?/;
  if (metricool.test(s)) s = s.replace(metricool, "");
  const TAWK = "{% render 'carbon-tawk-delayed' %}";
  if (!s.includes(TAWK)) {
    const i = s.lastIndexOf("</body>");
    must(i > 0, "no </body>");
    s = s.slice(0, i) + `${TAWK}\n` + s.slice(i);
  }
  must(!/googletagmanager\.com\/gtm\.js/.test(s), "a GTM loader is still inline in the layout");
  next["layout/theme.liquid"] = s;
}

// ── config/settings_data.json: switch off the Tawk app embed ───────────────
{
  const raw = next["config/settings_data.json"];
  const m = /^(\s*\/\*[\s\S]*?\*\/\s*)?([\s\S]*)$/.exec(raw);
  const prefix = m?.[1] ?? "";
  const data = JSON.parse(m?.[2] ?? raw);
  const blocks = data.current?.blocks ?? {};
  const tawk = Object.entries(blocks).find(([, b]) => String(b.type).includes("/apps/tawk-to-live-chat/"));
  must(!!tawk, "Tawk app embed not found");
  if (tawk[1].disabled !== true) {
    tawk[1].disabled = true;
    next["config/settings_data.json"] = prefix + JSON.stringify(data, null, 2);
  }
}

// ── sections/slideshow.liquid: smaller video on phones ─────────────────────
{
  let s = next["sections/slideshow.liquid"];
  const OLD = "{{ video | video_tag: autoplay: autoplay, loop: true, controls: false, muted: true, image_size: '1600x' }}";
  // A previous version of this block (or a debug line) is replaced, not stacked.
  s = s.replace(/<!-- hv-debug[^\n]*\n?/g, "");
  const prevStart = s.indexOf("{%- comment -%} Phones get the smallest rendition");
  if (prevStart >= 0) {
    const tail = s.indexOf(OLD, prevStart);
    const end = tail >= 0 ? s.indexOf("{%- endif -%}", tail) : -1;
    must(end > 0, "previous phone-video block is malformed");
    s = s.slice(0, prevStart) + OLD + s.slice(end + "{%- endif -%}".length);
  }
  if (s.includes(OLD)) {
    const NEW = `{%- comment -%} Phones get the smallest rendition ≥480p (owner 2026-10-20: always video, lighter on mobile only); computers keep ≤720p. {%- endcomment -%}
								{%- liquid
									assign hv_m_url = ''
									assign hv_m_p = 100000
									assign hv_d_url = ''
									assign hv_d_p = 0
									assign hv_any = ''
									for hv_s in video.sources
										if hv_s.format == 'mp4'
											assign hv_p = hv_s.height
											if hv_s.width < hv_s.height
												assign hv_p = hv_s.width
											endif
											if hv_any == ''
												assign hv_any = hv_s.url
											endif
											if hv_p >= 480 and hv_p < hv_m_p
												assign hv_m_url = hv_s.url
												assign hv_m_p = hv_p
											endif
											if hv_p <= 720 and hv_p > hv_d_p
												assign hv_d_url = hv_s.url
												assign hv_d_p = hv_p
											endif
										endif
									endfor
									if hv_d_url == ''
										assign hv_d_url = hv_any
									endif
									if hv_m_url == ''
										assign hv_m_url = hv_d_url
									endif
									comment
										Liquid's video.sources lists only the 720p mp4 (and HLS), but Shopify
										also keeps a 480p file with the same name pattern — 2.8 MB instead of
										7.6 MB for the home video. Use it on phones.
									endcomment
									if hv_m_url == hv_d_url and hv_d_url contains 'HD-720p-4.5Mbps'
										assign hv_m_url = hv_d_url | replace: 'HD-720p-4.5Mbps', 'SD-480p-1.5Mbps'
									endif
									assign hv_poster = video.preview_image | image_url: width: 1600
								-%}
								{%- if hv_d_url != '' -%}
									<video playsinline="playsinline"{% if autoplay %} autoplay="autoplay"{% endif %} loop="loop" muted="muted" preload="metadata" poster="{{ hv_poster }}">
										{%- if hv_m_url != hv_d_url -%}<source media="(max-width: 767px)" src="{{ hv_m_url }}" type="video/mp4">{%- endif -%}
										<source src="{{ hv_d_url }}" type="video/mp4">
										<img src="{{ hv_poster }}" alt="">
									</video>
								{%- else -%}
									${OLD}
								{%- endif -%}`;
    s = s.replace(OLD, NEW);
  } else {
    must(s.includes("hv_m_url"), "slideshow video tag not found");
  }
  next["sections/slideshow.liquid"] = s;
}

// ── collection grid passes the card position ───────────────────────────────
{
  let s = next["sections/main-collection-product-grid.liquid"];
  const OLD = "{%- render 'product-card', product_card_product: product -%}";
  if (s.includes(OLD)) s = s.replace(OLD, "{%- render 'product-card', product_card_product: product, card_index: forloop.index -%}");
  else must(s.includes("card_index: forloop.index"), "collection grid product-card render not found");
  next["sections/main-collection-product-grid.liquid"] = s;
}

// ── product-card: lazy photos (first 4 grid cards stay eager) ──────────────
{
  let s = next["snippets/product-card.liquid"];
  const PRIMARY = "{%- render 'responsive-image', class: 'product-primary-image', image: featured_media, sizes: sizes -%}";
  const SECONDARY = "{%- render 'responsive-image', class: 'product-secondary-image', image: product_card_product.images[i], sizes: sizes, priority: 'low', defer: true -%}";
  if (s.includes(PRIMARY)) {
    s = s.replace(
      PRIMARY,
      `{%- liquid
					assign card_img_loading = 'lazy'
					if card_index != blank and card_index <= 4
						assign card_img_loading = ''
					endif
				-%}
      	{%- render 'responsive-image', class: 'product-primary-image', image: featured_media, sizes: sizes, loading: card_img_loading -%}`,
    );
  } else must(s.includes("loading: card_img_loading"), "product-card primary image render not found");
  if (s.includes(SECONDARY)) {
    s = s.replace(SECONDARY, SECONDARY.replace("defer: true -%}", "defer: true, loading: 'lazy' -%}"));
  } else must(s.includes("defer: true, loading: 'lazy'"), "product-card secondary image render not found");
  next["snippets/product-card.liquid"] = s;
}

// ── responsive-image: optional native loading attribute ────────────────────
{
  let s = next["snippets/responsive-image.liquid"];
  const OLD = 'fetchpriority="{{ fetchpriority }}" alt=';
  if (!s.includes("{% if loading != blank %}")) {
    must(s.includes(OLD), "responsive-image <img> not found");
    s = s.replace(OLD, 'fetchpriority="{{ fetchpriority }}"{% if loading != blank %} loading="{{ loading }}"{% endif %} alt=');
  }
  next["snippets/responsive-image.liquid"] = s;
}

// ── report / upload ────────────────────────────────────────────────────────
const changed = FILES.filter((f) => next[f] !== live[f]);
const NEW_SNIPPETS = ["snippets/carbon-perf-fixes.liquid", "snippets/carbon-tawk-delayed.liquid"];
console.log(`files to change: ${changed.join(", ") || "none"}`);
console.log(`snippets to upload: ${NEW_SNIPPETS.join(", ")}`);
if (!WRITE) {
  console.log("\nDRY RUN — nothing uploaded. Re-run with --write.");
  process.exit(0);
}
mkdirSync(path.join(ROOT, "theme", "backups"), { recursive: true });
for (const f of THEME_ARG ? [] : changed) {
  const base = path.basename(f).replace(/\.(liquid|json)$/, "");
  const ext = f.endsWith(".json") ? "json" : "liquid";
  writeFileSync(path.join(ROOT, "theme", "backups", `${base}.PRE-SPEED-${STAMP}.${ext}`), live[f]);
  const copy = path.join(ROOT, "theme", f);
  mkdirSync(path.dirname(copy), { recursive: true });
  writeFileSync(copy, next[f]);
}
const files = [
  ...NEW_SNIPPETS.map((f) => ({ filename: f, body: { type: "TEXT", value: readFileSync(path.join(ROOT, "theme", f), "utf8") } })),
  ...changed.map((f) => ({ filename: f, body: { type: "TEXT", value: next[f] } })),
];
const res = await gql(
  `mutation($id:ID!,$f:[OnlineStoreThemeFilesUpsertFileInput!]!){
     themeFilesUpsert(themeId:$id, files:$f){ upsertedThemeFiles{ filename } userErrors{ filename message } } }`,
  { id: main.id, f: files },
);
const out = res.themeFilesUpsert;
console.log("uploaded:", out.upsertedThemeFiles.map((x) => x.filename).join(", "));
if (out.userErrors.length) {
  console.log("errors:", JSON.stringify(out.userErrors, null, 1));
  process.exit(1);
}
