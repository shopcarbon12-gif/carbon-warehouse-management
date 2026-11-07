/**
 * Spanish + Portuguese for the rest of the storefront (owner 2026-11-07:
 * "add Spanish, Portuguese to everywhere on the website").
 *
 * The product job (lib/server/shopify-translate.ts) and the Full SEO pass cover
 * product titles, descriptions, SEO fields and photo alt text. This fills what
 * they don't: collections, pages, blog/articles, menu links, collection images,
 * metaobjects, product option names / colour values, product types, any product
 * photo alt still missing, and the live theme's section and template text.
 *
 * Only strings with no translation, or an outdated one, are sent. URL handles
 * stay English on purpose (translating them changes every link). Sizes (S, M,
 * 30/32, OS…), URLs, numbers and anything containing Liquid code are skipped.
 * Same brand and garment rules as the product job (glossary from
 * shopify-translate.ts), Claude via lib/server/claude.ts.
 *
 *   npx tsx scripts/translate-storefront.ts            # dry run: what is missing
 *   npx tsx scripts/translate-storefront.ts --apply    # translate + register
 *   npx tsx scripts/translate-storefront.ts --apply --types=COLLECTION,LINK
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
for (const f of [".env.local", ".env.agent-secrets", ".env"]) {
  const p = path.join(ROOT, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const LIVE_THEME_ID = "189778460924";
const LOCALES = [
  { code: "es", name: "Latin American Spanish, for US shoppers", gloss: "es" },
  { code: "pt-BR", name: "Brazilian Portuguese", gloss: "pt" },
] as const;

/** Which keys of each resource type are customer-facing text worth translating. */
const TYPES: Record<string, (key: string) => boolean> = {
  COLLECTION: (k) => ["title", "body_html", "meta_title", "meta_description"].includes(k),
  PAGE: (k) => ["title", "body_html", "meta_title", "meta_description"].includes(k),
  BLOG: (k) => ["title", "meta_title", "meta_description"].includes(k),
  ARTICLE: (k) => ["title", "body_html", "summary_html", "meta_title", "meta_description"].includes(k),
  LINK: (k) => k === "title",
  COLLECTION_IMAGE: (k) => k === "alt",
  METAOBJECT: () => true,
  PRODUCT_OPTION: (k) => k === "name",
  PRODUCT_OPTION_VALUE: (k) => k === "name",
  PRODUCT: (k) => k === "product_type",
  MEDIA_IMAGE: (k) => k === "alt",
  ONLINE_STORE_THEME_JSON_TEMPLATE: (k) => !/custom_liquid|liquid$/.test(k),
  ONLINE_STORE_THEME_SECTION_GROUP: (k) => !/custom_liquid|liquid$/.test(k),
  ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS: (k) => !/custom_liquid|liquid$/.test(k),
  ONLINE_STORE_THEME_LOCALE_CONTENT: () => true,
};

const SIZE_RE = /^(XXS|XS|S|M|L|XL|XXL|XXXL|[2-5]XL|OS|O\/S|ONE SIZE|\d{1,3}([\/x-]\d{1,3})?|\d{1,2}(\.\d)?)$/i;

function skipValue(v: string): boolean {
  const t = v.trim();
  if (!t) return true;
  if (/^(https?:|shopify:\/\/|mailto:|tel:|#[0-9a-f]{3,8}$|\/)/i.test(t)) return true;
  if (/^[\d\s.,:%$+-]+$/.test(t)) return true;
  if (/^(gid:\/\/|@)/.test(t)) return true; // ids, @handles
  if (/\{%/.test(t) || /\{\{\s*[\w-]+\.[\w.]+/.test(t)) return true; // Liquid code ({{count}}-style placeholders are fine)
  if (SIZE_RE.test(t)) return true;
  if (/^[A-Z0-9]{1,3}$/.test(t)) return true; // codes like "A", "AK"
  return false;
}

type Row = { id: string; key: string; value: string; digest: string; locale: string };

async function main() {
  const { runShopifyGraphql } = await import("@/lib/shopify");
  const { resolveShopContext } = await import("@/lib/server/shopify-write");
  const { claudeJson } = await import("@/lib/server/claude");
  const { glossary } = await import("@/lib/server/shopify-translate");

  const apply = process.argv.includes("--apply");
  const typesArg = process.argv.find((a) => a.startsWith("--types="));
  const types = typesArg ? typesArg.slice(8).split(",") : Object.keys(TYPES);
  const ctx = await resolveShopContext();
  if (!ctx) throw new Error("Shopify is not connected");

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    for (let a = 0; a < 8; a++) {
      const r = await runShopifyGraphql<T>({ ...ctx!, query, variables });
      if (r.ok && r.data) return r.data;
      const msg = JSON.stringify(r).slice(0, 400);
      if (/THROTTLED|Throttled/i.test(msg)) {
        await new Promise((res) => setTimeout(res, 2000 * (a + 1)));
        continue;
      }
      throw new Error(msg);
    }
    throw new Error("throttled");
  }

  // Only ACTIVE products (and their photos) matter to shoppers.
  const activeProducts = new Set<string>();
  const activeMedia = new Set<string>();
  if (types.includes("PRODUCT") || types.includes("MEDIA_IMAGE")) {
    let after: string | null = null;
    for (;;) {
      const d: {
        products: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          nodes: { id: string; media: { nodes: { id: string }[] } }[];
        };
      } = await gql(
        `query($after:String){ products(first:100, after:$after, query:"status:active"){ pageInfo{hasNextPage endCursor} nodes{ id media(first:80){ nodes{ id } } } } }`,
        { after },
      );
      for (const p of d.products.nodes) {
        activeProducts.add(p.id);
        for (const m of p.media.nodes) activeMedia.add(m.id);
      }
      if (!d.products.pageInfo.hasNextPage) break;
      after = d.products.pageInfo.endCursor;
    }
  }

  const todo: Row[] = [];
  for (const type of types) {
    const wanted = TYPES[type];
    if (!wanted) throw new Error(`unknown type ${type}`);
    let after: string | null = null;
    let count = 0;
    for (;;) {
      type Page = {
        translatableResources: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          nodes: {
            resourceId: string;
            translatableContent: { key: string; value: string | null; digest: string }[];
            es: { key: string; outdated: boolean }[];
            pt: { key: string; outdated: boolean }[];
          }[];
        };
      };
      const d: Page = await gql(
        `query($t:TranslatableResourceType!, $after:String){ translatableResources(first:100, resourceType:$t, after:$after){
           pageInfo{hasNextPage endCursor}
           nodes{ resourceId translatableContent{ key value digest }
             es: translations(locale:"es"){ key outdated } pt: translations(locale:"pt-BR"){ key outdated } } } }`,
        { t: type, after },
      );
      for (const n of d.translatableResources.nodes) {
        if (/Theme/.test(n.resourceId) && !n.resourceId.includes(LIVE_THEME_ID)) continue;
        if (type === "PRODUCT" && !activeProducts.has(n.resourceId)) continue;
        if (type === "MEDIA_IMAGE" && !activeMedia.has(n.resourceId)) continue;
        for (const c of n.translatableContent) {
          if (!c.value || !wanted(c.key) || skipValue(c.value)) continue;
          for (const [loc, list] of [["es", n.es], ["pt-BR", n.pt]] as const) {
            const t = list.find((x) => x.key === c.key);
            if (t && !t.outdated) continue;
            todo.push({ id: n.resourceId, key: c.key, value: c.value, digest: c.digest, locale: loc });
            count++;
          }
        }
      }
      if (!d.translatableResources.pageInfo.hasNextPage) break;
      after = d.translatableResources.pageInfo.endCursor;
    }
    console.log(`${type.padEnd(44)} ${String(count).padStart(5)} strings to translate (ES + PT)`);
  }
  console.log(`total ${todo.length}${apply ? "" : " — dry run, pass --apply"}`);
  if (!apply || !todo.length) return;

  for (const L of LOCALES) {
    const rows = todo.filter((r) => r.locale === L.code);
    // Same English text → one translation (product types, colour names repeat a lot).
    const unique = [...new Set(rows.map((r) => r.value))];
    const done = new Map<string, string>();
    const system = `You translate storefront text for CARBON, a US fashion store (shopcarbon.com), from English into ${L.name}.

Brand: "CARBON" / "Carbon" is the brand — never translate it (never "Carbono", "Carbón") and never call it "Carbon Jeans". Product and collection model names, place names and slogans stay in English exactly as written (River, Kiera, London, "Make It Happen", AW26, "After Hours", "The Art of Arriving" may be translated only when it is a plain sentence, not a named collection). Colour names: translate plain colours naturally (Black → Negro / Preto, Light Blue → Azul claro / Azul claro, Blue Washed → Azul deslavado / Azul lavado); keep codes and numbers.

Garment words: ${glossary(L.gloss)}

Keep every HTML tag, attribute and line break exactly; translate only visible text. Keep {{ placeholders }}, URLs, emails, sizes, prices and numbers unchanged. Menu and button text stays short and in the same case as the English (ALL CAPS stays ALL CAPS). meta_title at most 70 characters, meta_description at most 160. Write natural retail copy, not word-for-word.

You get {"items":[{"i":<n>,"text":"..."}]}. Reply with JSON {"items":[{"i":<n>,"t":"<translation>"}]} covering every item. No commentary.`;
    const batches: string[][] = [];
    let cur: string[] = [];
    let size = 0;
    for (const u of unique) {
      if (cur.length && (cur.length >= 12 || size + u.length > 4000)) {
        batches.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(u);
      size += u.length;
    }
    if (cur.length) batches.push(cur);
    // Register as each batch comes back, so an interrupted run keeps what it did.
    let ok = 0;
    let failed = 0;
    let finished = 0;
    async function registerFor(values: Set<string>) {
      const byRes = new Map<string, Row[]>();
      for (const r of rows) {
        if (!values.has(r.value) || !done.has(r.value)) continue;
        if (!byRes.has(r.id)) byRes.set(r.id, []);
        byRes.get(r.id)!.push(r);
      }
      for (const [id, list] of byRes) {
        for (let i = 0; i < list.length; i += 100) {
          const part = list.slice(i, i + 100);
          const d: { translationsRegister: { userErrors: { field: string[]; message: string }[] } } = await gql(
            `mutation($id:ID!, $t:[TranslationInput!]!){ translationsRegister(resourceId:$id, translations:$t){ userErrors{ field message } } }`,
            {
              id,
              t: part.map((r) => ({ locale: L.code, key: r.key, value: done.get(r.value)!, translatableContentDigest: r.digest })),
            },
          );
          const errs = d.translationsRegister.userErrors;
          if (errs.length) {
            failed += part.length;
            console.warn(`  ! ${id}: ${JSON.stringify(errs).slice(0, 200)}`);
          } else ok += part.length;
        }
      }
    }
    async function runBatch(batch: string[]) {
      try {
        const reply = await claudeJson<{ items: { i: number; t?: string; text?: string }[] }>(
          system,
          JSON.stringify({ items: batch.map((text, i) => ({ i, text })) }),
          { maxTokens: 16000 },
        );
        if (process.env.TS_DEBUG) console.log("batch", batch.length, "reply", (reply.items || []).length, JSON.stringify(reply).slice(0, 300), "SRC0", JSON.stringify(batch[0]).slice(0, 200));
        for (const it of reply.items || []) {
          const src = batch[it.i];
          // The model sometimes answers with "text" instead of "t" — take either.
          const t = typeof it.t === "string" ? it.t : typeof (it as { text?: unknown }).text === "string" ? (it as { text: string }).text : "";
          if (src !== undefined && t.trim() && t.trim() !== src.trim()) done.set(src, t.trim());
        }
        await registerFor(new Set(batch));
      } catch (e) {
        console.warn(`  ! batch failed: ${e instanceof Error ? e.message : e}`);
      }
      finished++;
      console.log(`  ${L.code}: ${finished}/${batches.length} batches · registered ${ok}`);
    }
    const queue = process.env.TS_ONE ? batches.slice(0, 1) : [...batches];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) await runBatch(next);
      }),
    );
    console.log(`${L.code}: registered ${ok}, failed ${failed}, untranslated ${rows.length - ok - failed}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
