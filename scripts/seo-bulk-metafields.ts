/* eslint-disable no-console */
/**
 * Bulk fill of the four retail metafields the SEO pass leaves empty.
 *
 * The bulk SEO run writes title, description, handle, tags, alt text and the
 * carbon_seo markers. It has never written the fields the Matrix → SEO tab
 * shows under "Metafields · custom + Google feed", so only the products someone
 * opened by hand have them:
 *
 *     seo.title / seo.description        560/560 active
 *     custom.short_descriptions_         165/560
 *     mm-google-shopping.gender          166/560   (on variants)
 *     mm-google-shopping.age_group       174/560
 *     mm-google-shopping.condition       172/560
 *
 * custom.short_descriptions_ is the PDP's "Description" tab, so the products
 * without it show an empty tab to customers. That is what this closes.
 *
 * Gender is read from the product type ("WOMEN >> TOPS"), which states it for
 * all but a handful; only those few cost a photo call for gender. The
 * description always costs one, because there is nothing else to write it from.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --write is passed.
 *
 *   npx tsx scripts/seo-bulk-metafields.ts --limit 5             # sample, no writes
 *   npx tsx scripts/seo-bulk-metafields.ts --limit 5 --write     # sample, writes
 *   npx tsx scripts/seo-bulk-metafields.ts --write               # the whole backlog
 *
 * Flags:
 *   --limit N        stop after N products
 *   --concurrency N  products in flight (default 4)
 *   --write          actually write to Shopify
 *   --only <h,h>     restrict to specific handles
 *   --resume         skip products recorded done in the state file
 *   --force          rewrite products that already have all four
 *   --no-vision      skip the photo call; fills only what the product type and
 *                    the constants can supply, and leaves the description alone
 *
 * Progress lands in scripts/.seo-bulk/metafields-report.jsonl and the completed
 * ids in scripts/.seo-bulk/metafields-state.json, so an interrupted run resumes
 * without paying for the same products twice.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  AGE_GROUPS,
  CONDITIONS,
  DEFAULT_AGE_GROUP,
  DEFAULT_CONDITION,
  GENDERS,
  RETAIL_METAFIELDS,
  buildDescriptionInstruction,
  buildRetailMetafieldInputs,
  genderFromCollections,
  genderFromProductType,
  missingRetailFields,
  pickAllowed,
  type RetailMetafieldValues,
} from "@/lib/seo/retailMetafields";

type Json = any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "scripts", ".seo-bulk");
const REPORT = path.join(OUT_DIR, "metafields-report.jsonl");
const STATE = path.join(OUT_DIR, "metafields-state.json");

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

/* Same precedence as the SEO bulk pass, and the same reason: this writes to the
   live storefront, and .env.agent-secrets still carries a DATABASE_URL for the
   decommissioned box — letting it override sends the run at a dead host. */
const env = { ...loadEnvFile(".env.agent-secrets"), ...loadEnvFile(".env.coolify.local") };

const SHOP = (process.env.SHOPIFY_SHOP_DOMAIN || env.SHOPIFY_SHOP_DOMAIN || "").trim();
const TOKEN = (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim();
const API_VERSION = (process.env.SHOPIFY_API_VERSION || "2026-07").trim();
const OPENAI_KEY = (() => {
  const direct = (process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || "").trim();
  if (direct) return direct;
  const f = (process.env.OPENAI_API_KEY_FILE || "").trim();
  if (f && fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  return "";
})();
const MODEL = (process.env.SEO_MODEL || env.SEO_MODEL || "gpt-4o").trim();

/* --------------------------------------------------------------- args ---- */

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const WRITE = flag("write");
const FORCE = flag("force");
const RESUME = flag("resume");
const NO_VISION = flag("no-vision");
const LIMIT = Number(value("limit") || 0) || 0;
const CONCURRENCY = Math.max(1, Number(value("concurrency") || 4) || 4);
const ONLY = (value("only") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* ------------------------------------------------------------ shopify ---- */

let throttleWaitMs = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gql<T = Json>(query: string, variables: Json = {}): Promise<T> {
  if (!SHOP || !TOKEN) throw new Error("SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN missing.");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (throttleWaitMs) {
      await sleep(throttleWaitMs);
      throttleWaitMs = 0;
    }
    const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new Error(`Shopify ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text);
    if (json.errors) {
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

/* The same exclusion list the bulk SEO pass uses, by handle rather than by a
   flag someone has to remember: the gift card is not a garment, so it has no
   gender, no photo worth describing and no place in a shopping feed. */
const EXCLUDED_HANDLES = new Set(["gifted-product", "gift-card"]);

const PRODUCT_FIELDS = `
  id handle title productType status
  featuredImage { url }
  media(first: 8) { nodes { ... on MediaImage { image { url } } } }
  collections(first: 20) { nodes { handle } }
  fd: metafield(namespace: "custom", key: "short_descriptions_") { value }
  variants(first: 100) {
    nodes {
      id
      g: metafield(namespace: "mm-google-shopping", key: "gender") { value }
      a: metafield(namespace: "mm-google-shopping", key: "age_group") { value }
      c: metafield(namespace: "mm-google-shopping", key: "condition") { value }
    }
  }
`;

interface Target {
  id: string;
  handle: string;
  title: string;
  productType: string;
  collections: string[];
  images: string[];
  variantIds: string[];
  has: { fullDescription: boolean; gender: boolean; ageGroup: boolean; condition: boolean };
}

async function fetchActive(): Promise<Target[]> {
  const out: Target[] = [];
  let cursor: string | null = null;
  do {
    const d: Json = await gql(
      `query($cursor:String){ products(first:50, after:$cursor, query:"status:active"){
         pageInfo{hasNextPage endCursor} nodes{ ${PRODUCT_FIELDS} } } }`,
      { cursor },
    );
    for (const p of d.products.nodes) {
      const variants = p.variants?.nodes || [];
      /* A Google field counts as present only when EVERY variant carries it.
         One variant filled and the rest empty still fails the feed, and is
         exactly what a half-finished manual push leaves behind. */
      const every = (k: "g" | "a" | "c") =>
        variants.length > 0 && variants.every((v: Json) => String(v?.[k]?.value || "").trim());
      out.push({
        id: p.id,
        handle: p.handle,
        title: p.title || "",
        productType: p.productType || "",
        collections: (p.collections?.nodes || []).map((c: Json) => String(c?.handle || "")).filter(Boolean),
        /* Several, not one. The media list can hold videos and 3D models,
           which come back as empty objects through the MediaImage fragment, and
           one frame can also simply be a detail shot the model has nothing to
           say about. Keeping the alternatives lets a retry use a different
           picture instead of giving up on the product. */
        images: [p.featuredImage?.url, ...(p.media?.nodes || []).map((m: Json) => m?.image?.url)]
          .filter((u: unknown): u is string => typeof u === "string" && !!u)
          .filter((u: string, i: number, a: string[]) => a.indexOf(u) === i),
        variantIds: variants.map((v: Json) => v.id).filter(Boolean),
        has: {
          fullDescription: Boolean(String(p.fd?.value || "").trim()),
          gender: every("g"),
          ageGroup: every("a"),
          condition: every("c"),
        },
      });
    }
    cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
    process.stdout.write(`\r  fetched ${out.length} active products`);
  } while (cursor);
  process.stdout.write("\n");
  return out;
}

/* ---------------------------------------------------------------- ai ----- */

async function askPhoto(t: Target): Promise<{ fullDescription: string }> {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY missing.");
  if (!t.images.length) throw new Error("no product image");
  let last = "";
  for (const url of t.images.slice(0, 3)) {
    const a = await askPhotoOnce(t, url);
    if (a.fullDescription) return a;
    last = "the model returned no description for this image";
  }
  /* An empty answer used to be written off as success, which is how fifteen
     products came out of a "0 failures" run with an empty Description tab.
     It is a failure, and it is reported as one. */
  throw new Error(last || "no description produced");
}

async function askPhotoOnce(t: Target, imageUrl: string): Promise<{ fullDescription: string }> {
  const body = {
    model: MODEL,
    temperature: 0.3,
    response_format: { type: "json_object" as const },
    messages: [
      {
        role: "system" as const,
        content: "You describe apparel from a product photo for a retail size/description panel. Return only valid JSON.",
      },
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: buildDescriptionInstruction({ title: t.title, productType: t.productType, askGender: false }) },
          { type: "image_url" as const, image_url: { url: imageUrl, detail: "auto" as const } },
        ],
      },
    ],
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(JSON.parse(text)?.choices?.[0]?.message?.content || "{}");
    return { fullDescription: String(parsed.fullDescription || "").trim() };
  }
  throw new Error("OpenAI: retries exhausted");
}

/* -------------------------------------------------------------- write ---- */

async function push(t: Target, values: RetailMetafieldValues): Promise<number> {
  const inputs = buildRetailMetafieldInputs({ productId: t.id, variantIds: t.variantIds, values });
  if (!inputs.length) return 0;
  /* metafieldsSet takes 25 at a time; a product with many variants exceeds that
     on the three per-variant fields alone. */
  for (let i = 0; i < inputs.length; i += 25) {
    const chunk = inputs.slice(i, i + 25);
    const r: Json = await gql(
      `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ field message } } }`,
      { m: chunk },
    );
    const errs = r.metafieldsSet?.userErrors || [];
    if (errs.length) throw new Error(`metafieldsSet: ${errs.map((e: Json) => e.message).join("; ")}`);
  }
  return inputs.length;
}

/* The WMS panel reloads from catalog_metafields, not from Shopify, so a value
   written only to Shopify leaves the operator looking at an empty box. */
async function persist(db: Client | null, handleToMatrix: Map<string, string>, t: Target, values: RetailMetafieldValues) {
  if (!db) return;
  const matrixId = handleToMatrix.get(t.id) || handleToMatrix.get(t.id.replace("gid://shopify/Product/", ""));
  if (!matrixId) return;
  for (const f of RETAIL_METAFIELDS) {
    const val = String((values as Json)[f.field] || "").trim();
    if (!val) continue;
    await db.query(
      `INSERT INTO catalog_metafields (matrix_id, namespace, key, type, value)
       VALUES ($1::uuid, $2, $3, $4, $5)
       ON CONFLICT (matrix_id, namespace, key) WHERE matrix_id IS NOT NULL AND custom_sku_id IS NULL
       DO UPDATE SET value = EXCLUDED.value, type = EXCLUDED.type, updated_at = now()`,
      [matrixId, f.namespace, f.key, f.type, val],
    );
  }
}

/* ---------------------------------------------------------------- run ---- */

function loadState(): { done: string[] } {
  if (!RESUME || !fs.existsSync(STATE)) return { done: [] };
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return { done: [] };
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\nCARBON — retail metafield backfill  (${WRITE ? "WRITE" : "DRY RUN"})`);
  console.log(`  shop ${SHOP}  model ${MODEL}${NO_VISION ? "  [no vision]" : ""}\n`);

  const all = await fetchActive();
  const done = new Set(loadState().done);

  let targets = all.filter((t) => !EXCLUDED_HANDLES.has(t.handle));
  const skippedGiftCard = all.length - targets.length;
  if (ONLY.length) targets = targets.filter((t) => ONLY.includes(t.handle));
  if (!FORCE) targets = targets.filter((t) => missingRetailFields(t.has).length > 0);
  targets = targets.filter((t) => !done.has(t.id));
  if (LIMIT) targets = targets.slice(0, LIMIT);

  const noImage = targets.filter((t) => !t.images.length).length;
  const needGenderAsk = targets.filter(
    (t) => !genderFromProductType(t.productType) && !genderFromCollections(t.collections),
  ).length;
  console.log(`  ${all.length} active · gift card skipped: ${skippedGiftCard}`);
  console.log(`  ${targets.length} to process`);
  console.log(`  gender from product type or collections: ${targets.length - needGenderAsk}, unresolved: ${needGenderAsk}`);
  console.log(`  without a usable image: ${noImage}\n`);
  if (!targets.length) {
    console.log("  nothing to do.\n");
    return;
  }

  let db: Client | null = null;
  const handleToMatrix = new Map<string, string>();
  const dbUrl = (process.env.DATABASE_URL || env.DATABASE_URL || "").trim();
  if (WRITE && dbUrl) {
    db = new Client({ connectionString: dbUrl, ssl: false });
    await db.connect();
    const r = await db.query<{ id: string; shopify_product_id: string }>(
      `SELECT id::text, shopify_product_id FROM matrices WHERE shopify_product_id IS NOT NULL`,
    );
    for (const row of r.rows) {
      const raw = String(row.shopify_product_id);
      handleToMatrix.set(raw, row.id);
      handleToMatrix.set(raw.startsWith("gid://") ? raw : `gid://shopify/Product/${raw}`, row.id);
    }
    console.log(`  linked ${r.rows.length} matrices for the WMS panel mirror\n`);
  }

  const doneIds: string[] = [...done];
  let ok = 0;
  let failed = 0;
  let partial = 0;
  let written = 0;
  let idx = 0;

  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= targets.length) return;
      const t = targets[i];
      const missing = missingRetailFields(t.has);
      try {
        const typeGender = genderFromProductType(t.productType) || genderFromCollections(t.collections);
        const needDesc = FORCE || !t.has.fullDescription;
        const needGender = FORCE || !t.has.gender;
        /* The photo is asked for the description only. Asking the same call
           to judge gender made gpt-4o return empty content with no error, which
           lost the description too — the store's own collections answer it
           without a guess. */
        const askPhotoFor = !NO_VISION && t.images.length > 0 && needDesc;
        const aiDesc = askPhotoFor ? (await askPhoto(t)).fullDescription : "";

        const values: RetailMetafieldValues = {};
        if (needDesc && aiDesc) values.fullDescription = aiDesc;
        if (needGender) {
          if (typeGender) values.gender = pickAllowed(typeGender, GENDERS);
        }
        if (FORCE || !t.has.ageGroup) values.ageGroup = pickAllowed(DEFAULT_AGE_GROUP, AGE_GROUPS, DEFAULT_AGE_GROUP);
        if (FORCE || !t.has.condition) values.condition = pickAllowed(DEFAULT_CONDITION, CONDITIONS, DEFAULT_CONDITION);

        /* Write what there is before judging the result. A product with no
           photo can still take its gender, age group and condition; throwing
           first discarded three good fields over the one that could not be
           produced. */
        let pushed = 0;
        if (WRITE) {
          pushed = await push(t, values);
          await persist(db, handleToMatrix, t, values);
        }

        /* Counted against what the product still needs, not against whether the
           calls returned without throwing — an empty answer used to be written
           off as success, which is how fifteen products came out of a
           "0 failures" run with an empty Description tab. */
        const stillMissing = missing.filter((f) => !String((values as Json)[f] || "").trim());
        if (stillMissing.length) {
          partial += 1;
          fs.appendFileSync(
            REPORT,
            JSON.stringify({ handle: t.handle, partial: stillMissing, pushed, at: new Date().toISOString() }) + "\n",
          );
          console.log(
            `  ${String(ok + failed + partial).padStart(4)}/${targets.length}  ${t.handle.padEnd(34).slice(0, 34)} ` +
              `PARTIAL — wrote ${pushed}, still missing: ${stillMissing.join(", ")}`,
          );
          continue;
        }
        if (WRITE) doneIds.push(t.id);
        written += pushed;
        ok += 1;
        fs.appendFileSync(
          REPORT,
          JSON.stringify({
            handle: t.handle,
            productType: t.productType,
            missing,
            values,
            genderSource: values.gender
              ? genderFromProductType(t.productType)
                ? "product-type"
                : "collections"
              : null,
            pushed,
            write: WRITE,
            at: new Date().toISOString(),
          }) + "\n",
        );
        console.log(
          `  ${String(ok + failed).padStart(4)}/${targets.length}  ${t.handle.padEnd(34).slice(0, 34)} ` +
            `${values.gender || "—"}/${values.ageGroup || "—"}/${values.condition || "—"} ` +
            `${values.fullDescription ? `desc ${values.fullDescription.length}c` : "desc —"} ` +
            `${WRITE ? `→ ${pushed} metafields` : "(dry)"}`,
        );
      } catch (e) {
        failed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        fs.appendFileSync(REPORT, JSON.stringify({ handle: t.handle, error: msg, at: new Date().toISOString() }) + "\n");
        console.log(`  ${String(ok + failed).padStart(4)}/${targets.length}  ${t.handle.padEnd(34).slice(0, 34)} FAILED: ${msg.slice(0, 90)}`);
      }
      if (WRITE) fs.writeFileSync(STATE, JSON.stringify({ done: doneIds }, null, 2));
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  if (db) await db.end();

  console.log(`\n  done: ${ok}   partial: ${partial}   failed: ${failed}   metafields written: ${written}`);
  console.log(`  report: ${path.relative(ROOT, REPORT)}`);
  if (!WRITE) console.log(`\n  DRY RUN — nothing was written. Re-run with --write.\n`);
  else console.log("");
}

main().catch((e) => {
  console.error("\nfatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
