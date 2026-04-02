#!/usr/bin/env node
/**
 * Injects the Metricool tracker snippet into the live theme's layout/theme.liquid
 * (before </body>), equivalent to Shopify Admin → Themes → Edit code.
 *
 * Requires .env.local (or env) with:
 *   SHOPIFY_SHOP_DOMAIN=e.g. mystore.myshopify.com
 *   SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_... (scopes: read_themes, write_themes)
 *
 *   node scripts/inject-metricool-shopify-theme.mjs
 *
 * Optional: METRICOOL_SNIPPET_HTML — full <script>...</script> from Metricool (default: project hash).
 */
import fs from "node:fs";
import path from "node:path";

const API_VERSION = "2024-10";

const DEFAULT_SNIPPET = `<script>function loadScript(a){var b=document.getElementsByTagName("head")[0],c=document.createElement("script");c.type="text/javascript",c.src="https://tracker.metricool.com/resources/be.js",c.onreadystatechange=a,c.onload=a,b.appendChild(c)}loadScript(function(){beTracker.t({hash:"4c58e266326abbe12fe155faf24bb43a"})});</script>`;

function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function shopifyFetch(shop, token, pathname, init = {}) {
  const url = `https://${shop}/admin/api/${API_VERSION}${pathname}`;
  const headers = {
    "X-Shopify-Access-Token": token,
    "Content-Type": "application/json",
    ...init.headers,
  };
  return fetch(url, { ...init, headers });
}

async function main() {
  loadEnvLocal();
  const shop = (process.env.SHOPIFY_SHOP_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "";
  if (!shop || !token) {
    console.error("Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN (.env.local).");
    process.exit(1);
  }

  const snippet = (process.env.METRICOOL_SNIPPET_HTML || DEFAULT_SNIPPET).trim();
  if (!snippet.includes("<script") || !snippet.includes("</script>")) {
    console.error("METRICOOL_SNIPPET_HTML must be a full <script>...</script> block.");
    process.exit(1);
  }

  const marker = "tracker.metricool.com/resources/be.js";
  const themesRes = await shopifyFetch(shop, token, "/themes.json");
  if (!themesRes.ok) {
    const t = await themesRes.text();
    console.error("themes.json failed:", themesRes.status, t.slice(0, 500));
    process.exit(1);
  }
  const { themes } = await themesRes.json();
  const main = themes.find((t) => t.role === "main");
  if (!main) {
    console.error("No theme with role=main.");
    process.exit(1);
  }

  const assetKey = "layout/theme.liquid";
  const assetUrl = `/themes/${main.id}/assets.json?${new URLSearchParams({ "asset[key]": assetKey })}`;
  const getRes = await shopifyFetch(shop, token, assetUrl);
  if (!getRes.ok) {
    const t = await getRes.text();
    console.error(`GET ${assetKey} failed:`, getRes.status, t.slice(0, 500));
    process.exit(1);
  }
  const { asset } = await getRes.json();
  if (!asset?.value) {
    console.error("Asset has no value.");
    process.exit(1);
  }

  let value = asset.value;
  if (value.includes(marker)) {
    console.log(`Already present (${marker}) in ${assetKey} on theme "${main.name}" (${main.id}). No change.`);
    return;
  }
  if (!value.includes("</body>")) {
    console.error(`No </body> in ${assetKey}; add the snippet manually or adjust layout file.`);
    process.exit(1);
  }

  const injection = `\n<!-- Metricool tracking (Carbon WMS script) -->\n${snippet}\n`;
  value = value.replace("</body>", `${injection}</body>`);

  const putRes = await shopifyFetch(shop, token, `/themes/${main.id}/assets.json`, {
    method: "PUT",
    body: JSON.stringify({ asset: { key: assetKey, value } }),
  });
  if (!putRes.ok) {
    const t = await putRes.text();
    console.error("PUT asset failed:", putRes.status, t.slice(0, 800));
    process.exit(1);
  }

  console.log(`Updated ${assetKey} on live theme "${main.name}" (id ${main.id}). Open Metricool and click Verify.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
