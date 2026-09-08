/**
 * Wearing order for size values.
 *
 * Sizes are stored as free text and arrive in whatever order they were created,
 * which is usually SKU or alphabetical order — so a size list reads "L, M, S,
 * XL" instead of "S, M, L, XL". Anywhere sizes are shown to a person, they
 * should read the way a person expects.
 *
 *   XXS  XS  XS/S  S  S/M  M  M/L  L  L/XL  XL  XXL  XXXL  4XL
 *   then numeric sizes ascending: 4 6 8 10 … 28 29 30 … 36 38 40 …
 *
 * Letters sort before numbers, though in practice a product uses one or the
 * other. "OS" (one size) sorts first since it is always alone.
 *
 * An unrecognised value keeps its existing relative position at the end rather
 * than being moved somewhere arbitrary — a value we do not understand is a
 * reason to leave it where it is, not to guess at its place.
 */

const LETTER: Record<string, number> = {
  OS: 1,
  "ONE SIZE": 1,
  XXS: 10,
  XS: 20,
  "XS/S": 25,
  S: 30,
  "S/M": 35,
  M: 40,
  "M/L": 45,
  L: 50,
  "L/XL": 55,
  XL: 60,
  XXL: 70,
  "2XL": 70,
  XXXL: 80,
  "3XL": 80,
  "4XL": 90,
  XXXXL: 90,
};

/** Values we cannot place go last, in the order they arrived. */
export const SIZE_UNRANKED = 1e6;

export function sizeRank(value: string | null | undefined): number {
  const k = String(value ?? "").trim().toUpperCase();
  if (!k) return SIZE_UNRANKED;
  if (k in LETTER) return LETTER[k];
  /* Offset so every number sorts after every letter. */
  if (/^\d+(\.\d+)?$/.test(k)) return 1000 + parseFloat(k);
  return SIZE_UNRANKED;
}

/**
 * Sort size strings into wearing order.
 *
 * Stable, so equal ranks — "4" and "04", or two values we cannot place — keep
 * the order they came in rather than being shuffled arbitrarily.
 */
export function sortSizes<T>(items: T[], getSize: (item: T) => string): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => sizeRank(getSize(a.item)) - sizeRank(getSize(b.item)) || a.i - b.i)
    .map((x) => x.item);
}
