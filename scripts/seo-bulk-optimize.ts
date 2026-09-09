/* eslint-disable no-console */
/**
 * Bulk SEO pass over the active Shopify catalog.
 *
 * Runs the SAME optimizer the Matrix → SEO tab runs (lib/seo/optimizeCore) over
 * every active product that has at least one image, and writes the result back
 * to Shopify. Doing it in the tab means one product per click; this is the same
 * work, once, for the whole catalog.
 *
 * DRY RUN BY DEFAULT. Nothing is written to Shopify unless --write is passed.
 *
 *   npx tsx scripts/seo-bulk-optimize.ts --limit 5            # sample, no writes
 *   npx tsx scripts/seo-bulk-optimize.ts --limit 5 --write    # sample, writes
 *   npx tsx scripts/seo-bulk-optimize.ts --write              # whole catalog
 *
 * Flags:
 *   --limit N        stop after N products (default: all)
 *   --concurrency N  products in flight (default 4)
 *   --write          actually write to Shopify
 *   --only <id,id>   restrict to specific product ids (numeric or gid)
 *   --resume         skip products already recorded done in the state file
 *   --no-vision      skip photo analysis (cheaper, lower quality)
 *
 * Every product's before/after lands in scripts/.seo-bulk/report.jsonl, and the
 * set of completed ids in scripts/.seo-bulk/state.json, so an interrupted run
 * resumes without paying for the same products twice.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { optimizeSeo } from "@/lib/seo/optimizeCore";
import { applySetBanner, pictureForProduct, type SetPicture } from "@/lib/seo/setNotice";
import { scoreAll } from "@/lib/seo/deterministic";
import type { ProductContext, SeoFields, Scorecard } from "@/lib/seo/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "scripts", ".seo-bulk");
const REPORT = path.join(OUT_DIR, "report.jsonl");
const STATE = path.join(OUT_DIR, "state.json");

/* ---------------------------------------------------------------- env ---- */

function loadEnvFile(file: string): Record<string, string> {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/*
 * Production credentials. .env.coolify.local is spread LAST so it wins: this
 * writes to the live storefront and reads the live Set flags, and
 * .env.agent-secrets still carries a DATABASE_URL for the decommissioned
 * Hetzner box — letting it override sends the run at a host that no longer
 * answers.
 */
const env = { ...loadEnvFile(".env.agent-secrets"), ...loadEnvFile(".env.coolify.local") };
const SHOP = (process.env.SHOPIFY_SHOP_DOMAIN || env.SHOPIFY_SHOP_DOMAIN || "").trim();
const TOKEN = (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim();
const API_VERSION = (process.env.SHOPIFY_API_VERSION || "2025-01").trim();
const OPENAI_KEY = (() => {
  const direct = (process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || "").trim();
  if (direct) return direct;
  const f = (process.env.OPENAI_API_KEY_FILE || "").trim();
  if (f && fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  return "";
})();

/*
 * Products this run never touches, by handle.
 *
 * The Gift Card is not a garment: it has no WMS matrix, no sizes and no stock,
 * its copy is transactional rather than descriptive, and its URL is the kind of
 * thing that gets linked from email and help pages. Optimising it the way a
 * product is optimised makes it worse, so it is left alone by name rather than
 * by whoever remembers to pass a flag.
 */
const EXCLUDED_HANDLES = new Set(["gifted-product", "gift-card"]);

/* ---------------------------------------------------------------- args ---- */

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIMIT = Number(val("--limit") || 0) || 0;
const CONCURRENCY = Math.max(1, Math.min(Number(val("--concurrency") || 4) || 4, 8));
const WRITE = has("--write");
const RESUME = has("--resume");
const USE_VISION = !has("--no-vision");
const ONLY = new Set(
  String(val("--only") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("gid://") ? s : `gid://shopify/Product/${s}`)),
);

/* ------------------------------------------------------------- shopify ---- */

type Json = Record<string, any>;

let throttleWaitMs = 0;

async function gql<T = Json>(query: string, variables?: Json): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (throttleWaitMs > 0) {
      await sleep(throttleWaitMs);
      throttleWaitMs = 0;
    }
    let res: Response;
    try {
      res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const json = (await res.json()) as Json;
    if (json.errors) {
      const text = JSON.stringify(json.errors);
      /* Shopify's GraphQL limit is cost-based; backing off is the documented
         response, and it is not an error worth aborting the whole run for. */
      if (/throttl/i.test(text)) {
        await sleep(2500 * (attempt + 1));
        continue;
      }
      throw new Error(text.slice(0, 400));
    }
    const cost = json.extensions?.cost?.throttleStatus;
    if (cost && cost.currentlyAvailable < 200) throttleWaitMs = 1000;
    return json.data as T;
  }
  throw new Error("Shopify GraphQL: retries exhausted");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PRODUCT_FIELDS = `
  id title handle status totalInventory descriptionHtml productType vendor tags onlineStoreUrl
  seo { title description }
  focusKeyword: metafield(namespace: "carbon_seo", key: "focus_keyword") { value }
  priceRangeV2 { minVariantPrice { amount currencyCode } }
  media(first: 50) { nodes { ... on MediaImage { id image { url altText } } } }
  variants(first: 50) { nodes { id sku barcode price selectedOptions { name value } } }
`;

async function fetchActiveProducts(): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | null = null;
  do {
    const d: Json = await gql(
      /* Drafts included on purpose: a product can be unpublished and still have
         photos worth writing SEO for, and optimizing it costs nothing extra.
         Archived is excluded — that is the bin. Status is never written by this
         script, so nothing here can publish a product. */
      `query($cursor:String){ products(first:50, after:$cursor, query:"status:active OR status:draft"){
         pageInfo{hasNextPage endCursor} nodes{ ${PRODUCT_FIELDS} } } }`,
      { cursor },
    );
    out.push(...d.products.nodes);
    cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
    process.stdout.write(`\r  fetched ${out.length} active products`);
  } while (cursor);
  process.stdout.write("\n");
  return out;
}

/* Mirrors the audit route's mapping exactly, so the score the bulk pass computes
   is the score the SEO tab would show for the same product. */
function toFields(p: Json): SeoFields {
  const media = (p.media?.nodes || []).filter((n: Json) => n && n.id);
  /* The keyword the copy was written around, read back from the metafield the
     publish step stores. Without it the scorer has nothing to check seoTitle,
     metaDescription and bodyHtml against and every already-optimized product
     reads as 89 — so nothing is ever skipped and good copy is rewritten on
     every run. The SEO tab had the same gap. */
  const focusKeyword = String(p.focusKeyword?.value || "").trim();
  return {
    focusKeyword,
    title: p.title || "",
    seoTitle: p.seo?.title || "",
    metaDescription: p.seo?.description || "",
    handle: p.handle || "",
    bodyHtml: p.descriptionHtml || "",
    tags: p.tags || [],
    productType: p.productType || "",
    vendor: p.vendor || "",
    imageAlts: media.map((n: Json) => ({
      id: String(n.id || ""),
      url: String(n.image?.url || ""),
      altText: String(n.image?.altText || ""),
    })),
  };
}

function toContext(p: Json): ProductContext {
  const media = (p.media?.nodes || []).filter((n: Json) => n && n.id);
  const variants = p.variants?.nodes || [];
  return {
    productId: p.id,
    handle: p.handle || "",
    title: p.title || "",
    productType: p.productType || "",
    vendor: p.vendor || "",
    tags: p.tags || [],
    price: p.priceRangeV2?.minVariantPrice?.amount || undefined,
    currency: p.priceRangeV2?.minVariantPrice?.currencyCode || undefined,
    variantSkus: variants.map((v: Json) => String(v.sku || "")).filter(Boolean).slice(0, 10),
    barcodes: variants.map((v: Json) => String(v.barcode || "")).filter(Boolean).slice(0, 10),
    colors: Array.from(
      new Set(
        variants
          .flatMap((v: Json) => v.selectedOptions || [])
          .filter((o: Json) => /colou?r/i.test(String(o?.name || "")))
          .map((o: Json) => String(o?.value || "").trim())
          .filter(Boolean),
      ),
    ).slice(0, 12) as string[],
    imageCount: media.length,
    onlineStoreUrl: p.onlineStoreUrl || undefined,
    /* Drives the "Complete the Look" notice. The flag lives in the WMS, not on
       the Shopify product, so it is looked up once up front (see setFlags). */
    isSet: SET_PICTURES.has(String(p.id)),
  };
}

/**
 * Shopify product ids flagged as part of a matching set.
 *
 * Read once for the whole run rather than per product: this is a few hundred
 * rows, and a query per product would add a database round-trip to every
 * optimization for a value that cannot change mid-run.
 */
const SET_PICTURES = new Map<string, SetPicture>();

async function loadSetFlags(): Promise<number> {
  const url = (process.env.DATABASE_URL || env.DATABASE_URL || "").trim();
  if (!url) throw new Error("DATABASE_URL missing — cannot read the Set flags.");
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    const r = await client.query<{ shopify_product_id: string; upc: string | null; skus: string[] | null }>(
      `SELECT m.shopify_product_id, m.upc,
              array_agg(cs.sku) FILTER (WHERE cs.sku IS NOT NULL) AS skus
         FROM matrices m
         LEFT JOIN custom_skus cs ON cs.matrix_id = m.id
        WHERE m.is_set = true AND m.shopify_product_id IS NOT NULL
        GROUP BY m.id`,
    );
    for (const row of r.rows) {
      const picture = pictureForProduct(row.skus || [], row.upc);
      if (!picture) continue;
      const raw = String(row.shopify_product_id);
      /* Stored ids are sometimes bare numbers and sometimes gids; hold both
         forms so the lookup cannot miss on formatting alone. */
      SET_PICTURES.set(raw, picture);
      SET_PICTURES.set(raw.startsWith("gid://") ? raw : `gid://shopify/Product/${raw}`, picture);
    }
    return r.rows.length;
  } finally {
    await client.end();
  }
}

/* --------------------------------------------------------------- write ---- */

async function publish(
  productId: string,
  fields: SeoFields,
  focusKeyword: string,
  secondary: string[],
  score: number,
  oldHandle = "",
) {
  const input: Json = { id: productId };
  const seo: Json = {};
  if (fields.seoTitle) seo.title = fields.seoTitle.trim();
  if (fields.metaDescription) seo.description = fields.metaDescription.trim();
  if (Object.keys(seo).length) input.seo = seo;
  if (fields.bodyHtml) {
    /* The optimizer strips the "Complete the Look" banner so the model never
       sees boilerplate, which means publishing its copy verbatim would tear the
       banner off every set product this run touches. Put it back. */
    input.descriptionHtml = applySetBanner(fields.bodyHtml, SET_PICTURES.get(productId) ?? null);
  }
  if (Array.isArray(fields.tags) && fields.tags.length) {
    input.tags = fields.tags.map((t) => String(t || "").trim()).filter(Boolean);
  }
  /* The product title is still never sent: it is a preserved brand name.
     The handle IS sent now — it should be the product name, hyphenated, and the
     optimizer only proposes one when the current slug does not match. Changing
     it rewrites a live URL, which is why the redirect below is not optional. */
  const wantHandle = String(fields.handle || "").trim().toLowerCase();
  if (wantHandle && wantHandle !== String(oldHandle || "").trim().toLowerCase()) {
    input.handle = wantHandle;
  }

  const UPDATE = `mutation($input: ProductInput!){
    productUpdate(input:$input){ product{ id handle } userErrors{ field message } } }`;

  let r = await gql(UPDATE, { input });
  let errs = r.productUpdate?.userErrors || [];

  /*
   * A taken handle is rejected, not quietly suffixed.
   *
   * I assumed productUpdate behaved like productCreate and appended a number.
   * It does not — it fails the whole mutation, which meant one product's copy,
   * alts and metafields were all lost to a handle clash. Two products may share
   * a name legitimately, so try a suffix, and if that is no good drop the handle
   * and publish everything else rather than losing the run over a URL.
   */
  if (errs.length && input.handle && errs.some((e: Json) => /handle/i.test(String(e.message)))) {
    const base = String(input.handle);
    for (let n = 2; n <= 5 && errs.length; n += 1) {
      input.handle = `${base}-${n}`;
      r = await gql(UPDATE, { input });
      errs = r.productUpdate?.userErrors || [];
    }
    if (errs.length) {
      delete input.handle;
      r = await gql(UPDATE, { input });
      errs = r.productUpdate?.userErrors || [];
    }
  }
  if (errs.length) throw new Error(`productUpdate: ${errs.map((e: Json) => e.message).join("; ")}`);

  /* 301 from the old URL, pointing at the handle Shopify actually assigned —
     on a collision it appends a suffix, and redirecting to the handle we asked
     for would send every old link to a 404. */
  const assigned = String(r.productUpdate?.product?.handle || "").trim();
  if (input.handle && oldHandle && assigned && assigned !== String(oldHandle).toLowerCase()) {
    const rd = await gql(
      `mutation($redirect: UrlRedirectInput!){
         urlRedirectCreate(urlRedirect:$redirect){ userErrors{ field message } } }`,
      { redirect: { path: `/products/${oldHandle}`, target: `/products/${assigned}` } },
    );
    const rde = rd.urlRedirectCreate?.userErrors || [];
    if (rde.length) throw new Error(`redirect: ${rde.map((e: Json) => e.message).join("; ")}`);
  }

  const alts = (fields.imageAlts || [])
    .filter((a) => String(a.id).startsWith("gid://shopify/MediaImage/") && String(a.altText || "").trim())
    .map((a) => ({ id: a.id, alt: a.altText.trim() }));
  if (alts.length) {
    const m = await gql(
      `mutation($productId: ID!, $media: [UpdateMediaInput!]!){
         productUpdateMedia(productId:$productId, media:$media){ mediaUserErrors{ field message } } }`,
      { productId, media: alts },
    );
    const me = m.productUpdateMedia?.mediaUserErrors || [];
    if (me.length) throw new Error(`alts: ${me.map((e: Json) => e.message).join("; ")}`);
  }

  /* The focus keyword is what the scorer checks seoTitle / metaDescription /
     bodyHtml against — over half the weighting. It was never persisted, so a
     re-audit had no keyword to check and those three fields always scored as
     failures no matter how good the copy was. Storing it here is what makes a
     100 durable and re-verifiable rather than a number seen once. */
  const metafields = [
    { ownerId: productId, namespace: "carbon_seo", key: "optimized_at", type: "single_line_text_field", value: new Date().toISOString() },
    { ownerId: productId, namespace: "carbon_seo", key: "score", type: "number_integer", value: String(Math.round(score)) },
  ];
  if (focusKeyword) {
    metafields.push({ ownerId: productId, namespace: "carbon_seo", key: "focus_keyword", type: "single_line_text_field", value: focusKeyword });
  }
  if (secondary.length) {
    metafields.push({ ownerId: productId, namespace: "carbon_seo", key: "secondary_keywords", type: "list.single_line_text_field", value: JSON.stringify(secondary.slice(0, 8)) });
  }
  const mf = await gql(
    `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ field message } } }`,
    { m: metafields },
  );
  const mfe = mf.metafieldsSet?.userErrors || [];
  if (mfe.length) throw new Error(`metafields: ${mfe.map((e: Json) => e.message).join("; ")}`);

  /* Shopify mirrors seo.title / seo.description into global.title_tag and
     global.description_tag, which is what most themes and feed apps actually
     read. productUpdate sets them, but only where they already exist — a
     product that never had them keeps scoring as missing in feed tools. */
}

/* ---------------------------------------------------------------- main ---- */

function loadState(): { done: string[] } {
  if (!RESUME || !fs.existsSync(STATE)) return { done: [] };
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return { done: [] };
  }
}

async function main() {
  if (!SHOP || !TOKEN) throw new Error("Shopify credentials missing (SHOPIFY_SHOP_DOMAIN / SHOPIFY_ADMIN_ACCESS_TOKEN).");
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY missing.");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Shop: ${SHOP}   mode: ${WRITE ? "WRITE (live)" : "DRY RUN (no writes)"}   vision: ${USE_VISION ? "on" : "off"}`);
  const setCount = await loadSetFlags();
  console.log(`  ${setCount} products flagged as part of a set — these get the "Complete the Look" notice`);
  const all = await fetchActiveProducts();

  const done = new Set(loadState().done);
  const excluded = all.filter((p) => EXCLUDED_HANDLES.has(String(p.handle || "").toLowerCase()));
  let queue = all
    .filter((p) => !EXCLUDED_HANDLES.has(String(p.handle || "").toLowerCase()))
    .filter((p) => (p.media?.nodes || []).some((n: Json) => n?.image?.url))
    .filter((p) => (ONLY.size ? ONLY.has(p.id) : true))
    .filter((p) => !done.has(p.id));
  const skippedNoImage = all.length - all.filter((p) => (p.media?.nodes || []).some((n: Json) => n?.image?.url)).length;
  if (LIMIT) queue = queue.slice(0, LIMIT);

  const byStatus = all.reduce<Record<string, number>>((acc, p) => {
    acc[String(p.status)] = (acc[String(p.status)] || 0) + 1;
    return acc;
  }, {});
  console.log(`  ${all.length} products (${Object.entries(byStatus).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ")})`);
  console.log(`  ${skippedNoImage} skipped (no image) · ${done.size} already done · ${queue.length} to process`);
  if (excluded.length) {
    console.log(`  excluded by name: ${excluded.map((p: Json) => p.handle).join(", ")}`);
  }
  console.log("");
  if (!queue.length) return;

  let ok = 0;
  let failed = 0;
  /* Handle changes are reported at the end: they rewrite live URLs and they
     invalidate the set pairing, so they are not something to bury in a scroll of
     per-product lines. */
  const renamed: string[] = [];
  let improvedTotal = 0;
  let at100 = 0;
  const before: number[] = [];
  const after: number[] = [];
  const doneIds = [...done];
  let index = 0;

  async function worker(id: number) {
    for (;;) {
      const i = index++;
      if (i >= queue.length) return;
      const p = queue[i];
      const label = `[${String(i + 1).padStart(4)}/${queue.length}] ${String(p.title).slice(0, 40)}`;
      try {
        const current = toFields(p);
        const context = toContext(p);
        const result = await optimizeSeo({ context, current, useVision: USE_VISION, apiKey: OPENAI_KEY });
        if (result.error) throw new Error(result.error);

        /* The honest "after" score: the proposed fields judged against the
           keyword that will actually be stored alongside them. */
        const finalCard: Scorecard = scoreAll({ ...result.proposed, focusKeyword: result.focusKeyword });
        const beforeCard = scoreAll(current);

        if (WRITE) {
          const before = String(p.handle || "");
          const after = String(result.proposed.handle || "").trim().toLowerCase();
          if (after && after !== before.toLowerCase()) renamed.push(`${before}  ->  ${after}`);
          await publish(
            p.id,
            result.proposed,
            result.focusKeyword,
            result.secondaryKeywords,
            finalCard.overall,
            String(p.handle || ""),
          );
          doneIds.push(p.id);
          fs.writeFileSync(STATE, JSON.stringify({ done: doneIds }, null, 2));
        }

        before.push(beforeCard.overall);
        after.push(finalCard.overall);
        improvedTotal += finalCard.overall - beforeCard.overall;
        if (finalCard.overall >= 100) at100 += 1;
        ok += 1;

        fs.appendFileSync(
          REPORT,
          JSON.stringify({
            id: p.id,
            title: p.title,
            handle: p.handle,
            wrote: WRITE,
            focusKeyword: result.focusKeyword,
            secondaryKeywords: result.secondaryKeywords,
            imagesAnalyzed: result.imagesAnalyzed,
            before: beforeCard.overall,
            after: finalCard.overall,
            fieldsAfter: Object.fromEntries(
              Object.entries(finalCard.fields).map(([k, v]) => [k, v?.score ?? 0]),
            ),
            setBanner: SET_PICTURES.get(String(p.id)) ?? null,
            proposed: {
              seoTitle: result.proposed.seoTitle,
              metaDescription: result.proposed.metaDescription,
              tags: result.proposed.tags,
              bodyHtmlChars: String(result.proposed.bodyHtml || "").length,
            },
          }) + "\n",
        );
        console.log(
          `${label}  ${beforeCard.overall} → ${finalCard.overall}${finalCard.overall >= 100 ? "  ✓100" : ""}` +
            (result.skipped
              ? "  already optimized — left as it is"
              : `  [${result.imagesAnalyzed} photo${result.imagesAnalyzed === 1 ? "" : "s"} read]  kw:"${result.focusKeyword}"`),
        );
        /* Not on the skip path: nothing was generated there, so no photo was
           needed and warning about it reads as a failure that did not happen. */
        if (USE_VISION && !result.skipped && result.imagesAnalyzed === 0) {
          /* Loudly, because silently falling back to name-only copy is exactly
             the quality drop the photos are there to prevent. */
          console.log(`         ⚠ no photo could be read for this product — copy written from name/colour only`);
        }
      } catch (e) {
        failed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        fs.appendFileSync(REPORT, JSON.stringify({ id: p.id, title: p.title, error: msg }) + "\n");
        console.log(`${label}  FAILED — ${msg.slice(0, 110)}`);
      }
    }
  }

  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const mins = ((Date.now() - started) / 60000).toFixed(1);

  const avg = (a: number[]) => (a.length ? (a.reduce((s, n) => s + n, 0) / a.length).toFixed(1) : "0");
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${WRITE ? "Wrote" : "Dry run"}: ${ok} succeeded, ${failed} failed, in ${mins} min`);
  console.log(`Average score ${avg(before)} → ${avg(after)}   at a perfect 100: ${at100}/${ok}`);
  console.log(`Report: ${REPORT}`);
  if (!WRITE) console.log(`\nNothing was written. Re-run with --write to publish.`);
  else if (renamed.length) {
    /*
     * Renaming a product breaks the set pairing.
     *
     * carbon_set.partners stores HANDLES, because that is what the storefront
     * fetches (/products/<handle>.js). Rename a piece and its partner's list
     * points at a URL that no longer exists — the panel then fails silently,
     * which is the worst way for it to fail. This run renamed products, so say
     * so loudly rather than leaving it to be discovered on the storefront.
     */
    console.log(`\n${renamed.length} product${renamed.length === 1 ? "" : "s"} renamed:`);
    for (const r of renamed) console.log(`  ${r}`);
    console.log(
      "\n  Set pairing stores partner HANDLES, so any renamed set piece has left\n" +
        "  its partner pointing at a dead URL. Repair with:\n" +
        "    npx tsx scripts/push-set-banners.ts --write",
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
