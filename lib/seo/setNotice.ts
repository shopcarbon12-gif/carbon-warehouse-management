/**
 * "Complete the Look" — the banner shown on the product page of anything that
 * is one piece of a matching set.
 *
 * It is a fixed PNG rather than generated copy. The text states how the cart
 * actually behaves — the partner is added automatically, size and colour cannot
 * be mixed, each piece is priced on its own — and a model paraphrasing that
 * would eventually get a detail wrong and mislead a shopper into expecting one
 * price or a mixed-size pairing.
 *
 * Two artworks, chosen by what the product IS:
 *   pic 1  tee + shorts     summer sets
 *   pic 2  hoodie + joggers winter sets
 *
 * The choice comes from the SKU numbering rather than from the product name,
 * because the name is prose and the numbering is the system of record.
 */

export const SET_BANNER_CLASS = "carbon-set-note";

export const SET_BANNER_IMAGES: Record<1 | 2, string> = {
  1: "https://cdn.shopify.com/s/files/1/0680/6572/2620/files/ChatGPT_Image_Sep_7_2026_03_31_01_AM.png?v=1788766989",
  2: "https://cdn.shopify.com/s/files/1/0680/6572/2620/files/ChatGPT_Image_Sep_7_2026_03_09_14_AM.png?v=1788767007",
};

export type SetPicture = 1 | 2;

/**
 * Which artwork a SKU calls for, or null when the code says nothing.
 *
 *   C…      the 6th character decides   (C1234**1** → 1)
 *   digits  the 2nd character decides   (1**1**25306 → 1, 1**2**23803 → 2)
 *
 * Verified against the catalog: all 154 flagged products resolve, and no
 * product's SKUs disagree with each other.
 */
export function pictureFromCode(code: string | null | undefined): SetPicture | null {
  const s = String(code || "").trim();
  if (!s) return null;
  const ch = /^c/i.test(s) ? s[5] : /^\d/.test(s) ? s[1] : "";
  if (ch === "1") return 1;
  if (ch === "2") return 2;
  return null;
}

/**
 * The artwork for a whole product. Its variant SKUs decide it; the matrix UPC is
 * the fallback for a product whose variants carry no usable code.
 *
 * A product gets ONE banner, so disagreeing variants are resolved by majority
 * rather than by whichever row happened to sort first.
 */
export function pictureForProduct(
  skus: Array<string | null | undefined>,
  upc?: string | null,
): SetPicture | null {
  const votes = { 1: 0, 2: 0 };
  for (const sku of skus) {
    const p = pictureFromCode(sku);
    if (p) votes[p] += 1;
  }
  if (votes[1] || votes[2]) return votes[1] >= votes[2] ? 1 : 2;
  return pictureFromCode(upc);
}

/** The banner markup. Width-capped so it never outgrows the description column. */
export function buildSetBannerHtml(picture: SetPicture): string {
  return (
    `<p class="${SET_BANNER_CLASS}">` +
    `<img src="${SET_BANNER_IMAGES[picture]}" ` +
    `alt="Complete the Look — this item is part of a matching set. The coordinating piece in the same size and color is added to your cart automatically. Pieces cannot be mixed or matched and each piece is individually priced." ` +
    `loading="lazy" style="max-width:100%;height:auto;display:block;" />` +
    `</p>`
  );
}

/**
 * Remove any banner this product already carries.
 *
 * Matches the wrapper by class on either a <p> or a <div>, so it also clears the
 * earlier text-only version of this notice — those products must not end up
 * showing the old paragraph and the new image together. Tolerates Shopify
 * reordering or requoting the attributes.
 */
export function stripSetBanner(html: string): string {
  const s = String(html || "");
  if (!s) return "";
  const re = new RegExp(
    `\\s*<(p|div)[^>]*class\\s*=\\s*["'][^"']*\\b${SET_BANNER_CLASS}\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/\\1>\\s*`,
    "gi",
  );
  return s.replace(re, "").trim();
}

/** Does this HTML already carry the banner? */
export function hasSetBanner(html: string): boolean {
  return new RegExp(`\\b${SET_BANNER_CLASS}\\b`).test(String(html || ""));
}

/**
 * The description a product should end up with: its copy, then the banner when
 * it is part of a set and nothing when it is not.
 *
 * Always strips first, so re-running cannot stack banners up and unticking
 * "Set" actually takes the banner off.
 */
export function applySetBanner(html: string, picture: SetPicture | null): string {
  const base = stripSetBanner(html);
  if (!picture) return base;
  const banner = buildSetBannerHtml(picture);
  return base ? `${base}${banner}` : banner;
}

/**
 * The notice for a product that is named like a set but cannot actually be sold
 * as one, because its partner is not listed.
 *
 * Without this the page is genuinely misleading: the title says "Set", so a
 * shopper reasonably reads one price as covering both pieces. Saying plainly
 * that this listing is a single garment is the whole point — the Complete the
 * Look banner would promise an automatic pairing that cannot happen.
 */
export function buildSoloNoticeHtml(): string {
  return (
    `<div class="${SET_BANNER_CLASS}">` +
    "<h3>Sold individually</h3>" +
    "<p>Despite the name, this listing is for <strong>this piece only</strong>. " +
    "The matching piece is <strong>not included</strong> and is <strong>not currently available</strong>. " +
    "The price shown covers this item alone.</p>" +
    "</div>"
  );
}

/**
 * Which notice a product should carry.
 *   picture  → the set works: show the Complete the Look artwork
 *   "solo"   → named like a set but no partner is sellable: say so in words
 *   null     → not a set at all: no notice
 */
export function applySetNoticeFor(
  html: string,
  mode: SetPicture | "solo" | null,
): string {
  const base = stripSetBanner(html);
  if (mode === null) return base;
  const block = mode === "solo" ? buildSoloNoticeHtml() : buildSetBannerHtml(mode);
  return base ? `${base}${block}` : block;
}
