/**
 * "Complete the Look" — the buyer-facing notice appended to the description of
 * any product flagged as one piece of a matching set.
 *
 * The wording is fixed rather than generated. It states how the cart actually
 * behaves — the partner piece is added automatically, size and colour cannot be
 * mixed, each piece is priced on its own — and a model paraphrasing that would
 * eventually get a detail wrong and mislead a shopper into expecting one price
 * or a mixed-size pairing. Only the surrounding marketing copy is written by
 * the model.
 *
 * Bolding is deliberately limited to the four facts that cause a complaint when
 * missed. Emphasising the whole block would emphasise nothing.
 */

/** Wrapper class doubles as the marker used to find and replace the block. */
export const SET_NOTICE_CLASS = "carbon-set-note";

export const SET_NOTICE_HTML = [
  `<div class="${SET_NOTICE_CLASS}">`,
  "<h3>Complete the Look</h3>",
  "<p>This item is part of a matching set and is <strong>sold together with its coordinating piece(s)</strong>. ",
  "Choose your size and color, and the matching piece(s) in the same size and color ",
  "<strong>will be added to your cart automatically</strong>.</p>",
  "<p><strong>Size and color selections apply to the full set, so pieces cannot be mixed or matched.</strong> ",
  "Each piece is <strong>individually priced</strong>.</p>",
  "</div>",
].join("");

/**
 * Remove any previously appended notice.
 *
 * Runs before every append so re-optimizing a product cannot stack the block up
 * twice, and so unticking "Set" actually takes it off the next time the product
 * is optimized. Matches the wrapper div by class and tolerates attribute order
 * and whitespace changes made by Shopify's HTML sanitiser.
 */
export function stripSetNotice(html: string): string {
  const s = String(html || "");
  if (!s) return "";
  const re = new RegExp(
    `\\s*<div[^>]*class\\s*=\\s*["'][^"']*\\b${SET_NOTICE_CLASS}\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/div>\\s*`,
    "gi",
  );
  return s.replace(re, "").trim();
}

/** Does this HTML already carry the notice? */
export function hasSetNotice(html: string): boolean {
  return new RegExp(`\\b${SET_NOTICE_CLASS}\\b`).test(String(html || ""));
}

/**
 * The description a product should end up with: the model's copy, then the
 * notice when the product is part of a set and nothing when it is not.
 */
export function applySetNotice(html: string, isSet: boolean): string {
  const base = stripSetNotice(html);
  if (!isSet) return base;
  return base ? `${base}${SET_NOTICE_HTML}` : SET_NOTICE_HTML;
}
