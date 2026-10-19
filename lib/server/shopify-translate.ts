/**
 * "Translate" worker job (job_type 'shopify_translate'), started from
 * Integrations → Shopify.
 *
 * For every active product and every published non-English store language
 * (today: es, pt-BR) it fixes title / description / SEO title / SEO description
 * when the translation is missing, out of date (English changed), or breaks a
 * Carbon rule (brand translated as "Carbono/Carbón", "Carbon Jeans", "tobillera",
 * "tanque"…). Claude writes the translations with the store's glossary, then a
 * second Claude pass reviews every touched title (and optionally every title)
 * and fixes only the ones that are genuinely wrong — model names translated
 * literally, wrong garment, garbled. Set products' "Complete the Look" image is
 * swapped to the language's own image. Every change is kept in the job result
 * (before → after) so it can be reviewed and reverted.
 *
 * Shopify Translate & Adapt never overwrites translations written this way —
 * it only fills empty fields and refreshes its own outdated machine output.
 */
import type { Pool } from "pg";
import { resolveShopContext, type ShopCtx } from "@/lib/server/shopify-write";
import { runShopifyGraphql } from "@/lib/shopify";
import { claudeJson, claudeConfigured, claudeModel } from "@/lib/server/claude";

const KEYS = ["title", "body_html", "meta_title", "meta_description"] as const;
type Key = (typeof KEYS)[number];

const LANG_NAME: Record<string, string> = {
  es: "Latin American Spanish, for US shoppers",
  "pt-BR": "Brazilian Portuguese",
  pt: "Brazilian Portuguese",
  fr: "French",
  he: "Hebrew",
};

/** The language's own "Complete the Look" image for set products (Shopify Files). */
const SET_NOTE: Record<string, { src: string; alt: string }> = {
  es: {
    src: "https://cdn.shopify.com/s/files/1/0680/6572/2620/files/carbon-set-note-es.png?v=1791717743",
    alt: "Completa el look — este artículo forma parte de un conjunto. La pieza a juego en la misma talla y color se añade automáticamente a tu carrito. Las piezas no se pueden mezclar ni combinar y cada pieza tiene su propio precio.",
  },
  "pt-BR": {
    src: "https://cdn.shopify.com/s/files/1/0680/6572/2620/files/carbon-set-note-pt.png?v=1791717744",
    alt: "Complete o look — este item faz parte de um conjunto. A peça correspondente no mesmo tamanho e cor é adicionada automaticamente ao seu carrinho. As peças não podem ser misturadas ou combinadas e cada peça tem seu próprio preço.",
  },
};
const SET_NOTE_RE = /<p class="carbon-set-note">[\s\S]*?<\/p>/;

function setNoteBlock(locale: string, englishBlock: string): string {
  const n = SET_NOTE[locale] || SET_NOTE[locale.split("-")[0]];
  if (!n) return englishBlock;
  return `<p class="carbon-set-note"><img src="${n.src}" alt="${n.alt}" loading="lazy" style="max-width:100%;height:auto;display:block;"></p>`;
}

const GLOSSARY: Record<string, string> = {
  es: `Tank / Tank Top → "Tank Top" (never "tanque", never "camiseta sin mangas"); T-Shirt / Tee → "Camiseta"; Shirt → "Camisa" (but "Camiseta" when the product type is a T-shirt); Polo Shirt → "Camisa Polo"; Hoodie / Sweatshirt → "Sudadera"; Jeans → "Jeans"; Denim Shorts → "Shorts de mezclilla"; Shorts → "Shorts"; Dress → "Vestido"; Mini Dress → "Vestido mini"; Midi Dress → "Vestido midi"; Romper → "Romper"; Jumpsuit → "Enterizo"; Crop Top → "Crop top"; Top → "Top"; Bodysuit → "Body"; Skirt → "Falda"; Pants / Bottom → "Pantalón"; Legging → "Leggings"; Jacket → "Chaqueta"; Blazer → "Blazer"; men's Swimwear / Swimsuit / Swim Bottom → "Traje de baño"; Heels → "Tacones" (never "talones"); Shoes → "Zapatos"; Sneakers → "Tenis"; Slippers → "Pantuflas"; Flip Flops → "Chanclas"; Hat / Cap → "Gorra"; Anklet → "Pulsera de tobillo" (never "tobillera"); Bracelet → "Pulsera"; Necklace → "Collar"; Set → "Conjunto"; "2 Pieces" → "2 Piezas".`,
  pt: `Tank / Tank Top → "Regata" (never "tanque"); T-Shirt / Tee → "Camiseta"; Shirt → "Camisa" (but "Camiseta" when the product type is a T-shirt); Polo Shirt → "Camisa Polo"; Hoodie → "Moletom com capuz"; Sweatshirt → "Moletom"; Jeans → "Jeans"; Denim Shorts → "Shorts Jeans"; Shorts → "Shorts"; Dress → "Vestido"; Mini Dress → "Vestido curto"; Midi Dress → "Vestido midi"; Romper → "Macaquinho"; Jumpsuit / Overall → "Macacão"; Crop Top → "Cropped"; Top → "Top"; Bodysuit → "Body"; Skirt → "Saia"; Pants → "Calça" (singular); Legging → "Legging"; Jacket → "Jaqueta"; men's Swimwear / Swimsuit / Swim Bottom → "Short de banho" (never "Maiô"); Heels → "Sandália de salto"; Shoes → "Sapatos"; Sneakers → "Tênis"; Slippers → "Pantufas"; Flip Flops → "Chinelos"; Hat / Cap → "Boné"; Anklet → "Tornozeleira"; Bracelet → "Pulseira"; Necklace → "Colar"; Set → "Conjunto"; "2 Pieces" → "2 Peças"; leopard print → "de oncinha".`,
};

/** Titles as the owner approved them (2026-10-11) — the pattern every new title follows. */
const EXAMPLES: Record<string, string> = {
  es: `"Successful Tank" → "Tank Top Successful"; "Time Never Shirt" → "Camisa Time Never"; "Kiera Dress" → "Vestido Kiera"; "London Dress" → "Vestido London"; "Make It Happen T-Shirt" → "Camiseta Make It Happen"; "Nash Swimsuit" → "Traje de baño Nash"; "River Top Set" → "Conjunto River Top"; "River Bottom Set" → "Conjunto River Bottom"; "Chaos Pants Set" → "Conjunto de pantalón Chaos"; "2 Pieces Gyda" → "Conjunto 2 Pieces Gyda"; "Peace Anklet" → "Pulsera de tobillo Peace"; "Jay Jeans" → "Jeans Jay"; "Classic Sneakers" → "Tenis clásicos"; "Mens Denim Shorts I" → "Shorts de mezclilla para hombre I".`,
  pt: `"Successful Tank" → "Regata Successful"; "Time Never Shirt" → "Camisa Time Never"; "Kiera Dress" → "Vestido Kiera"; "London Dress" → "Vestido London"; "Make It Happen T-Shirt" → "Camiseta Make It Happen"; "Nash Swimsuit" → "Short de banho Nash"; "River Top Set" → "Conjunto River Top"; "River Bottom Set" → "Conjunto River Bottom"; "Chaos Pants Set" → "Conjunto Calça Chaos"; "2 Pieces Gyda" → "Conjunto Gyda 2 Peças"; "Peace Anklet" → "Tornozeleira Peace"; "Archer Overall" → "Macacão Archer"; "Leopard Dress" → "Vestido de oncinha"; "Classic Sneakers" → "Tênis clássicos".`,
};

function glossary(locale: string): string {
  const g = GLOSSARY[locale] || GLOSSARY[locale.split("-")[0]] || "Translate garment words with the standard retail term.";
  const ex = EXAMPLES[locale] || EXAMPLES[locale.split("-")[0]];
  return ex ? `${g}\n\nApproved title examples (follow this pattern — garment word first, then the English name): ${ex}\nIn set names, "Top" and "Bottom" are part of the name and stay in English ("Conjunto River Bottom").` : g;
}

export function translateSystem(locale: string): string {
  return `You translate e-commerce product content for CARBON, a US fashion store (shopcarbon.com), from English into ${LANG_NAME[locale] || locale}.

Brand: "CARBON" is the brand, always written in capitals in every language (owner, 2026-10-18 — a title ends in " | CARBON"; write "Carbon" as "CARBON" when it is the brand, but leave it as written inside a product name such as "Carbon Classic T"). Never translate it (never "Carbono", "Carbón") and never call the brand "Carbon Jeans" — but text printed on a garment that the English quotes (a waistband label reading 'CARBON JEANS') is kept exactly, in quotes. Only when English uses lowercase "carbon" as a material ("carbon fiber", "durable carbon material") translate it as the material.

Product titles: the English model name or slogan stays in English exactly as written — single names (Vick, Alia, Noa, River, Gyda, Kiera, Storm, Mykel), place names (London, Paris, New York, Florida), and graphic-tee slogans ("Make It Happen", "Fill In The Blank", "Successful", "Game Over", "Good Things", "Time Never"). Never translate those words literally. Translate only the garment type and plain descriptive words (Floral, Sequin, Oversized, Cargo, Puffer, Knit, Ribbed, Crop), with the garment word first. Keep trailing codes (letters / numbers like "I", "H", "AK", "73"). If the title is only a generic description with no name ("Logo Hat", "Classic Sneakers", "Womens Long Denim Jeans H"), translate it naturally and keep the code.

Garment words: ${glossary(locale)}

Descriptions and SEO: natural, fluent retail copy; model names and slogans stay in English. Keep every HTML tag, attribute, line break and their order exactly — translate only visible text. Keep sizes, numbers, prices, SKUs and colour codes unchanged. meta_title at most 70 characters, meta_description at most 160.

Reply with one JSON object containing exactly the keys you were given, each holding its translation. No commentary.`;
}

export function judgeSystem(locale: string): string {
  return `You review ${LANG_NAME[locale] || locale} product titles for CARBON, a US fashion store. For each item you get the English title, the product type and the CURRENT translated title.

Return "keep" when the current title is correct, natural ${LANG_NAME[locale] || locale} — even if you would word it differently. Do not polish good titles.

Fix it only when it is genuinely wrong:
(a) a model name, place name or slogan was translated literally or altered (e.g. "Fundo de Rio" for River Bottom, "Tanque exitoso" for Successful Tank, "Vestido Londres" for London Dress, "Camiseta Paz" for Peace T-Shirt), or the name is missing;
(b) the garment is wrong (e.g. Tank as "tanque", a men's swimsuit as "Maiô", Heels as "talones", Overall as "Geral", denim shorts as a skirt, a shirt as a jacket);
(c) it is garbled or unnatural word order ("Johnny Tênis", "Kelly Vestido", "2 unidades de Gyda");
(d) a code letter was dropped, or the brand Carbon was translated ("Carbono", "Carbón") or written as "Carbon Jeans".

When fixing: the English name / slogan stays in English exactly; translate only the garment type and plain descriptive words, garment first. Garment words: ${glossary(locale)}

Reply with JSON {"items":[{"i":<index>,"t":"keep" or "<fixed title>","why":"<few words>"}]} covering every input.`;
}

/** Quoted text is a label printed on the garment ('CARBON JEANS' on a waistband) — describing it is accurate. */
const unquoted = (t: string) => t.replace(/['"‘’“”«»][^'"‘’“”«»]{1,80}['"‘’“”«»]/g, " ");

function forbidden(locale: string, text: string): string | null {
  if (/\bcarbon\s+jeans\b/i.test(unquoted(text.replace(/<[^>]+>/g, " ")))) return '"Carbon Jeans"';
  const base = locale.split("-")[0];
  if (base === "es") {
    if (/\btobiller/i.test(text)) return '"tobillera"';
    if (/\btanques?\b/i.test(text)) return '"tanque"';
    if (/\btalones\b/i.test(text)) return '"talones"';
  }
  if (base === "pt" && /\btanques?\b/i.test(text)) return '"tanque"';
  return null;
}

/** Brand translated as a word — unless English itself uses lowercase "carbon" (the material). */
function brandTranslated(src: string, text: string): boolean {
  if (!/\bcarb(o|ó)no?s?\b/i.test(text) || !/(carbono|carbón)/i.test(text)) return false;
  return !/\bcarbon\b/.test(src.replace(/Carbon/g, ""));
}

const tagCount = (h: string) => (h.match(/<[a-z][^>]*>/gi) || []).length;

type Change = {
  product: string;
  productId: string;
  locale: string;
  key: Key;
  reason: string;
  before: string | null;
  after: string;
};

type Resource = {
  resourceId: string;
  translatableContent: Array<{ key: string; value: string | null; digest: string }>;
  [locale: string]: unknown;
};

async function gql<T>(ctx: ShopCtx, query: string, variables?: Record<string, unknown>) {
  const r = (await runShopifyGraphql<T>({ shop: ctx.shop, token: ctx.token, apiVersion: ctx.apiVersion, query, variables })) as {
    ok: boolean;
    data?: T | null;
    errors?: unknown;
  };
  return r;
}

async function progress(pool: Pool, jobId: string, done: number, total: number, message: string) {
  const pct = total ? Math.round((done / total) * 100) : 100;
  await pool.query(
    `UPDATE sync_jobs SET progress_done = $2, progress_total = $3, progress_pct = $4, progress_message = $5, updated_at = now()
      WHERE id = $1::uuid`,
    [jobId, done, total, Math.min(99, pct), message],
  );
}

async function register(
  ctx: ShopCtx,
  resourceId: string,
  locale: string,
  items: Array<{ key: Key; value: string; digest: string }>,
): Promise<string | null> {
  const r = await gql<{ translationsRegister?: { userErrors?: Array<{ message: string }> } }>(
    ctx,
    `mutation($id: ID!, $t: [TranslationInput!]!) { translationsRegister(resourceId: $id, translations: $t) { userErrors { message } } }`,
    { id: resourceId, t: items.map((i) => ({ locale, key: i.key, value: i.value, translatableContentDigest: i.digest })) },
  );
  const errs = r.data?.translationsRegister?.userErrors || [];
  if (!r.ok && !errs.length) return "Shopify rejected the translation";
  return errs.length ? errs.map((e) => e.message).join("; ") : null;
}

export type TranslateResult = {
  model: string;
  locales: string[];
  products: number;
  checked_fields: number;
  changes: Change[];
  titles_reviewed: number;
  titles_fixed: number;
  errors: string[];
};

export async function executeShopifyTranslate(pool: Pool, jobId: string): Promise<void> {
  const jr = await pool.query<{ payload: { fullTitleCheck?: boolean } | null }>(
    `SELECT payload FROM sync_jobs WHERE id = $1::uuid`,
    [jobId],
  );
  const fullTitleCheck = Boolean(jr.rows[0]?.payload?.fullTitleCheck);
  await pool.query(
    `UPDATE sync_jobs SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1::uuid`,
    [jobId],
  );
  const changes: Change[] = [];
  const errors: string[] = [];
  try {
    if (!claudeConfigured()) throw new Error("ANTHROPIC_API_KEY is not set on the server");
    const ctx = await resolveShopContext();
    if (!ctx) throw new Error("Shopify is not connected");

    // Store languages (everything published except the primary language).
    const lr = await gql<{ shopLocales: Array<{ locale: string; primary: boolean; published: boolean }> }>(
      ctx,
      `{ shopLocales { locale primary published } }`,
    );
    const locales = (lr.data?.shopLocales || []).filter((l) => !l.primary && l.published).map((l) => l.locale);
    if (!locales.length) throw new Error("No published store languages besides English");

    // Active products.
    const products: Array<{ id: string; title: string; productType: string }> = [];
    let after: string | null = null;
    for (let page = 0; page < 100; page++) {
      type Page = { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Array<{ id: string; title: string; productType: string }> } };
      const r: { data?: Page | null } = await gql<Page>(ctx, `query($a: String) { products(first: 250, after: $a, query: "status:active") { pageInfo { hasNextPage endCursor } nodes { id title productType } } }`, { a: after });
      const c: Page["products"] | undefined = r.data?.products;
      if (!c) throw new Error("Could not read products from Shopify");
      products.push(...c.nodes);
      if (!c.pageInfo.hasNextPage) break;
      after = c.pageInfo.endCursor;
    }
    const byId = new Map(products.map((p) => [p.id, p]));
    const total = products.length;
    await progress(pool, jobId, 0, total, `Checking ${total} products in ${locales.join(", ")}`);

    // Current translations, 50 products per request.
    const aliases = locales.map((l, i) => `t${i}: translations(locale: "${l}") { key value outdated }`).join(" ");
    const resources: Resource[] = [];
    for (let i = 0; i < products.length; i += 50) {
      const r = await gql<{ translatableResourcesByIds: { nodes: Resource[] } }>(
        ctx,
        `query($ids: [ID!]!) { translatableResourcesByIds(resourceIds: $ids, first: 50) { nodes { resourceId translatableContent { key value digest } ${aliases} } } }`,
        { ids: products.slice(i, i + 50).map((p) => p.id) },
      );
      resources.push(...(r.data?.translatableResourcesByIds.nodes || []));
    }

    let checked = 0;
    // Titles to review afterwards: per locale, product id → current title.
    const reviewTitles = new Map<string, Map<string, string>>(locales.map((l) => [l, new Map()]));
    let done = 0;

    const work = async (res: Resource) => {
      const p = byId.get(res.resourceId);
      if (!p) return;
      const src = new Map(res.translatableContent.map((c) => [c.key, c]));
      for (const [li, locale] of locales.entries()) {
        const tr = new Map(
          ((res[`t${li}`] as Array<{ key: string; value: string | null; outdated: boolean }>) || []).map((t) => [t.key, t]),
        );
        const toAi: Partial<Record<Key, { reason: string; text: string }>> = {};
        const direct: Array<{ key: Key; value: string; reason: string }> = [];
        for (const key of KEYS) {
          const s = src.get(key);
          if (!s?.value) continue;
          checked++;
          const t = tr.get(key);
          let reason: string | null = null;
          if (!t?.value) reason = "missing";
          else if (t.outdated) reason = "English changed";
          else if (brandTranslated(s.value, t.value)) reason = 'brand translated ("Carbono/Carbón")';
          else {
            const f = forbidden(locale, t.value);
            if (f) reason = `uses ${f}`;
          }
          if (reason) {
            toAi[key] = { reason, text: key === "body_html" ? s.value.replace(SET_NOTE_RE, "") : s.value };
            continue;
          }
          // Set note image in the language's own version — no AI needed.
          if (key === "body_html" && t?.value) {
            const enBlock = s.value.match(SET_NOTE_RE)?.[0];
            if (enBlock) {
              const want = setNoteBlock(locale, enBlock);
              const fixed = SET_NOTE_RE.test(t.value) ? t.value.replace(SET_NOTE_RE, want) : t.value + want;
              if (fixed !== t.value) direct.push({ key, value: fixed, reason: '"Complete the Look" image in this language' });
            }
          }
          if (key === "title" && t?.value && fullTitleCheck) reviewTitles.get(locale)!.set(p.id, t.value);
        }

        const out: Array<{ key: Key; value: string; reason: string }> = [...direct];
        const keys = Object.keys(toAi) as Key[];
        if (keys.length) {
          const payload = Object.fromEntries(keys.map((k) => [k, toAi[k]!.text]));
          try {
            let got = await claudeJson<Record<string, string>>(
              translateSystem(locale),
              `Product type: ${p.productType || "unknown"}\nTranslate these fields:\n${JSON.stringify(payload)}`,
              { maxTokens: 12000 },
            );
            // A body that lost HTML tags gets one more try before it is skipped.
            if (got.body_html && payload.body_html && Math.abs(tagCount(got.body_html) - tagCount(payload.body_html)) > 2) {
              got = { ...got, ...(await claudeJson<Record<string, string>>(translateSystem(locale), `Product type: ${p.productType || "unknown"}\nTranslate these fields (keep every HTML tag):\n${JSON.stringify({ body_html: payload.body_html })}`, { maxTokens: 12000 })) };
            }
            for (const k of keys) {
              let v = typeof got[k] === "string" ? got[k].trim() : "";
              if (!v) {
                errors.push(`${p.title} (${locale}) ${k}: no translation returned`);
                continue;
              }
              if (k === "body_html") {
                if (Math.abs(tagCount(v) - tagCount(payload.body_html)) > 2) {
                  errors.push(`${p.title} (${locale}) description: HTML did not survive translation — left as it was`);
                  continue;
                }
                const enBlock = src.get("body_html")!.value!.match(SET_NOTE_RE)?.[0];
                if (enBlock) v += setNoteBlock(locale, enBlock);
              }
              out.push({ key: k, value: v, reason: toAi[k]!.reason });
              if (k === "title") reviewTitles.get(locale)!.set(p.id, v);
            }
          } catch (e) {
            errors.push(`${p.title} (${locale}): ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        if (out.length) {
          const err = await register(
            ctx,
            res.resourceId,
            locale,
            out.map((o) => ({ key: o.key, value: o.value, digest: src.get(o.key)!.digest })),
          );
          if (err) errors.push(`${p.title} (${locale}): ${err}`);
          else
            for (const o of out)
              changes.push({ product: p.title, productId: p.id, locale, key: o.key, reason: o.reason, before: tr.get(o.key)?.value ?? null, after: o.value });
        }
      }
    };

    for (let i = 0; i < resources.length; i += 4) {
      await Promise.all(resources.slice(i, i + 4).map(work));
      done = Math.min(total, i + 4);
      await progress(pool, jobId, done, total, `Translated ${done}/${total} products · ${changes.length} fields changed`);
    }

    // Second pass: review titles that were written now (or every title on a full check).
    let reviewed = 0;
    let fixed = 0;
    for (const locale of locales) {
      const entries = [...reviewTitles.get(locale)!.entries()];
      for (let i = 0; i < entries.length; i += 40) {
        const batch = entries.slice(i, i + 40);
        await progress(pool, jobId, total, total, `Reviewing ${locale} titles ${i + batch.length}/${entries.length}`);
        try {
          const r = await claudeJson<{ items: Array<{ i: number; t: string; why?: string }> }>(
            judgeSystem(locale),
            JSON.stringify(batch.map(([id, cur], j) => ({ i: j, en: byId.get(id)!.title, type: byId.get(id)!.productType, current: cur }))),
            { maxTokens: 6000 },
          );
          reviewed += batch.length;
          for (const it of r.items || []) {
            const row = batch[it.i];
            if (!row || !it.t || it.t === "keep" || it.t.trim() === row[1]) continue;
            const res = resources.find((x) => x.resourceId === row[0]);
            const digest = res?.translatableContent.find((c) => c.key === "title")?.digest;
            if (!digest) continue;
            const err = await register(ctx, row[0], locale, [{ key: "title", value: it.t.trim(), digest }]);
            if (err) errors.push(`${byId.get(row[0])!.title} (${locale}) title: ${err}`);
            else {
              fixed++;
              const prior = changes.find((c) => c.productId === row[0] && c.locale === locale && c.key === "title");
              if (prior) {
                prior.after = it.t.trim();
                prior.reason += ` · reviewed: ${it.why || "fixed"}`;
              } else
                changes.push({ product: byId.get(row[0])!.title, productId: row[0], locale, key: "title", reason: `title review: ${it.why || "fixed"}`, before: row[1], after: it.t.trim() });
            }
          }
        } catch (e) {
          errors.push(`Title review (${locale}): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    const result: TranslateResult = {
      model: claudeModel(),
      locales,
      products: total,
      checked_fields: checked,
      changes: changes.slice(0, 3000),
      titles_reviewed: reviewed,
      titles_fixed: fixed,
      errors: errors.slice(0, 100),
    };
    const summary = changes.length
      ? `${changes.length} field${changes.length === 1 ? "" : "s"} fixed across ${new Set(changes.map((c) => c.productId)).size} products`
      : `All ${total} products already correct in ${locales.join(" + ")}`;
    await pool.query(
      `UPDATE sync_jobs SET status = 'completed', progress_pct = 100, progress_done = progress_total,
              progress_message = $2, finished_at = now(), updated_at = now(),
              payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('result', $3::jsonb)
        WHERE id = $1::uuid`,
      [jobId, summary + (errors.length ? ` · ${errors.length} problem${errors.length === 1 ? "" : "s"}` : ""), JSON.stringify(result)],
    );
  } catch (e) {
    await pool.query(
      `UPDATE sync_jobs SET status = 'failed', error = $2, finished_at = now(), updated_at = now(),
              payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('result', $3::jsonb)
        WHERE id = $1::uuid`,
      [jobId, e instanceof Error ? e.message : String(e), JSON.stringify({ changes, errors })],
    );
  }
}
