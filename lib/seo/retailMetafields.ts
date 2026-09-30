/**
 * The four retail metafields the SEO pass fills alongside title/description.
 *
 * These are the fields the Matrix → SEO tab shows under "Metafields · custom +
 * Google feed". Until now only that per-product panel wrote them, so the bulk
 * SEO run left them empty: every active product had an SEO title, but fewer
 * than a third had these. This module holds the shared meaning so the panel,
 * the bulk pass and the backfill cannot drift apart.
 *
 *   custom.short_descriptions_   → the product. Rendered as the PDP's
 *                                  "Description" tab (templates/product.context.us.json),
 *                                  so an empty one is a blank tab on the storefront.
 *   mm-google-shopping.gender    → every variant. Google Shopping reads these
 *   mm-google-shopping.age_group   per variant, not per product, which is why
 *   mm-google-shopping.condition   they are written to each one.
 */

export interface RetailMetafieldValues {
  fullDescription?: string;
  gender?: string;
  ageGroup?: string;
  condition?: string;
}

export interface MetafieldSetInput {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

/** Matches app/api/shopify/metafields/route.ts so reload and push agree. */
export const RETAIL_METAFIELDS = [
  { field: "fullDescription", namespace: "custom", key: "short_descriptions_", type: "multi_line_text_field" },
  { field: "gender", namespace: "mm-google-shopping", key: "gender", type: "single_line_text_field" },
  { field: "ageGroup", namespace: "mm-google-shopping", key: "age_group", type: "single_line_text_field" },
  { field: "condition", namespace: "mm-google-shopping", key: "condition", type: "single_line_text_field" },
] as const;

export const GENDERS = ["male", "female", "unisex"] as const;
export const AGE_GROUPS = ["adult", "kids", "toddler", "infant", "newborn"] as const;
export const CONDITIONS = ["new", "used", "refurbished"] as const;

/**
 * Gender from the product type.
 *
 * Carbon's types are written "WOMEN >> TOPS", "MEN >> SHORTS", so the gender is
 * already stated for 387 of the 396 products that need backfilling. Reading it
 * here is both free and exact, and leaves a photo model to be asked only about
 * the handful of types that genuinely do not say ("JEANS", "DRESS", "GENERAL").
 *
 * Returns null when the type does not state it — the caller decides whether to
 * ask a model or leave the field alone. It never guesses.
 */
export function genderFromProductType(productType: string): "male" | "female" | "unisex" | null {
  const head = String(productType || "")
    .split(">>")[0]
    .trim()
    .toUpperCase();
  if (!head) return null;
  if (/^(WOMEN|WOMENS|WOMAN|LADIES|GIRL|GIRLS)\b/.test(head)) return "female";
  if (/^(MEN|MENS|MAN|BOY|BOYS)\b/.test(head)) return "male";
  if (/^(UNISEX|ALL)\b/.test(head)) return "unisex";
  return null;
}

/** Everything Carbon sells is adult and new; there is no kids or resale line. */
export const DEFAULT_AGE_GROUP = "adult";
export const DEFAULT_CONDITION = "new";

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

/** Keeps a model's answer inside the vocabulary Google accepts. */
export function pickAllowed(value: unknown, allowed: readonly string[], fallback = ""): string {
  const s = clean(value).toLowerCase();
  return allowed.includes(s) ? s : fallback;
}

/**
 * Turn values into metafieldsSet inputs.
 *
 * The three Google fields go to every variant, the description to the product.
 * Empty values are skipped rather than written blank — a blank metafield reads
 * to a feed as "declared and empty", which is worse than absent.
 */
export function buildRetailMetafieldInputs(args: {
  productId: string;
  variantIds: string[];
  values: RetailMetafieldValues;
}): MetafieldSetInput[] {
  const { productId, variantIds, values } = args;
  const out: MetafieldSetInput[] = [];

  const desc = clean(values.fullDescription);
  if (desc && productId) {
    out.push({
      ownerId: productId,
      namespace: "custom",
      key: "short_descriptions_",
      type: "multi_line_text_field",
      value: desc,
    });
  }

  const perVariant: Array<[string, string]> = [
    ["gender", clean(values.gender)],
    ["age_group", clean(values.ageGroup)],
    ["condition", clean(values.condition)],
  ];
  for (const [key, value] of perVariant) {
    if (!value) continue;
    for (const vid of variantIds) {
      if (!vid) continue;
      out.push({
        ownerId: vid,
        namespace: "mm-google-shopping",
        key,
        type: "single_line_text_field",
        value,
      });
    }
  }
  return out;
}

/**
 * Which of the four a product is still missing.
 *
 * `present` is what Shopify already holds. A product counts as done only when
 * all three Google fields are on the variants as well as the description on the
 * product, because a half-filled product is exactly what the feed complains
 * about.
 */
export function missingRetailFields(present: {
  fullDescription?: boolean;
  gender?: boolean;
  ageGroup?: boolean;
  condition?: boolean;
}): string[] {
  const out: string[] = [];
  if (!present.fullDescription) out.push("fullDescription");
  if (!present.gender) out.push("gender");
  if (!present.ageGroup) out.push("ageGroup");
  if (!present.condition) out.push("condition");
  return out;
}

/** The instruction the photo model answers. Shared so the panel and the bulk
 *  pass describe a product the same way. */
export function buildDescriptionInstruction(args: {
  title: string;
  productType?: string;
  askGender: boolean;
}): string {
  const { title, productType, askGender } = args;
  const shape = askGender
    ? `{"fullDescription": string, "gender": "male" | "female" | "unisex"}`
    : `{"fullDescription": string}`;
  return [
    `Product name: "${title}"${productType ? `, category: ${productType}` : ""}.`,
    "From the photo and the name, return STRICT JSON only:",
    shape,
    "fullDescription: 2-3 sentences of plain-text marketing copy describing the",
    "garment that is actually visible — its cut, fabric feel, neckline or leg, and",
    "when someone would wear it. No HTML, no bullet points, no size or care claims,",
    "no price, and never invent a material you cannot see.",
    askGender
      ? "gender: who the garment is cut for, judged from its styling."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
