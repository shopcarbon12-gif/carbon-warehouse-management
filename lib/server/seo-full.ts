/**
 * Full SEO pass for ONE product — the same work as the owner's full-catalog
 * pass of 2026-11-03/04, installed in CarbonWMS so every new product (and any
 * product whose photos or colours change) ends up the same way.
 *
 * Per product:
 *   1. Read every photo + the WMS facts (category, fabric, set partners, colours, sizes).
 *   2. One Claude vision call with the pass's brief, the owner-approved copy
 *      standard (docs/seo/PRODUCT-COPY-STANDARD.md), the translation glossary,
 *      two approved example products and the store's allowed attribute values.
 *      It returns: SEO title + meta, description, focus keywords, an alt for
 *      EVERY photo, which colour each photo shows, Shopify category attributes,
 *      Spanish + Brazilian-Portuguese versions of all of it, the ES/PT name of
 *      each colour, colour-name concerns and notes for the owner.
 *   3. The pass's checks (lib/seo/claims.ts + structure/length/glossary rules),
 *      with up to two repair rounds. Anything still failing → nothing written.
 *   4. Writes to Shopify: copy (set note kept), Description tab, keywords,
 *      attributes (refused ones dropped), alts, ES/PT translations (set note
 *      localized), colour-name translations, gender/colour/crop/ripped tags
 *      (they feed the keyword collections), the size attribute, photo ↔ colour
 *      links, and a Google feed refresh.
 *
 * Colour RENAMES are never applied here: concerns are stored as suggestions
 * and the owner applies them from the SEO tab (/api/shopify/seo/full/colour).
 *
 * Triggers: the worker watch (maybeRunSeoWatch, every 30 min) for new products
 * and for products whose photos/colours changed since their last run; the SEO
 * tab button; a colour rename applied from the SEO tab.
 */
import crypto from "crypto";
import type { Pool } from "pg";
import { resolveShopContext, type ShopCtx } from "@/lib/server/shopify-write";
import { runShopifyGraphql } from "@/lib/shopify";
import { claudeConfigured, claudeStructured, type ClaudeBlock } from "@/lib/server/claude";
import { findClaims, findClaimsInHtml, type ClaimContext } from "@/lib/seo/claims";
import { glossary, setNoteBlock } from "@/lib/server/shopify-translate";
import { COPY_STANDARD, EXAMPLE_OUTPUT } from "@/lib/seo/full-pass/reference.generated";

export const SEO_FULL_JOB = "shopify_seo_full";
const MODEL = (process.env.SEO_FULL_MODEL || "").trim() || "claude-opus-5-5";
const MAX_PHOTOS = Math.max(4, Math.min(Number(process.env.SEO_FULL_MAX_PHOTOS) || 30, 60));

/* ───────────────────────── Shopify helpers ───────────────────────── */

async function gql<T>(ctx: ShopCtx, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await runShopifyGraphql<T>({ ...ctx, query, variables });
  if (!r.ok || !r.data) throw new Error(`Shopify: ${JSON.stringify(r.errors).slice(0, 300)}`);
  return r.data as T;
}

type MediaNode = { id: string; alt: string | null; mediaContentType: string; image?: { url: string } | null };
type VariantNode = { id: string; sku: string | null; selectedOptions: { name: string; value: string }[]; media: { nodes: { id: string }[] } };
type Product = {
  id: string;
  handle: string;
  title: string;
  status: string;
  productType: string;
  isGiftCard: boolean;
  descriptionHtml: string;
  tags: string[];
  seo: { title: string | null; description: string | null };
  category: { id: string; fullName: string } | null;
  options: { name: string; optionValues: { id: string; name: string }[] }[];
  variants: { nodes: VariantNode[] };
  media: { nodes: MediaNode[] };
  metafields: { nodes: { key: string; references: { nodes: { handle?: string; id?: string }[] } | null }[] };
  partners: { value: string } | null;
  descTab: { id: string } | null;
};

const PRODUCT_Q = `query($id:ID!){
  product(id:$id){ id handle title status productType isGiftCard descriptionHtml tags
    seo{title description} category{id fullName}
    options{name optionValues{id name}}
    variants(first:100){nodes{id sku selectedOptions{name value} media(first:1){nodes{id}}}}
    media(first:100){nodes{id alt mediaContentType ... on MediaImage{image{url}}}}
    metafields(first:60,namespace:"shopify"){nodes{key references(first:30){nodes{... on Metaobject{id handle}}}}}
    partners:metafield(namespace:"carbon_set",key:"partners"){value}
    descTab:metafield(namespace:"custom",key:"short_descriptions_"){id}
  }
  translatableResource(resourceId:$id){ es:translations(locale:"es"){key value} pt:translations(locale:"pt-BR"){key value} }
}`;

const isColourOpt = (n: string) => /^(colou?r|cor)$/i.test(n.trim());
const isSizeOpt = (n: string) => /^(size|talla|tamanho|tamaño)$/i.test(n.trim());
const images = (p: Product) => p.media.nodes.filter((m) => m.mediaContentType === "IMAGE" && m.image?.url);
const colours = (p: Product) => p.options.filter((o) => isColourOpt(o.name)).flatMap((o) => o.optionValues.map((v) => v.name));
const sizes = (p: Product) => p.options.filter((o) => isSizeOpt(o.name)).flatMap((o) => o.optionValues.map((v) => v.name));

/** What a run depends on: the photos (ids, in order) and the colour names on sale. */
export function seoSignature(mediaIds: string[], colourNames: string[]): string {
  return crypto.createHash("sha1").update(mediaIds.join(",") + "|" + colourNames.join(",")).digest("hex");
}

/* Allowed attribute values = the store's shopify--* metaobjects (cached 1 h). */
let attrCache: { at: number; byKey: Map<string, Map<string, string>> } | null = null;
async function allowedAttributes(ctx: ShopCtx): Promise<Map<string, Map<string, string>>> {
  if (attrCache && Date.now() - attrCache.at < 3600_000) return attrCache.byKey;
  const defs = await gql<{ metaobjectDefinitions: { nodes: { type: string }[] } }>(
    ctx,
    `{metaobjectDefinitions(first:250){nodes{type}}}`,
  );
  const byKey = new Map<string, Map<string, string>>();
  for (const d of defs.metaobjectDefinitions.nodes) {
    if (!d.type.startsWith("shopify--")) continue;
    const m = new Map<string, string>();
    let after: string | null = null;
    for (let page = 0; page < 8; page++) {
      const r: { metaobjects: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { id: string; handle: string }[] } } =
        await gql(ctx, `query($t:String!,$a:String){metaobjects(type:$t,first:250,after:$a){pageInfo{hasNextPage endCursor} nodes{id handle}}}`, { t: d.type, a: after });
      for (const n of r.metaobjects.nodes) m.set(n.handle, n.id);
      if (!r.metaobjects.pageInfo.hasNextPage) break;
      after = r.metaobjects.pageInfo.endCursor;
    }
    if (m.size) byKey.set(d.type.replace(/^shopify--/, ""), m);
  }
  attrCache = { at: Date.now(), byKey };
  return byKey;
}

/* ───────────────────────── the brief ───────────────────────── */

function systemPrompt(allowed: Map<string, Map<string, string>>): string {
  const attrList = [...allowed.entries()].map(([k, v]) => `${k}: ${[...v.keys()].join(", ")}`).join("\n");
  return `You write the SEO, alt texts, attributes and Spanish/Portuguese translations for ONE product of shopcarbon.com, the CARBON store. You look at EVERY photo. You only return JSON; the system checks it and writes it to Shopify.

## Per product
1. Look at every photo. The label before each photo says its number and, when Shopify links it to a variant colour, that colour. Photos after a linked one usually belong to the same colour — verify by eye.
2. Colour check. For each variant colour, look at its photos. Report a concern in "colourFix" ONLY when the name clearly misleads a shopper filtering by it. Approved precedents: BRONZE on a plain camel tee → CAMEL; TURQUOISE on a deep dark teal → DARK TEAL; BLACK on grey-and-white speckled beads → GREY; BLACK on navy beads → NAVY. NOT a concern: a shade inside the same family (a teal-leaning blue stays BLUE, sage stays GREEN), washed/denim names (BLUE WASHED, BLACK WASHED) unless flatly wrong, PATTERN/MULTI. A proposed name is UPPER CASE, a common retail colour word, and must not duplicate another variant colour of the product. Give "photos" (evidence) and "why" (one plain sentence). These are only SUGGESTIONS for the owner: write ALL copy and alts with the CURRENT variant colour names.
3. Do not report anything else as colourFix. Put in "ownerNotes" instead: a photo showing a colour that is not a variant, a variant colour with no photo, a photo of the wrong product, duplicate photos, a print that differs between colours, anything that needs the owner's confirmation (e.g. an accessory in the photos that may or may not be included). Leave it empty when there is nothing.
4. Write the copy to the standard below.
   - seoTitle: "<Name> – <Men's|Women's> <search phrase> | CARBON", at most 70 characters.
   - metaDescription: 110–155 characters; never start with Shop/Discover/Explore/Meet/Introducing.
   - descriptionHtml: <p>, <p>, <ul> using only p/ul/li/a tags. NEVER include the carbon-set-note paragraph (it is re-added automatically).
   - Set pieces with a live partner use the link pattern of the example (/products/<partner handle> and the partner's title).
   - focus: one search phrase. secondary: three phrases.
5. alts: one for EVERY photo, numbered 1..n in photo order. Format "<Name> in <Colour in Title Case> – <what this photo shows>" (5–15 words). The colour is the variant colour that photo shows. Say what differs in this view (front, back, side, close-up of X, seated, flat lay). Describe only what is visible. No "image of", no claims (fabric feel, fit, LED, waterproof…). A colour name that is a pattern becomes a description ("in multicolor city print").
6. photoColours: for every photo, the CURRENT variant colour it shows, exactly as written in the variant list; "" when it shows none of them.
7. attrs (Shopify category attributes): only the keys and values listed under "Allowed attribute values". Fix what is wrong or missing and visible or factual:
   - color-pattern covers the variant colours, mapped to the closest values: camel/stone/sand → beige, navy → blue, charcoal → gray, teal → turquoise, burgundy/wine → red, lilac → purple, peach → orange, olive/sage → green.
   - fabric from the WMS fabric fact.
   - neckline, sleeve-length-type, top-length-type, skirt-dress-length-type, waist-rise, pants-length-type only when clearly visible; waist-rise "high" needs the photos to show it.
   - target-gender is male/female from the WMS category (MEN/WOMEN).
   - Use remove=true to DELETE claims nobody can see: quick-drying, breathable-design, moisture-wicking, lightweight, wrinkle-resistant, cushioned, slip-resistant, compression, four-way-stretch. When you remove one value from a list, write the full remaining list instead (remove=false).
   - Leave out keys that are already right. Do not invent keys the category does not use; "currentAttributes" shows what it uses. Footwear keys need a shoe category; sneaker-style only if currentAttributes already has a shoe key. Do not touch "size" or "shoe-size" (set automatically).
8. es (US Spanish) and pt (Brazilian Portuguese), following the glossary exactly:
   - title: keep the current translated title when it follows the rules; fix it when it breaks them (a name translated literally, wrong garment word, dropped code letter, translated brand, English name not moved after the garment word — the pattern is "Jay Jeans" → "Jeans Jay").
   - metaTitle: the translated seoTitle, at most 70 characters, ending " | CARBON".
   - metaDescription: 90–160 characters.
   - body: the same HTML tags in the same order as the English; translate only the text, keep link hrefs. Partner link text stays the English product title.
   - alts: every photo — "<translated title> en <colour> – <view>" (es), "<translated title> em <colour> – <view>" (pt).
   - The brand CARBON is never translated. Product names and slogans stay in English. Natural US-Spanish and Brazilian-Portuguese retail wording.
9. colourNames: the es and pt name of EVERY variant colour (UPPER CASE, glossary words; e.g. NAVY → AZUL MARINO / AZUL-MARINHO, MINT → MENTA / VERDE MENTA, CHARCOAL → GRIS OSCURO / CINZA-ESCURO).
10. confidence: high / medium / low.

## The owner-approved writing standard (every rule applies)
${COPY_STANDARD}

## Spanish glossary
${glossary("es")}

## Portuguese glossary
${glossary("pt-BR")}

## Two finished, owner-approved products (style and level of detail to match; their field layout differs from yours — follow YOUR schema)
${EXAMPLE_OUTPUT}

## Allowed attribute values (key: handle, handle…)
${attrList}`;
}

const altArr = { type: "array", items: { type: "object", additionalProperties: false, required: ["n", "alt"], properties: { n: { type: "integer" }, alt: { type: "string" } } } };
const trObj = {
  type: "object",
  additionalProperties: false,
  required: ["title", "metaTitle", "metaDescription", "body", "alts"],
  properties: { title: { type: "string" }, metaTitle: { type: "string" }, metaDescription: { type: "string" }, body: { type: "string" }, alts: altArr },
};
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["seoTitle", "metaDescription", "descriptionHtml", "focus", "secondary", "alts", "photoColours", "attrs", "colourFix", "ownerNotes", "confidence", "es", "pt", "colourNames"],
  properties: {
    seoTitle: { type: "string" },
    metaDescription: { type: "string" },
    descriptionHtml: { type: "string" },
    focus: { type: "string" },
    secondary: { type: "array", items: { type: "string" } },
    alts: altArr,
    photoColours: { type: "array", items: { type: "object", additionalProperties: false, required: ["n", "colour"], properties: { n: { type: "integer" }, colour: { type: "string" } } } },
    attrs: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "values", "remove"], properties: { key: { type: "string" }, values: { type: "array", items: { type: "string" } }, remove: { type: "boolean" } } } },
    colourFix: { type: "array", items: { type: "object", additionalProperties: false, required: ["from", "to", "why", "photos"], properties: { from: { type: "string" }, to: { type: "string" }, why: { type: "string" }, photos: { type: "array", items: { type: "integer" } } } } },
    ownerNotes: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    es: trObj,
    pt: trObj,
    colourNames: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "es", "pt"], properties: { name: { type: "string" }, es: { type: "string" }, pt: { type: "string" } } } },
  },
};

type Alt = { n: number; alt: string };
type Tr = { title: string; metaTitle: string; metaDescription: string; body: string; alts: Alt[] };
export type FullSeoOutput = {
  seoTitle: string;
  metaDescription: string;
  descriptionHtml: string;
  focus: string;
  secondary: string[];
  alts: Alt[];
  photoColours: { n: number; colour: string }[];
  attrs: { key: string; values: string[]; remove: boolean }[];
  colourFix: { from: string; to: string; why: string; photos: number[] }[];
  ownerNotes: string;
  confidence: "high" | "medium" | "low";
  es: Tr;
  pt: Tr;
  colourNames: { name: string; es: string; pt: string }[];
};

/* ───────────────────────── the checks (same as the pass) ───────────────────────── */

const SET_NOTE_RE = /<p class="carbon-set-note">[\s\S]*?<\/p>/;
const BAN = /\b(elevate|versatile|must-have|boasts|adorned|wardrobe staple|essential|staple|statement piece|trendy|stylish|chic|sleek|timeless|iconic|edgy|vibe|effortless|flattering|perfect|step into|turn heads|look no further|add a touch|you'll love|standard|game-changer|soft|stretch|stretchy|breathable|lightweight|cozy|comfortable|comfort|durable|premium|high quality|true to size|slim fit|relaxed fit|high-rise|zip fly|button fly|made in|handmade|carbon jeans|hexagon)\b/i;
const BAN_ES = /\b(carbono|carbón|tanque|tobillera|vaqueros|pantalones cortos|bañador|talones|camiseta sin mangas)\b/i;
const BAN_PT = /\b(carbono|tanque|maiô|sunga)\b/i;
const cover = (alts: Alt[], n: number) => {
  const got = alts.map((a) => a.n).sort((a, b) => a - b);
  return got.length === n && got.every((v, i) => v === i + 1) && alts.every((a) => a.alt.trim());
};
const count = (s: string, needle: string) => s.split(needle).length - 1;

export function checkOutput(o: FullSeoOutput, p: Product, allowed: Map<string, Map<string, string>>, ctx: ClaimContext): string[] {
  const iss: string[] = [];
  const n = images(p).length;
  const cols = colours(p);
  if (!/ \| CARBON$/.test(o.seoTitle)) iss.push("seoTitle must end ' | CARBON'");
  if (o.seoTitle.length > 70) iss.push(`seoTitle is ${o.seoTitle.length} characters (max 70)`);
  if (o.metaDescription.length < 110 || o.metaDescription.length > 155) iss.push(`metaDescription is ${o.metaDescription.length} characters (110–155)`);
  if (/^(Shop|Discover|Explore|Meet|Introducing)\b/.test(o.metaDescription)) iss.push("metaDescription opener (Shop/Discover/…) not allowed");
  if (SET_NOTE_RE.test(o.descriptionHtml)) iss.push("descriptionHtml must not contain the set note");
  if (/<(?!\/?(p|ul|li|a)\b)[^>]+>/.test(o.descriptionHtml)) iss.push("descriptionHtml may only use p/ul/li/a tags");
  if (!cover(o.alts, n)) iss.push(`alts must cover photos 1..${n}, each non-empty`);
  const enText = [o.seoTitle, o.metaDescription, o.descriptionHtml, ...o.alts.map((a) => a.alt)].join(" ");
  const m = enText.match(BAN);
  if (m) iss.push(`banned word "${m[0]}"`);
  const findings = [
    ...findClaims(o.seoTitle, ctx),
    ...findClaims(o.metaDescription, ctx),
    ...findClaimsInHtml(o.descriptionHtml, ctx),
    ...o.alts.flatMap((a) => findClaims(a.alt, ctx).filter((x) => x.kind !== "cliche")),
  ];
  for (const f of findings) iss.push(`claim (${f.kind}) "${f.term}" in: ${f.sentence.slice(0, 120)}`);
  for (const a of o.attrs) {
    const vals = allowed.get(a.key);
    if (!vals) { iss.push(`unknown attribute "${a.key}"`); continue; }
    if (a.key === "size" || a.key === "shoe-size") iss.push(`do not set "${a.key}" (set automatically)`);
    if (!a.remove) for (const v of a.values) if (!vals.has(v)) iss.push(`${a.key}: "${v}" not an allowed value`);
  }
  for (const pc of o.photoColours) if (pc.colour && !cols.includes(pc.colour)) iss.push(`photoColours #${pc.n}: "${pc.colour}" is not a variant colour`);
  for (const c of cols) if (!o.colourNames.some((x) => x.name === c && x.es.trim() && x.pt.trim())) iss.push(`colourNames missing es/pt for "${c}"`);
  for (const [L, ban] of [["es", BAN_ES], ["pt", BAN_PT]] as const) {
    const t = o[L];
    for (const k of ["title", "metaTitle", "metaDescription", "body"] as const) if (!t[k]?.trim()) iss.push(`${L}.${k} missing`);
    if (t.metaTitle.length > 70) iss.push(`${L}.metaTitle is ${t.metaTitle.length} characters (max 70)`);
    if (!t.metaTitle.endsWith(" | CARBON")) iss.push(`${L}.metaTitle must end ' | CARBON'`);
    if (t.metaDescription.length < 90 || t.metaDescription.length > 160) iss.push(`${L}.metaDescription is ${t.metaDescription.length} characters (90–160)`);
    if (!cover(t.alts, n)) iss.push(`${L}.alts must cover photos 1..${n}`);
    const blob = JSON.stringify(t);
    const b = blob.match(ban);
    if (b) iss.push(`${L}: forbidden word "${b[0]}"`);
    if (/carbon jeans/i.test(blob) && !o.descriptionHtml.includes("CARBON JEANS")) iss.push(`${L}: says Carbon Jeans`);
    if (count(t.body, "<li>") !== count(o.descriptionHtml, "<li>") || count(t.body, "<p>") !== count(o.descriptionHtml, "<p>")) iss.push(`${L}.body HTML structure differs from the English`);
    if (SET_NOTE_RE.test(t.body)) iss.push(`${L}.body must not contain the set note`);
  }
  for (const f of o.colourFix) if (!f.from || !f.to || !f.why || !cols.includes(f.from)) iss.push(`colourFix "${f.from}" → "${f.to}" needs a current variant colour, a new name and why`);
  return iss;
}

/* ───────────────────────── facts + call ───────────────────────── */

type WmsFacts = { matrixId: string | null; category: string | null; subcategory: string | null; fabric: string | null; care: string | null; isSet: boolean };

async function wmsFacts(pool: Pool, productId: string): Promise<WmsFacts> {
  const r = await pool.query<{ id: string; category: string | null; subcategory_1: string | null; fabric_composition: string | null; care_instructions: string | null; is_set: boolean | null }>(
    `SELECT id::text, category, subcategory_1, fabric_composition, care_instructions, is_set
       FROM matrices WHERE shopify_product_id = $1 ORDER BY shopify_pushed_at DESC NULLS LAST LIMIT 1`,
    [productId],
  );
  const m = r.rows[0];
  return { matrixId: m?.id ?? null, category: m?.category ?? null, subcategory: m?.subcategory_1 ?? null, fabric: m?.fabric_composition ?? null, care: m?.care_instructions ?? null, isSet: Boolean(m?.is_set) };
}

async function partnerTitles(ctx: ShopCtx, handles: string[]): Promise<{ handle: string; title: string }[]> {
  const out: { handle: string; title: string }[] = [];
  for (const h of handles) {
    const r = await gql<{ productByHandle: { title: string; status: string } | null }>(ctx, `query($h:String!){productByHandle(handle:$h){title status}}`, { h });
    if (r.productByHandle?.status === "ACTIVE") out.push({ handle: h, title: r.productByHandle.title });
  }
  return out;
}

function photoUrl(u: string): string {
  return u + (u.includes("?") ? "&" : "?") + "width=1200";
}

async function generate(
  p: Product,
  tr: { es: Record<string, string>; pt: Record<string, string> },
  facts: WmsFacts,
  partners: { handle: string; title: string }[],
  allowed: Map<string, Map<string, string>>,
): Promise<{ out: FullSeoOutput; issues: string[]; rounds: number }> {
  const imgs = images(p).slice(0, MAX_PHOTOS);
  const linked = new Map<string, string>();
  for (const v of p.variants.nodes) {
    const mid = v.media.nodes[0]?.id;
    const col = v.selectedOptions.find((o) => isColourOpt(o.name))?.value;
    if (mid && col) linked.set(mid, col);
  }
  const current: Record<string, string[]> = {};
  for (const m of p.metafields.nodes) if (m.references?.nodes.length) current[m.key] = m.references.nodes.map((x) => x.handle || "").filter(Boolean);
  const factSheet = {
    handle: p.handle,
    name: p.title,
    productType: p.productType,
    shopifyCategory: p.category?.fullName ?? null,
    wmsCategory: facts.category,
    wmsSubcategory: facts.subcategory,
    variantColours: colours(p),
    sizes: sizes(p),
    fabric: facts.fabric,
    care: facts.care,
    setPartners: partners,
    currentAttributes: current,
    currentSeo: p.seo,
    previousDescription: (p.descriptionHtml || "").replace(SET_NOTE_RE, "").slice(0, 2500),
    currentTitleEs: tr.es.title ?? null,
    currentTitlePt: tr.pt.title ?? null,
    photoCount: imgs.length,
  };
  const content: ClaudeBlock[] = [{ type: "text", text: `Product facts (from the WMS and Shopify):\n${JSON.stringify(factSheet, null, 1)}\n\nThe photos follow, in order.` }];
  imgs.forEach((m, i) => {
    const col = linked.get(m.id);
    content.push({ type: "text", text: `Photo #${i + 1}${col ? ` ▸ linked to ${col}` : ""}` });
    content.push({ type: "image", source: { type: "url", url: photoUrl(m.image!.url) } });
  });
  const system = systemPrompt(allowed);
  const ctx: ClaimContext = { productTitle: p.title, isSet: facts.isSet, setPartners: partners.map((x) => x.title), fabric: facts.fabric || undefined };
  const probe = { ...p, media: { nodes: imgs } } as Product;

  let out = await claudeStructured<FullSeoOutput>({ system, content, schema: SCHEMA, model: MODEL, effort: "high", maxTokens: 32000 });
  let issues = checkOutput(out, probe, allowed, ctx);
  let rounds = 0;
  while (issues.length && rounds < 2) {
    rounds++;
    out = await claudeStructured<FullSeoOutput>({
      system,
      content: [
        { type: "text", text: `Product facts:\n${JSON.stringify(factSheet, null, 1)}` },
        { type: "text", text: `Your previous answer:\n${JSON.stringify(out)}\n\nThe checker found these problems. Return the WHOLE answer again with every problem fixed. Change the wording rather than dropping facts; keep everything else as it was.\n- ${issues.join("\n- ")}` },
      ],
      schema: SCHEMA,
      model: MODEL,
      effort: "high",
      maxTokens: 32000,
    });
    issues = checkOutput(out, probe, allowed, ctx);
  }
  return { out, issues, rounds };
}

/* ───────────────────────── the writes ───────────────────────── */

const COLOUR_TAGS: Record<string, string[]> = { black: ["black"], white: ["white"], blue: ["blue"], gray: ["grey", "gray"], beige: ["beige"] };
const RIPPED = /(?<!no )(?<!without )\b(ripped|rips|torn|tears|destroyed|shredded|slash)\w*/i;

async function register(ctx: ShopCtx, resourceId: string, translations: unknown[]): Promise<string[]> {
  if (!translations.length) return [];
  const r = await gql<{ translationsRegister: { userErrors: { message: string }[] } }>(
    ctx,
    `mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){userErrors{message}}}`,
    { id: resourceId, t: translations },
  );
  return r.translationsRegister.userErrors.map((e) => e.message);
}

async function digests(ctx: ShopCtx, id: string): Promise<Record<string, string>> {
  const r = await gql<{ translatableResource: { translatableContent: { key: string; digest: string }[] } | null }>(
    ctx,
    `query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest}}}`,
    { id },
  );
  return Object.fromEntries((r.translatableResource?.translatableContent || []).map((c) => [c.key, c.digest]));
}

const plainParas = (html: string) => [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

async function write(ctx: ShopCtx, p: Product, o: FullSeoOutput, allowed: Map<string, Map<string, string>>, current: Record<string, string[]>): Promise<{ errors: string[]; done: string[] }> {
  const errors: string[] = [];
  const done: string[] = [];
  const imgs = images(p);
  const note = (p.descriptionHtml || "").match(SET_NOTE_RE)?.[0] || "";

  /* 1. English copy (set note kept) — seo title + description always together. */
  const u = await gql<{ productUpdate: { userErrors: { message: string }[] } }>(
    ctx,
    `mutation($i:ProductUpdateInput!){productUpdate(product:$i){userErrors{message}}}`,
    { i: { id: p.id, descriptionHtml: o.descriptionHtml + note, seo: { title: o.seoTitle, description: o.metaDescription } } },
  );
  errors.push(...u.productUpdate.userErrors.map((e) => `copy: ${e.message}`));
  done.push("SEO title, meta description, description");

  /* 2. Description tab, keywords, attributes (a category may refuse a key → drop it, retry). */
  const mf: { ownerId: string; namespace: string; key: string; type: string; value: string }[] = [
    { ownerId: p.id, namespace: "custom", key: "short_descriptions_", type: "multi_line_text_field", value: plainParas(o.descriptionHtml).join("\n\n") },
    { ownerId: p.id, namespace: "carbon_seo", key: "focus_keyword", type: "single_line_text_field", value: o.focus },
    { ownerId: p.id, namespace: "carbon_seo", key: "secondary_keywords", type: "list.single_line_text_field", value: JSON.stringify(o.secondary) },
    { ownerId: p.id, namespace: "carbon_seo", key: "optimized_at", type: "single_line_text_field", value: new Date().toISOString() },
  ];
  const removals: string[] = [];
  const finalAttrs: Record<string, string[]> = { ...current };
  for (const a of o.attrs) {
    if (a.remove || !a.values.length) { removals.push(a.key); delete finalAttrs[a.key]; continue; }
    const ids = a.values.map((v) => allowed.get(a.key)?.get(v)).filter((x): x is string => Boolean(x));
    if (!ids.length) continue;
    mf.push({ ownerId: p.id, namespace: "shopify", key: a.key, type: "list.metaobject_reference", value: JSON.stringify(ids) });
    finalAttrs[a.key] = a.values;
  }
  /* Size attribute = every size on sale that the store has a value for. */
  for (const key of ["size", "shoe-size"]) {
    if (!current[key]) continue;
    const vals = allowed.get(key);
    const want = sizes(p).map((s) => s.trim().toLowerCase()).filter((s) => vals?.has(s));
    if (want.length && want.some((s) => !current[key].includes(s))) {
      mf.push({ ownerId: p.id, namespace: "shopify", key, type: "list.metaobject_reference", value: JSON.stringify(want.map((s) => vals!.get(s)!)) });
      done.push(`${key} attribute completed`);
    }
  }
  const setMf = async (list: typeof mf) =>
    (await gql<{ metafieldsSet: { userErrors: { field: string[] | null; message: string }[] } }>(
      ctx,
      `mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{field message}}}`,
      { m: list },
    )).metafieldsSet.userErrors;
  let mfErr = await setMf(mf);
  if (mfErr.length) {
    const bad = new Set(mfErr.map((e) => (e.field && e.field[1] && /^\d+$/.test(e.field[1]) ? mf[Number(e.field[1])]?.key : "")).filter(Boolean));
    const retry = mf.filter((m) => !(m.namespace === "shopify" && (bad.has(m.key) || !bad.size)));
    mfErr = await setMf(retry);
    if (!mfErr.length) {
      done.push(`attributes refused by the category, skipped: ${[...bad].join(", ") || "all"}`);
      for (const k of bad) delete finalAttrs[k];
    }
  }
  errors.push(...mfErr.map((e) => `metafields: ${e.message}`));
  if (removals.length) {
    const d = await gql<{ metafieldsDelete: { userErrors: { message: string }[] } }>(
      ctx,
      `mutation($m:[MetafieldIdentifierInput!]!){metafieldsDelete(metafields:$m){userErrors{message}}}`,
      { m: removals.map((key) => ({ ownerId: p.id, namespace: "shopify", key })) },
    );
    errors.push(...d.metafieldsDelete.userErrors.map((e) => `remove attribute: ${e.message}`));
  }
  done.push("Description tab, keywords, attributes");

  /* 3. Alt text on every photo. */
  const files = o.alts.filter((a) => imgs[a.n - 1]).map((a) => ({ id: imgs[a.n - 1].id, alt: a.alt }));
  for (let i = 0; i < files.length; i += 25) {
    const f = await gql<{ fileUpdate: { userErrors: { message: string }[] } }>(
      ctx,
      `mutation($f:[FileUpdateInput!]!){fileUpdate(files:$f){userErrors{message}}}`,
      { f: files.slice(i, i + 25) },
    );
    errors.push(...f.fileUpdate.userErrors.map((e) => `alt: ${e.message}`));
  }
  done.push(`${files.length} photo alts`);

  /* 4. Spanish + Portuguese: product fields, Description tab, photo alts. */
  const pd = await digests(ctx, p.id);
  const fresh = await gql<{ product: { descTab: { id: string } | null } }>(ctx, `query($id:ID!){product(id:$id){descTab:metafield(namespace:"custom",key:"short_descriptions_"){id}}}`, { id: p.id });
  const tabId = fresh.product.descTab?.id;
  const tabDg = tabId ? await digests(ctx, tabId) : {};
  const altDg = new Map<string, string>();
  for (let i = 0; i < imgs.length; i += 100) {
    const r = await gql<{ translatableResourcesByIds: { nodes: { resourceId: string; translatableContent: { key: string; digest: string }[] }[] } }>(
      ctx,
      `query($ids:[ID!]!){translatableResourcesByIds(resourceIds:$ids,first:100){nodes{resourceId translatableContent{key digest}}}}`,
      { ids: imgs.slice(i, i + 100).map((m) => m.id) },
    );
    for (const n of r.translatableResourcesByIds.nodes) {
      const d = n.translatableContent.find((c) => c.key === "alt")?.digest;
      if (d) altDg.set(n.resourceId, d);
    }
  }
  for (const [L, loc] of [["es", "es"], ["pt", "pt-BR"]] as const) {
    const t = o[L];
    const body = t.body + (note ? setNoteBlock(loc, note) : "");
    const fields: [string, string][] = [["title", t.title], ["body_html", body], ["meta_title", t.metaTitle], ["meta_description", t.metaDescription]];
    errors.push(...(await register(ctx, p.id, fields.filter(([k]) => pd[k]).map(([key, value]) => ({ locale: loc, key, value, translatableContentDigest: pd[key] })))).map((e) => `${loc}: ${e}`));
    if (tabId && tabDg.value) errors.push(...(await register(ctx, tabId, [{ locale: loc, key: "value", value: plainParas(t.body).join("\n\n"), translatableContentDigest: tabDg.value }])).map((e) => `${loc} tab: ${e}`));
    for (const a of t.alts) {
      const m = imgs[a.n - 1];
      const d = m && altDg.get(m.id);
      if (d) errors.push(...(await register(ctx, m.id, [{ locale: loc, key: "alt", value: a.alt, translatableContentDigest: d }])).map((e) => `${loc} alt: ${e}`));
    }
  }
  done.push("Spanish + Portuguese (copy, Description tab, alts)");

  /* 5. Colour names in ES/PT — only where missing or clearly wrong (never over an existing good one). */
  const BADNAME = /CASA DE LA MONEDA|CARB[OÓ]N|CARBONO/i;
  for (const opt of p.options.filter((x) => isColourOpt(x.name))) {
    for (const v of opt.optionValues) {
      const want = o.colourNames.find((c) => c.name === v.name);
      if (!want) continue;
      const r = await gql<{ translatableResource: { translatableContent: { key: string; digest: string }[]; es: { value: string }[]; pt: { value: string }[] } | null }>(
        ctx,
        `query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest} es:translations(locale:"es"){value} pt:translations(locale:"pt-BR"){value}}}`,
        { id: v.id },
      );
      const tr = r.translatableResource;
      if (!tr?.translatableContent[0]) continue;
      const d = tr.translatableContent[0];
      const items: unknown[] = [];
      for (const [loc, cur, val] of [["es", tr.es[0]?.value, want.es], ["pt-BR", tr.pt[0]?.value, want.pt]] as const) {
        if (!cur || BADNAME.test(cur)) items.push({ locale: loc, key: d.key, value: val.toUpperCase(), translatableContentDigest: d.digest });
      }
      errors.push(...(await register(ctx, v.id, items)).map((e) => `colour name: ${e}`));
    }
  }

  /* 6. Tags the keyword collections use: gender, colour family, crop top, ripped. */
  const tags = new Set(p.tags.map((t) => t.toLowerCase()));
  const add: string[] = [];
  const rem: string[] = [];
  const g = finalAttrs["target-gender"] || [];
  const wantG = new Set<string>();
  if (g.includes("female") || g.includes("unisex")) wantG.add("women");
  if (g.includes("male") || g.includes("unisex")) wantG.add("men");
  if (wantG.size) for (const w of ["women", "men"]) { if (wantG.has(w) && !tags.has(w)) add.push(w); if (!wantG.has(w) && tags.has(w)) rem.push(w); }
  const cp = finalAttrs["color-pattern"] || [];
  if (cp.length) for (const [fam, words] of Object.entries(COLOUR_TAGS)) for (const w of words) { if (cp.includes(fam) && !tags.has(w)) add.push(w); if (!cp.includes(fam) && tags.has(w)) rem.push(w); }
  if (g.includes("female") && (finalAttrs["top-length-type"] || []).includes("crop-top") && !tags.has("crop top")) add.push("crop top");
  if (/jeans/i.test(p.category?.fullName || "")) {
    const ripped = RIPPED.test(o.descriptionHtml.replace(/<[^>]+>/g, " "));
    if (ripped && !tags.has("ripped")) add.push("ripped");
    if (!ripped && tags.has("ripped")) rem.push("ripped");
  }
  const origCase = new Map(p.tags.map((t) => [t.toLowerCase(), t]));
  if (add.length) await gql(ctx, `mutation($id:ID!,$t:[String!]!){tagsAdd(id:$id,tags:$t){userErrors{message}}}`, { id: p.id, t: add });
  if (rem.length) await gql(ctx, `mutation($id:ID!,$t:[String!]!){tagsRemove(id:$id,tags:$t){userErrors{message}}}`, { id: p.id, t: rem.map((t) => origCase.get(t) || t) });
  if (add.length || rem.length) done.push(`tags +[${add.join(", ")}] -[${rem.join(", ")}]`);

  /* 7. Photo ↔ colour: a colour whose variants have no photo gets the first photo showing it. */
  const byColour = new Map<string, VariantNode[]>();
  for (const v of p.variants.nodes) {
    const col = v.selectedOptions.find((x) => isColourOpt(x.name))?.value || "";
    byColour.set(col, [...(byColour.get(col) || []), v]);
  }
  const cols = colours(p);
  const links: { variantId: string; mediaIds: string[] }[] = [];
  for (const [col, vs] of byColour) {
    if (vs.some((v) => v.media.nodes.length)) continue;
    let n = o.photoColours.find((x) => x.colour === col)?.n;
    if (!n && cols.length <= 1 && imgs.length) n = 1;
    const m = n ? imgs[n - 1] : undefined;
    if (m) for (const v of vs) links.push({ variantId: v.id, mediaIds: [m.id] });
  }
  if (links.length) {
    const r = await gql<{ productVariantAppendMedia: { userErrors: { message: string }[] } }>(
      ctx,
      `mutation($p:ID!,$v:[ProductVariantAppendMediaInput!]!){productVariantAppendMedia(productId:$p,variantMedia:$v){userErrors{message}}}`,
      { p: p.id, v: links },
    );
    errors.push(...r.productVariantAppendMedia.userErrors.map((e) => `photo link: ${e.message}`));
    done.push(`${links.length} variants linked to their colour's photo`);
  }

  /* 8. Nudge Google Merchant Center to re-read the listing now. */
  await gql(ctx, `mutation($id:ID!){tagsAdd(id:$id,tags:["_feed-sync"]){userErrors{message}}}`, { id: p.id });
  await new Promise((r) => setTimeout(r, 4000));
  await gql(ctx, `mutation($id:ID!){tagsRemove(id:$id,tags:["_feed-sync"]){userErrors{message}}}`, { id: p.id });
  done.push("Google feed refreshed");
  return { errors, done };
}

/* ───────────────────────── job + watch ───────────────────────── */

async function progress(pool: Pool, jobId: string, pct: number, msg: string) {
  await pool.query(`UPDATE sync_jobs SET progress_pct=$2, progress_message=$3, updated_at=now() WHERE id=$1::uuid`, [jobId, pct, msg.slice(0, 500)]);
}

/** Worker entrypoint for `shopify_seo_full`. Payload: { productId, trigger, runId }. Self-terminal. */
export async function executeSeoFull(pool: Pool, jobId: string): Promise<void> {
  const j = await pool.query<{ tenant_id: string; payload: { productId?: string; runId?: string } }>(`SELECT tenant_id::text, payload FROM sync_jobs WHERE id=$1::uuid`, [jobId]);
  const { productId, runId } = j.rows[0]?.payload || {};
  const finish = async (status: "completed" | "failed", msg: string, runStatus: string, result: unknown, error: string | null) => {
    await pool.query(`UPDATE sync_jobs SET status=$2, progress_pct=100, progress_message=$3, finished_at=now(), updated_at=now() WHERE id=$1::uuid`, [jobId, status, msg.slice(0, 500)]);
    if (runId) await pool.query(`UPDATE seo_full_runs SET status=$2, result=$3::jsonb, error=$4, finished_at=now() WHERE id=$1::uuid`, [runId, runStatus, JSON.stringify(result ?? null), error]);
  };
  try {
    if (!productId) return finish("failed", "missing productId", "failed", null, "missing productId");
    if (!claudeConfigured()) return finish("failed", "ANTHROPIC_API_KEY not set", "failed", null, "ANTHROPIC_API_KEY not set");
    const ctx = await resolveShopContext();
    if (!ctx) return finish("failed", "Shop not connected", "failed", null, "Shop not connected");
    if (runId) await pool.query(`UPDATE seo_full_runs SET status='running' WHERE id=$1::uuid`, [runId]);

    await progress(pool, jobId, 5, "Reading the product and its photos");
    const d = await gql<{ product: Product | null; translatableResource: { es: { key: string; value: string }[]; pt: { key: string; value: string }[] } | null }>(ctx, PRODUCT_Q, { id: productId });
    const p = d.product;
    if (!p) return finish("failed", "product not found", "failed", null, "product not found");
    if (p.isGiftCard) return finish("completed", "gift card — skipped", "skipped", null, null);
    if (!images(p).length) return finish("completed", "no photos yet — skipped", "skipped", null, null);
    const tr = {
      es: Object.fromEntries((d.translatableResource?.es || []).map((t) => [t.key, t.value])),
      pt: Object.fromEntries((d.translatableResource?.pt || []).map((t) => [t.key, t.value])),
    };
    const facts = await wmsFacts(pool, p.id);
    let partnerHandles: string[] = [];
    try { partnerHandles = JSON.parse(p.partners?.value || "[]"); } catch { /* none */ }
    const partners = await partnerTitles(ctx, partnerHandles);
    const allowed = await allowedAttributes(ctx);
    const signature = seoSignature(p.media.nodes.map((m) => m.id), colours(p));
    if (runId) await pool.query(`UPDATE seo_full_runs SET signature=$2, handle=$3, matrix_id=COALESCE(matrix_id,$4::uuid) WHERE id=$1::uuid`, [runId, signature, p.handle, facts.matrixId]);

    await progress(pool, jobId, 20, `Writing from ${images(p).length} photos (AI)`);
    const { out, issues, rounds } = await generate(p, tr, facts, partners, allowed);
    if (issues.length) {
      return finish("failed", `checks failed after ${rounds} repair round(s): ${issues.slice(0, 3).join("; ")}`, "failed", { output: out, issues }, issues.join("\n").slice(0, 4000));
    }
    if (process.env.SEO_FULL_DRY === "1") return finish("completed", `dry run — checks passed after ${rounds} repair round(s), nothing written`, "skipped", { output: out, rounds, dry: true }, null);
    await progress(pool, jobId, 70, "Writing to Shopify (EN, ES, PT, alts, attributes, tags)");
    const current: Record<string, string[]> = {};
    for (const m of p.metafields.nodes) if (m.references?.nodes.length) current[m.key] = m.references.nodes.map((x) => x.handle || "").filter(Boolean);
    const w = await write(ctx, p, out, allowed, current);
    if (facts.matrixId) await pool.query(`UPDATE matrices SET seo_optimized_at=now() WHERE id=$1::uuid`, [facts.matrixId]);
    const msg = `${p.title}: ${w.done.join(" · ")}${out.colourFix.length ? ` · ${out.colourFix.length} colour suggestion(s) for the owner` : ""}`;
    return finish(w.errors.length ? "failed" : "completed", w.errors.length ? `written with errors: ${w.errors.slice(0, 3).join("; ")}` : msg, w.errors.length ? "failed" : "done", { output: out, rounds, done: w.done, errors: w.errors }, w.errors.join("\n") || null);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finish("failed", `crashed: ${msg}`, "failed", null, msg);
  }
}

/** Read-only: generate + check one product, write nothing (tests and comparisons). */
export async function previewSeoFull(pool: Pool, productId: string): Promise<{ output: FullSeoOutput; issues: string[]; rounds: number; photos: number }> {
  const ctx = await resolveShopContext();
  if (!ctx) throw new Error("Shop not connected");
  const d = await gql<{ product: Product | null; translatableResource: { es: { key: string; value: string }[]; pt: { key: string; value: string }[] } | null }>(ctx, PRODUCT_Q, { id: productId });
  const p = d.product;
  if (!p) throw new Error("product not found");
  const tr = {
    es: Object.fromEntries((d.translatableResource?.es || []).map((t) => [t.key, t.value])),
    pt: Object.fromEntries((d.translatableResource?.pt || []).map((t) => [t.key, t.value])),
  };
  let partnerHandles: string[] = [];
  try { partnerHandles = JSON.parse(p.partners?.value || "[]"); } catch { /* none */ }
  const { out, issues, rounds } = await generate(p, tr, await wmsFacts(pool, p.id), await partnerTitles(ctx, partnerHandles), await allowedAttributes(ctx));
  return { output: out, issues, rounds, photos: images(p).length };
}

/** Queue a full SEO run for one product (deduplicated against an already queued/running one). */
export async function enqueueSeoFull(
  pool: Pool,
  args: { tenantId: string; locationId: string; productId: string; matrixId?: string | null; trigger: "watch" | "manual" | "colour"; signature?: string },
): Promise<{ jobId: string; runId: string; already: boolean }> {
  const busy = await pool.query<{ id: string; job_id: string }>(
    `SELECT id::text, job_id::text FROM seo_full_runs WHERE shopify_product_id=$1 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`,
    [args.productId],
  );
  if (busy.rows[0]) return { jobId: busy.rows[0].job_id, runId: busy.rows[0].id, already: true };
  const run = await pool.query<{ id: string }>(
    `INSERT INTO seo_full_runs (tenant_id, matrix_id, shopify_product_id, signature, status, trigger)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'queued', $5) RETURNING id::text`,
    [args.tenantId, args.matrixId || null, args.productId, args.signature || "", args.trigger],
  );
  const job = await pool.query<{ id: string }>(
    `INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
     VALUES ($1::uuid, $2::uuid, $3, 'queued', $4, $5::jsonb) RETURNING id::text`,
    [args.tenantId, args.locationId, SEO_FULL_JOB, `${SEO_FULL_JOB}:${args.productId}:${Date.now()}`, JSON.stringify({ productId: args.productId, runId: run.rows[0].id, trigger: args.trigger })],
  );
  await pool.query(`UPDATE seo_full_runs SET job_id=$2::uuid WHERE id=$1::uuid`, [run.rows[0].id, job.rows[0].id]);
  return { jobId: job.rows[0].id, runId: run.rows[0].id, already: false };
}

/** Every ACTIVE product with its current signature (photos + colours). */
export async function activeSignatures(ctx: ShopCtx): Promise<{ id: string; handle: string; signature: string; photos: number; giftCard: boolean }[]> {
  const out: { id: string; handle: string; signature: string; photos: number; giftCard: boolean }[] = [];
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const r: { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { id: string; handle: string; isGiftCard: boolean; options: { name: string; optionValues: { name: string }[] }[]; media: { nodes: { id: string }[] } }[] } } =
      await gql(ctx, `query($a:String){products(first:100,after:$a,query:"status:active"){pageInfo{hasNextPage endCursor} nodes{id handle isGiftCard options{name optionValues{name}} media(first:100){nodes{id}}}}}`, { a: after });
    for (const n of r.products.nodes) {
      const cols = n.options.filter((o) => isColourOpt(o.name)).flatMap((o) => o.optionValues.map((v) => v.name));
      out.push({ id: n.id, handle: n.handle, signature: seoSignature(n.media.nodes.map((m) => m.id), cols), photos: n.media.nodes.length, giftCard: n.isGiftCard });
    }
    if (!r.products.pageInfo.hasNextPage) break;
    after = r.products.pageInfo.endCursor;
  }
  return out;
}

let lastWatch = 0;
const WATCH_MS = Math.max(5, Number(process.env.SEO_FULL_WATCH_MINUTES) || 30) * 60_000;
const PER_TICK = Math.max(1, Math.min(Number(process.env.SEO_FULL_PER_TICK) || 6, 30));

/**
 * Every 30 min: a product never run (new) or whose photos/colours changed
 * since its last run gets a full SEO run. Failed runs are not retried on the
 * same signature for 24 h. Off with SEO_FULL_WATCH=0.
 */
export async function maybeRunSeoWatch(pool: Pool): Promise<void> {
  if (process.env.SEO_FULL_WATCH === "0" || !claudeConfigured()) return;
  if (Date.now() - lastWatch < WATCH_MS) return;
  lastWatch = Date.now();
  try {
    const ctx = await resolveShopContext();
    if (!ctx) return;
    const ids = await pool.query<{ tenant_id: string; location_id: string }>(`SELECT tenant_id::text, location_id::text FROM sync_jobs WHERE location_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
    const t = ids.rows[0];
    if (!t) return;
    const live = await activeSignatures(ctx);
    /* First run ever: every product live today was done by the Nov 2026 catalog
       pass — record them as the starting point instead of redoing them. */
    const any = await pool.query(`SELECT 1 FROM seo_full_runs LIMIT 1`);
    if (!any.rowCount) {
      for (const p of live) {
        await pool.query(
          `INSERT INTO seo_full_runs (tenant_id, shopify_product_id, handle, signature, status, trigger, finished_at)
           VALUES ($1::uuid, $2, $3, $4, 'baseline', 'baseline', now())`,
          [t.tenant_id, p.id, p.handle, p.signature],
        );
      }
      await pool.query(
        `UPDATE seo_full_runs r SET matrix_id = m.id FROM matrices m WHERE r.matrix_id IS NULL AND m.shopify_product_id = r.shopify_product_id`,
      );
      console.log(`[seo-watch] recorded ${live.length} products as the starting point`);
      return;
    }
    const last = await pool.query<{ shopify_product_id: string; signature: string; status: string; created_at: Date }>(
      `SELECT DISTINCT ON (shopify_product_id) shopify_product_id, signature, status, created_at
         FROM seo_full_runs ORDER BY shopify_product_id, created_at DESC`,
    );
    const byId = new Map(last.rows.map((r) => [r.shopify_product_id, r]));
    let queued = 0;
    for (const p of live) {
      if (queued >= PER_TICK) break;
      if (p.giftCard || !p.photos) continue;
      const prev = byId.get(p.id);
      if (prev && (prev.status === "queued" || prev.status === "running")) continue;
      if (prev && prev.signature === p.signature) {
        /* Done (or recorded as the starting point) for these photos → nothing to do.
           Failed on these photos → retry once a day, not every tick. */
        if (prev.status !== "failed" || Date.now() - prev.created_at.getTime() < 86400_000) continue;
      }
      const m = await pool.query<{ id: string }>(`SELECT id::text FROM matrices WHERE shopify_product_id=$1 LIMIT 1`, [p.id]);
      await enqueueSeoFull(pool, { tenantId: t.tenant_id, locationId: t.location_id, productId: p.id, matrixId: m.rows[0]?.id ?? null, trigger: "watch", signature: p.signature });
      queued++;
    }
    if (queued) console.log(`[seo-watch] queued ${queued} full SEO run(s)`);
  } catch (e) {
    console.error("[seo-watch]", e instanceof Error ? e.message : e);
  }
}
