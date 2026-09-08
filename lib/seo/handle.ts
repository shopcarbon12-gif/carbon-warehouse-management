/**
 * URL handles, derived from the product name.
 *
 * The handle is the part of the URL a person can read, and the one part of the
 * listing that should never drift from what the product is called. A handle
 * left over from an older name ("gifted-product" for the Gift Card) tells a
 * search engine and a shopper two different things.
 *
 * The rule is the product name, lowercased, with a hyphen between each word.
 * Nothing is invented and nothing is abbreviated — this is not a field a model
 * should be writing, because the correct answer is already known.
 */

/** Lowercase, ASCII, words joined by single hyphens. */
export function slugifyHandle(title: string): string {
  return String(title || "")
    /* Decompose accents so "Café" becomes "cafe" rather than losing the vowel. */
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    /* & reads as a word in a URL, where the bare symbol would be escaped. */
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Is the current handle already the right one?
 *
 * A trailing "-2" counts as correct. Shopify appends that itself when the clean
 * handle is taken by another product, so treating it as wrong would rename the
 * product on every run, collide again, get another suffix, and leave a trail of
 * redirects behind it — churn that never converges.
 */
export function isHandleGood(current: string, title: string): boolean {
  const want = slugifyHandle(title);
  if (!want) return true; /* No name to derive from — leave the handle alone. */
  const have = String(current || "").trim().toLowerCase();
  if (have === want) return true;
  return new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`).test(have);
}

/**
 * The handle to publish, or null when the current one is already correct.
 *
 * Returning null rather than the same string keeps the caller from issuing a
 * pointless write and, more importantly, from creating a redirect from a handle
 * to itself.
 */
export function desiredHandle(current: string, title: string): string | null {
  if (isHandleGood(current, title)) return null;
  const want = slugifyHandle(title);
  return want || null;
}
