import type { Pool } from "pg";
import { runShopifyGraphql } from "@/lib/shopify";
import { resolveShopContext, setMetafields, type ShopCtx } from "@/lib/server/shopify-write";
import { googleConfigured, listGmcListings, setGmcDetails } from "@/lib/server/google-merchant";
import {
  googleMaterial,
  googleProductDetails,
  modelHeightLine,
  translateCare,
  translateFabric,
  type DetailLang,
  type ProductDetailsInput,
} from "@/lib/product-details";

/**
 * Push the product "Details" (fabric, care, model height) from the WMS to:
 *   1. Shopify product metafields custom.fabric_composition / care_instructions /
 *      model_height, with Spanish and Portuguese translations — the theme's
 *      Details tab renders them (snippets/carbon-product-details.liquid);
 *   2. Google Merchant Center: `material` + `productDetails` on every listing,
 *      in the listing's own language, through the supplemental data source.
 *
 * Only values that differ are written, so a re-run is cheap. Run by the Sync
 * ads job and by scripts/sync-product-details.ts.
 */

type Row = ProductDetailsInput & { productId: string };

const KEYS = { fabric: "fabric_composition", care: "care_instructions", model: "model_height" } as const;

async function loadRows(pool: Pool): Promise<Map<string, Row>> {
  const r = await pool.query<{
    pid: string;
    fabric: string | null;
    care: string | null;
    height: string | null;
    gender: "female" | "male" | null;
  }>(
    `SELECT DISTINCT ON (m.shopify_product_id)
            m.shopify_product_id AS pid, m.fabric_composition AS fabric, m.care_instructions AS care,
            p.height, p.gender
       FROM matrices m
       LEFT JOIN model_profiles p ON p.id = m.model_profile_id
      WHERE m.shopify_product_id IS NOT NULL
      ORDER BY m.shopify_product_id, (m.fabric_composition IS NULL), (m.model_profile_id IS NULL), m.id`,
  );
  const out = new Map<string, Row>();
  for (const x of r.rows) {
    const id = x.pid.startsWith("gid://") ? x.pid : `gid://shopify/Product/${x.pid}`;
    out.set(id, { productId: id, fabric: x.fabric, care: x.care, modelHeight: x.height, modelGender: x.gender });
  }
  return out;
}

function valuesFor(row: Row, lang: DetailLang): Record<string, string> {
  return {
    [KEYS.fabric]: row.fabric ? translateFabric(row.fabric, lang) : "",
    [KEYS.care]: row.care ? translateCare(row.care, lang) : "",
    [KEYS.model]: row.modelHeight ? modelHeightLine(row.modelHeight, row.modelGender, lang) : "",
  };
}

type MfNode = { id: string; key: string; value: string };

async function shopifyPass(ctx: ShopCtx, rows: Map<string, Row>, log: (m: string) => void) {
  const gql = async <T>(query: string, variables?: Record<string, unknown>) =>
    (await runShopifyGraphql<T>({ shop: ctx.shop, token: ctx.token, query, variables, apiVersion: ctx.apiVersion })) as {
      ok: boolean;
      data?: T | null;
    };
  let written = 0, translated = 0;
  const ids = [...rows.keys()];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const q = await gql<{ nodes: Array<{ id: string; metafields?: { nodes: MfNode[] } } | null> }>(
      `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id metafields(namespace:"custom", first:30){ nodes { id key value } } } } }`,
      { ids: batch },
    );
    const cur = new Map((q.data?.nodes || []).filter(Boolean).map((n) => [n!.id, n!.metafields?.nodes || []]));
    const sets: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> = [];
    for (const id of batch) {
      if (!cur.has(id)) continue; // product no longer on Shopify
      const want = valuesFor(rows.get(id)!, "en");
      const have = new Map(cur.get(id)!.map((m) => [m.key, m.value]));
      for (const [key, value] of Object.entries(want)) {
        if (value && have.get(key) !== value) {
          sets.push({ ownerId: id, namespace: "custom", key, type: key === KEYS.care ? "multi_line_text_field" : "single_line_text_field", value });
        }
      }
    }
    if (sets.length) {
      const r = await setMetafields(ctx, sets);
      if (!r.ok || r.warnings?.length) log(`metafields: ${r.error || r.warnings?.join("; ")}`);
      written += sets.length;
    }
    /* Translations: read the metafields back (new ids), compare, register. */
    const q2 = await gql<{ nodes: Array<{ id: string; metafields?: { nodes: MfNode[] } } | null> }>(
      `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id metafields(namespace:"custom", first:30){ nodes { id key value } } } } }`,
      { ids: batch },
    );
    const mfs: Array<{ product: string; mf: MfNode }> = [];
    for (const n of q2.data?.nodes || []) {
      if (!n) continue;
      for (const mf of n.metafields?.nodes || []) if (Object.values(KEYS).includes(mf.key as never) && mf.value) mfs.push({ product: n.id, mf });
    }
    if (!mfs.length) continue;
    const tr = await gql<{
      translatableResourcesByIds: {
        nodes: Array<{
          resourceId: string;
          translatableContent: Array<{ key: string; digest: string }>;
          es: Array<{ key: string; value: string; outdated: boolean }>;
          pt: Array<{ key: string; value: string; outdated: boolean }>;
        }>;
      };
    }>(
      `query($ids:[ID!]!){ translatableResourcesByIds(first:150, resourceIds:$ids){ nodes {
         resourceId translatableContent { key digest }
         es: translations(locale:"es"){ key value outdated }
         pt: translations(locale:"pt-BR"){ key value outdated } } } }`,
      { ids: mfs.map((m) => m.mf.id) },
    );
    const byRes = new Map((tr.data?.translatableResourcesByIds.nodes || []).map((n) => [n.resourceId, n]));
    for (const { product, mf } of mfs) {
      const node = byRes.get(mf.id);
      const digest = node?.translatableContent.find((c) => c.key === "value")?.digest;
      if (!node || !digest) continue;
      const row = rows.get(product)!;
      const list: Array<{ key: string; value: string; locale: string; translatableContentDigest: string }> = [];
      for (const [lang, have] of [["es", node.es], ["pt-BR", node.pt]] as const) {
        const want = valuesFor(row, lang)[mf.key];
        const h = have.find((x) => x.key === "value");
        if (want && (!h || h.value !== want || h.outdated)) list.push({ key: "value", value: want, locale: lang, translatableContentDigest: digest });
      }
      if (!list.length) continue;
      const r = await gql<{ translationsRegister: { userErrors: Array<{ message: string }> } }>(
        `mutation($id:ID!,$t:[TranslationInput!]!){ translationsRegister(resourceId:$id, translations:$t){ userErrors { message } } }`,
        { id: mf.id, t: list },
      );
      const errs = r.data?.translationsRegister.userErrors || [];
      if (errs.length) log(`translation ${mf.key}: ${errs.map((e) => e.message).join("; ")}`);
      else translated += list.length;
    }
  }
  return { written, translated };
}

function sameDetails(
  a: Array<{ sectionName?: string; attributeName?: string; attributeValue?: string }>,
  b: Array<{ sectionName: string; attributeName: string; attributeValue: string }>,
): boolean {
  const k = (x: { sectionName?: string; attributeName?: string; attributeValue?: string }) =>
    `${x.sectionName}|${x.attributeName}|${x.attributeValue}`;
  return JSON.stringify(a.map(k).sort()) === JSON.stringify(b.map(k).sort());
}

async function googlePass(rows: Map<string, Row>, log: (m: string) => void) {
  const listings = await listGmcListings();
  let written = 0, same = 0, failed = 0;
  const work = listings
    .map((l) => {
      const m = l.offerId.match(/^shopify_[A-Z]+_(\d+)_\d+$/);
      const row = m ? rows.get(`gid://shopify/Product/${m[1]}`) : undefined;
      if (!row || (!row.fabric && !row.care && !row.modelHeight)) return null;
      const lang: DetailLang = l.contentLanguage === "es" ? "es" : l.contentLanguage.startsWith("pt") ? "pt-BR" : "en";
      const want = {
        material: row.fabric ? googleMaterial(row.fabric, lang) : null,
        productDetails: googleProductDetails(row, lang),
      };
      if ((l.material || null) === want.material && sameDetails(l.productDetails, want.productDetails)) {
        same++;
        return null;
      }
      return { l, want };
    })
    .filter(Boolean) as Array<{ l: (typeof listings)[number]; want: Parameters<typeof setGmcDetails>[1] }>;
  let i = 0;
  const worker = async () => {
    while (i < work.length) {
      const { l, want } = work[i++];
      const r = await setGmcDetails(l, want);
      if (r.ok) written++;
      else {
        failed++;
        if (failed <= 5) log(`google ${l.offerId}/${l.contentLanguage}: ${r.error}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { listings: listings.length, written, same, failed };
}

export async function syncProductDetails(pool: Pool, log: (m: string) => void = () => {}) {
  const rows = await loadRows(pool);
  const ctx = await resolveShopContext();
  const shopify = ctx ? await shopifyPass(ctx, rows, log) : null;
  const google = googleConfigured() ? await googlePass(rows, log) : null;
  return { products: rows.size, shopify, google };
}
