/**
 * Carbon bin codes follow `<aisle digits><section letter><shelf 2-digit><position L|C|R>`.
 * Example: `1A05L` = aisle 1, section A, shelf 05, position LEFT.
 *
 * Anything that doesn't match (RECEIVING-01, FLOOR-A, legacy codes) is "unmapped"
 * and surfaces in a separate panel on the Shelf Map tab so it remains reachable.
 */
export const BIN_CODE_RE = /^(\d+)([A-Z])(\d{2})([LCR])$/;

export type BinCodeParts = {
  aisle: string;
  section: string;
  shelf: string;
  position: "L" | "C" | "R";
};

export function parseBinCode(code: string): BinCodeParts | null {
  const m = BIN_CODE_RE.exec(code.toUpperCase());
  if (!m) return null;
  return {
    aisle: m[1]!,
    section: m[2]!,
    shelf: m[3]!,
    position: m[4] as "L" | "C" | "R",
  };
}

/** Postgres POSIX regex for "every bin in this aisle+section". */
export function sectionRegex(aisle: string, section: string): string {
  return `^${aisle}${section}[0-9]{2}[LCR]$`;
}

/**
 * Project-wide rule: a catalog row's (matrix UPC + color) is encoded into
 * the SKU prefix:
 *   - C-prefixed SKUs: LEFT(sku, 11)
 *   - everything else: LEFT(sku, 9)
 * Used by the shelf-map and catalog Move flows to identify the
 * (UPC, color) group to sweep across sizes.
 */
export function computeSkuPrefix(sku: string): string {
  const s = sku.trim();
  if (s.startsWith("C")) return s.slice(0, 11);
  return s.slice(0, 9);
}
