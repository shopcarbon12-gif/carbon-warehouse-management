// Owner, 2026-10-17: "any matrix item with 0 qty to be archived. ... remove the complete color from the
// matrix only if all its color variants are 0 qty ... then remove the pictures that belong to that color.
// bottom line - i want my catalog to be only with whatever have any stock!"
//
// Stock = live (in-stock) RFID tags at ANY location, or manual qty for manual-only matrices — the catalog's
// own qty rule, widened to every location so nothing with stock anywhere is touched. Stock sitting on an
// archived SKU row of the same SKU code / colour still counts (Braided Bracelet E: 5 LIVE tags on its
// pre-rename row).
//   WMS:     PATCH /api/inventory/catalog/matrices/:id {archived:true}  (zero-stock products)
//            PATCH /api/inventory/catalog/custom-skus/:id {archived:true} (zero-stock colours)
//   Shopify: zero-stock products that are ACTIVE → POST /api/shopify/status ARCHIVED (via the WMS)
//            zero-stock colours → productVariantsBulkDelete + productDeleteMedia of that colour's photos
//            (the photo list was checked by eye: arch/photo-plan.json)
// Backup first: docs/catalog/evidence/archive-zero-stock-backup-2026-10-17.json + original images in
// ~/CarbonCatalogBackup-2026-10-17/.
//   node archive-zero-stock.mjs            # dry run
//   node archive-zero-stock.mjs --write
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import pg from "/home/carbondev/dev/carbon-warehouse-management/node_modules/pg/lib/index.js";
import { gql } from "../../seorev/samples/shop.mjs";

const WRITE = process.argv.includes("--write");
const REPO = "/home/carbondev/dev/carbon-warehouse-management";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const BACKUP = path.join(HERE, "archive-zero-stock-backup-2026-10-17.json");
const IMGDIR = path.join(os.homedir(), "CarbonCatalogBackup-2026-10-17");
const WMS = "https://wms.shopcarbon.com";
const LOCATION = "75a2569b-4c91-4211-9ce4-997254e5f868";
const photoPlan = JSON.parse(fs.readFileSync(path.join(HERE, "..", "photo-plan.json"), "utf8"));

const env = (f, k) => fs.readFileSync(f, "utf8").split("\n").find((l) => l.startsWith(k + "="))?.slice(k.length + 1).trim().replace(/^['"]|['"]$/g, "");
const raw = env(`${REPO}/.env.coolify.local`, "DATABASE_URL");
const u = new URL(raw); u.hostname = "127.0.0.1"; u.port = "16543";
const db = new pg.Client({ connectionString: u.toString(), ssl: false });
await db.connect();
await db.query("SET default_transaction_read_only = on");

// ---- 1. Plan from live data -------------------------------------------------------------
const rows = (await db.query(`
  SELECT m.id::text matrix_id, m.description name, m.upc, m.shopify_product_id::text shop_pid, COALESCE(m.is_manual_only,false) manual,
         cs.id::text sku_id, cs.sku, cs.archived, COALESCE(NULLIF(btrim(cs.color_code),''),'(no colour)') colour, cs.size,
         (SELECT count(*) FROM items i WHERE i.custom_sku_id=cs.id AND i.status='in-stock')::int live,
         (SELECT COALESCE(sum(GREATEST(miq.current_qty,0)),0) FROM manual_item_qty miq WHERE miq.custom_sku_id=cs.id)::int mqty
    FROM custom_skus cs JOIN matrices m ON m.id=cs.matrix_id`)).rows;
await db.end();
const byM = new Map();
for (const r of rows) { if (!byM.has(r.matrix_id)) byM.set(r.matrix_id, []); byM.get(r.matrix_id).push(r); }
const q = (r) => (r.manual ? r.mqty : r.live);
const archMatrices = [], archColours = [], kept = [];
for (const [mid, rs] of byM) {
  const act = rs.filter((r) => !r.archived);
  if (!act.length) continue;
  const total = rs.reduce((a, r) => a + q(r), 0);
  if (total === 0) { archMatrices.push({ matrix_id: mid, name: act[0].name, upc: act[0].upc, shop_pid: act[0].shop_pid, skus: act.map((r) => ({ id: r.sku_id, sku: r.sku, colour: r.colour, size: r.size })) }); continue; }
  // stock per SKU code across every row (an archived twin row keeps its stock)
  const codeStock = {}; for (const r of rs) codeStock[r.sku] = (codeStock[r.sku] || 0) + q(r);
  const colStock = {}; for (const r of rs) colStock[r.colour] = (colStock[r.colour] || 0) + q(r);
  const cols = {}; for (const r of act) (cols[r.colour] ||= []).push(r);
  for (const [c, list] of Object.entries(cols)) {
    const stock = colStock[c] + list.reduce((a, r) => a + (codeStock[r.sku] - q(r)), 0);
    if (stock === 0) archColours.push({ matrix_id: mid, name: list[0].name, upc: list[0].upc, shop_pid: list[0].shop_pid, colour: c, skus: list.map((r) => ({ id: r.sku_id, sku: r.sku, size: r.size })) });
    else if (list.every((r) => q(r) === 0)) kept.push(`${list[0].name} ${c} (stock on an archived twin row)`);
  }
}
// Shopify state for the affected products
const pidNum = (p) => (p || "").split("/").pop();
const shopIds = [...new Set([...archMatrices, ...archColours].map((x) => pidNum(x.shop_pid)).filter(Boolean))];
const shop = {};
for (let i = 0; i < shopIds.length; i += 50) {
  const ids = shopIds.slice(i, i + 50).map((n) => `gid://shopify/Product/${n}`);
  const r = await gql(`query($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id handle title status
    variants(first:100){ nodes{ id sku title price barcode inventoryQuantity selectedOptions{ name value } } }
    media(first:100){ nodes{ id alt mediaContentType ... on MediaImage{ image{ url } } } } } } }`, { ids });
  for (const p of r.nodes) if (p) shop[pidNum(p.id)] = p;
}
const shopArchive = archMatrices.filter((m) => shop[pidNum(m.shop_pid)]?.status === "ACTIVE");
const colourOps = [];
for (const c of archColours) {
  const p = shop[pidNum(c.shop_pid)];
  if (!p || p.status !== "ACTIVE") continue;
  const vars = p.variants.nodes.filter((v) => v.selectedOptions.some((o) => /colou?r/i.test(o.name) && o.value.toUpperCase() === c.colour.toUpperCase()));
  const plan = photoPlan[p.handle];
  const gone = new Set((plan?.gone || []).map((s) => s.toUpperCase()));
  const mediaIds = gone.has(c.colour.toUpperCase()) ? (plan.media_ids || []) : [];
  colourOps.push({ handle: p.handle, product_id: p.id, colour: c.colour, variants: vars, media: p.media.nodes.filter((m) => mediaIds.includes(m.id)), plannedMedia: mediaIds.length });
}
// One delete per product: dedupe media across that product's colours
const mediaByProduct = {};
for (const op of colourOps) for (const m of op.media) (mediaByProduct[op.product_id] ||= new Map()).set(m.id, m);

console.log(`WMS products to archive: ${archMatrices.length} (${archMatrices.reduce((a, m) => a + m.skus.length, 0)} variants)`);
console.log(`WMS colours to archive:  ${archColours.length} in ${new Set(archColours.map((c) => c.matrix_id)).size} products (${archColours.reduce((a, c) => a + c.skus.length, 0)} variants)`);
console.log(`Kept (stock on archived twin rows): ${kept.join("; ") || "none"}`);
console.log(`Shopify products to archive: ${shopArchive.map((m) => shop[pidNum(m.shop_pid)].handle).join(", ")}`);
console.log(`Shopify colours to remove: ${colourOps.length} | variants ${colourOps.reduce((a, o) => a + o.variants.length, 0)} | photos ${Object.values(mediaByProduct).reduce((a, m) => a + m.size, 0)}`);
for (const o of colourOps) console.log(`   ${o.handle} ${o.colour}: ${o.variants.length} variants, ${o.media.length}/${o.plannedMedia} planned photos`);
const missing = colourOps.filter((o) => o.media.length !== o.plannedMedia);
if (missing.length) { console.log("ABORT: planned photos no longer match the live gallery:", missing.map((o) => o.handle)); process.exit(1); }
if (!WRITE) { console.log("DRY RUN — nothing changed"); process.exit(0); }

// ---- 2. Backup ---------------------------------------------------------------------------
fs.mkdirSync(IMGDIR, { recursive: true });
fs.writeFileSync(BACKUP, JSON.stringify({ takenAt: new Date().toISOString(), archMatrices, archColours, kept,
  shopifyProductsArchived: shopArchive.map((m) => ({ matrix_id: m.matrix_id, handle: shop[pidNum(m.shop_pid)].handle, status_before: "ACTIVE" })),
  shopifyColourOps: colourOps.map((o) => ({ handle: o.handle, product_id: o.product_id, colour: o.colour, variants: o.variants, media: o.media.map((m) => ({ id: m.id, alt: m.alt, url: m.image?.url })) })) }, null, 1));
for (const o of colourOps) for (const m of o.media) {
  const f = path.join(IMGDIR, `${o.handle}__${m.id.split("/").pop()}.${(m.image.url.split("?")[0].split(".").pop() || "jpg")}`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, Buffer.from(await (await fetch(m.image.url)).arrayBuffer()));
}
console.log("backup written:", BACKUP, "| images:", fs.readdirSync(IMGDIR).length, "in", IMGDIR);

// ---- 3. WMS (through the API, so it lands in the activity history) ------------------------
const pw = env(`${REPO}/.env.agent-secrets`, "SEED_ADMIN_PASSWORD");
const login = await fetch(`${WMS}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: pw }) });
if (!login.ok) throw new Error("login " + login.status);
let cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const loc = await fetch(`${WMS}/api/session/location`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ locationId: LOCATION }) });
const setc = loc.headers.getSetCookie(); if (setc.length) cookie = setc.map((c) => c.split(";")[0]).join("; ");
const api = async (method, p, body) => {
  for (let a = 0; a < 4; a++) {
    const r = await fetch(WMS + p, { method, headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });
    if (r.ok) return r.json();
    if (r.status >= 500 || r.status === 429) { await new Promise((s) => setTimeout(s, 1500 * (a + 1))); continue; }
    throw new Error(`${method} ${p} ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  throw new Error(`${method} ${p} retries exhausted`);
};
const log = { wmsMatrices: 0, wmsSkus: 0, shopArchived: [], variantsDeleted: 0, mediaDeleted: 0, errors: [] };
for (const m of archMatrices) {
  try { const r = await api("PATCH", `/api/inventory/catalog/matrices/${m.matrix_id}`, { archived: true }); log.wmsMatrices++; log.wmsSkus += r.updated ?? 0; }
  catch (e) { log.errors.push(`matrix ${m.name}: ${e.message}`); }
}
for (const c of archColours) for (const s of c.skus) {
  try { await api("PATCH", `/api/inventory/catalog/custom-skus/${s.id}`, { archived: true }); log.wmsSkus++; }
  catch (e) { log.errors.push(`sku ${s.sku}: ${e.message}`); }
}
console.log(`WMS: ${log.wmsMatrices} products archived, ${log.wmsSkus} variants archived`);

// ---- 4. Shopify ---------------------------------------------------------------------------
for (const m of shopArchive) {
  try { await api("POST", "/api/shopify/status", { matrixId: m.matrix_id, status: "ARCHIVED" }); log.shopArchived.push(shop[pidNum(m.shop_pid)].handle); }
  catch (e) { log.errors.push(`shopify archive ${m.name}: ${e.message}`); }
}
for (const o of colourOps) {
  if (!o.variants.length) continue;
  const r = await gql(`mutation($p:ID!,$v:[ID!]!){ productVariantsBulkDelete(productId:$p, variantsIds:$v){ userErrors{ field message } } }`, { p: o.product_id, v: o.variants.map((v) => v.id) });
  const errs = r.productVariantsBulkDelete?.userErrors || [];
  if (errs.length) log.errors.push(`${o.handle} ${o.colour} variants: ${errs.map((e) => e.message).join("; ")}`); else log.variantsDeleted += o.variants.length;
}
for (const [pid, map] of Object.entries(mediaByProduct)) {
  const r = await gql(`mutation($p:ID!,$m:[ID!]!){ productDeleteMedia(productId:$p, mediaIds:$m){ deletedMediaIds mediaUserErrors{ field message } } }`, { p: pid, m: [...map.keys()] });
  const errs = r.productDeleteMedia?.mediaUserErrors || [];
  if (errs.length) log.errors.push(`${pid} media: ${errs.map((e) => e.message).join("; ")}`); else log.mediaDeleted += (r.productDeleteMedia?.deletedMediaIds || []).length;
}
console.log(JSON.stringify(log, null, 1));
fs.writeFileSync(path.join(HERE, "archive-zero-stock-result-2026-10-17.json"), JSON.stringify(log, null, 1));
