/**
 * Google Merchant Center — supplemental overlay sync.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Canada shipping rate group in Merchant Center is WEIGHT-BASED, so Google requires
 * `shipping_weight` on every item. That value used to arrive from Shopify's Google &
 * YouTube "Shipping Information" sync — but that sync also wrote a product-level
 * `country: CA, price: $0` override with no price condition, i.e. it advertised free
 * Canadian shipping on ~792 items priced under the $125 threshold. Understating shipping
 * is a documented Google disapproval/suspension trigger, so the sync was turned off.
 *
 * Consequence: shipping_weight now comes ONLY from this overlay. Any product added or
 * re-synced since the last run has no weight and WILL be disapproved until this runs again.
 *
 * It also fills two gaps Shopify does not supply:
 *   - returnPolicyLabel=final-sale on accessories / undergarments / gift cards, so Google
 *     stops advertising 14-day returns on goods the store treats as final sale.
 *   - gender / ageGroup on the Spanish feed, which lags the metafield backfill. Values are
 *     borrowed from each item's English twin (same productId_variantId = same garment).
 *
 * Idempotent and safe to re-run. Writes only to the supplemental data source; never touches
 * the Shopify-owned primary sources.
 *
 * Usage:
 *   node scripts/gmc-overlay-sync.mjs           # apply
 *   node scripts/gmc-overlay-sync.mjs --dry-run # report what would change
 *
 * Credentials: .env.gmc-oauth (gitignored). See scripts/gmc-oauth.mjs to (re)mint them.
 */
import { readFileSync, appendFileSync } from 'node:fs';

const REPO = '/home/carbondev/dev/carbon-warehouse-management';
const ENVF = `${REPO}/.env.gmc-oauth`;
const LOG = `${REPO}/.gmc-overlay-sync.log`;
const MID = '779385360';
const SUPPLEMENTAL = '10724293906';          // carbon-returns-overlay
const DRY = process.argv.includes('--dry-run');

const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); try { appendFileSync(LOG, line + '\n'); } catch {} };

function env(file) {
  const out = {};
  for (const l of readFileSync(file, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !out[m[1]]) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
  return out;
}
const g = env(ENVF);
const shop = (() => { const o = {}; for (const f of [`${REPO}/.env.coolify.local`, `${REPO}/.env.agent-secrets`]) { try { Object.assign(o, { ...env(f), ...o }); } catch {} } return o; })();

let token = null;
const newTok = async () => {
  const b = new URLSearchParams({ client_id: g.GMC_OAUTH_CLIENT_ID, client_secret: g.GMC_OAUTH_CLIENT_SECRET, refresh_token: g.GMC_OAUTH_REFRESH_TOKEN, grant_type: 'refresh_token' });
  const j = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: b })).json();
  if (!j.access_token) throw new Error('token refresh failed: ' + JSON.stringify(j).slice(0, 200));
  token = j.access_token; return token;
};
const H = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

/** Shopify variant weights — the source of truth for shipping_weight. */
async function shopifyWeights() {
  const url = `https://${shop.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/graphql.json`;
  const W = {}; let cursor = null, pages = 0;
  while (pages < 60) {
    let d = null;
    for (let i = 0; i < 6; i++) {
      const r = await fetch(url, { method: 'POST', headers: { 'X-Shopify-Access-Token': shop.SHOPIFY_ADMIN_ACCESS_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ query: `query($c:String){ productVariants(first:250, after:$c){ pageInfo{hasNextPage endCursor} nodes{ id inventoryItem{ measurement{ weight{ value unit } } } } } }`, variables: { c: cursor } }) });
      const j = await r.json();
      if (j.errors && JSON.stringify(j.errors).includes('THROTTLED')) { await new Promise(s => setTimeout(s, 2500)); continue; }
      if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
      d = j.data; break;
    }
    if (!d) break;
    for (const v of d.productVariants.nodes) { const w = v.inventoryItem?.measurement?.weight; if (w?.value) W[v.id.split('/').pop()] = w.value; }
    if (!d.productVariants.pageInfo.hasNextPage) break;
    cursor = d.productVariants.pageInfo.endCursor; pages++;
    await new Promise(s => setTimeout(s, 300));
  }
  return W;
}

/** Every live item in the account, excluding the overlay's own rows. */
async function liveItems() {
  const out = []; let page = '', n = 0;
  do {
    if (n && n % 12 === 0) await newTok();
    const r = await fetch(`https://merchantapi.googleapis.com/products/v1/accounts/${MID}/products?pageSize=250${page ? `&pageToken=${page}` : ''}`, { headers: H() });
    if (r.status === 401) { await newTok(); continue; }
    if (r.status !== 200) { log(`  product list stopped at HTTP ${r.status}`); break; }
    const j = await r.json();
    for (const p of j.products || []) {
      if ((p.dataSource || '').endsWith(SUPPLEMENTAL)) continue;
      const a = p.productAttributes || {};
      out.push({ offerId: p.offerId, lang: p.contentLanguage, feedLabel: p.feedLabel,
        k: (p.offerId.match(/(\d+_\d+)$/) || [])[1], title: a.title || '', pt: (a.productTypes || []).join(' | '),
        gender: a.gender, ageGroup: a.ageGroup, color: a.color, size: a.size, weight: a.shippingWeight, label: a.returnPolicyLabel });
    }
    page = j.nextPageToken || ''; n++;
  } while (page && n < 80);
  return out;
}

const FINAL = /\bACCESSORIES\b|\bACCESORIOS\b/i, UNDER = /boxer|brief|underwear/i, GIFT = /gift ?card/i;
const fromTitle = (t) => { const m = t.match(/([A-Za-zÀ-ÿ ]+)\s*\/\s*([A-Za-z0-9]+)\s*$/); return m ? { color: m[1].trim(), size: m[2].trim() } : {}; };

(async () => {
  log(`--- gmc-overlay-sync start${DRY ? ' (dry run)' : ''} ---`);
  await newTok();
  const W = await shopifyWeights();
  log(`shopify variant weights: ${Object.keys(W).length}`);
  const items = await liveItems();
  log(`live merchant items: ${items.length}`);

  const ref = {};
  for (const it of items) if (it.lang === 'en' && it.k) ref[it.k] = it;

  const rows = [];
  for (const it of items) {
    const attrs = {};
    const w = W[(it.offerId.match(/_(\d+)$/) || [])[1]];
    if (w) attrs.shippingWeight = { value: w, unit: 'lb' };
    if (FINAL.test(it.pt) || UNDER.test(it.title) || UNDER.test(it.pt) || GIFT.test(it.title)) attrs.returnPolicyLabel = 'final-sale';
    const twin = it.k ? ref[it.k] : null;
    if (!it.gender && twin?.gender) attrs.gender = twin.gender;
    if (!it.ageGroup && (twin?.ageGroup || twin?.gender)) attrs.ageGroup = twin?.ageGroup || 'ADULT';
    if (!it.color) { const d = twin?.color || fromTitle(it.title).color; if (d) attrs.color = d; }
    if (!it.size) { const d = twin?.size || fromTitle(it.title).size; if (d) attrs.size = d; }
    if (Object.keys(attrs).length) rows.push({ ...it, attrs });
  }
  const needWeight = items.filter(i => !i.weight).length;
  log(`rows to write: ${rows.length}   (items currently lacking weight: ${needWeight})`);
  if (DRY) { log('dry run — nothing written'); return; }

  const url = `https://merchantapi.googleapis.com/products/v1/accounts/${MID}/productInputs:insert?dataSource=accounts/${MID}/dataSources/${SUPPLEMENTAL}`;
  let ok = 0, fail = 0, notFound = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i && i % 300 === 0) await newTok();
    const r0 = rows[i];
    try {
      const r = await fetch(url, { method: 'POST', headers: H(), body: JSON.stringify({ offerId: r0.offerId, contentLanguage: r0.lang, feedLabel: r0.feedLabel, productAttributes: r0.attrs }) });
      if (r.status === 200) ok++;
      else if (r.status === 429) { await new Promise(s => setTimeout(s, 4000)); i--; continue; }
      else if (r.status === 404) notFound++;             // product expired between listing and write
      else fail++;
    } catch { fail++; }
    await new Promise(s => setTimeout(s, 120));
  }
  log(`done: ok=${ok} notFound=${notFound} failed=${fail} of ${rows.length}`);
})().catch(err => { log(`FATAL ${err.message}`); process.exit(1); });
