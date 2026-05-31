import { normalizeCandidateText, normalizeMenuPath } from "@/lib/shopifyCollectionSkuParser";

export type CollectionPathConflictFlag = {
  id: string;
  ruleId: string;
  /** Normalized menu path that is likely wrong or redundant */
  path: string;
  message: string;
};

function combinedProductText(input: { title?: string; itemType?: string; sku?: string }) {
  return [input.title, input.itemType, input.sku].filter(Boolean).join(" ");
}

function pathSegments(normalizedPath: string) {
  return normalizedPath.split(" > ").map((p) => p.trim()).filter(Boolean);
}

function pathHasSegment(normalizedPath: string, segmentUpper: string) {
  return pathSegments(normalizedPath).some((seg) => seg === segmentUpper);
}

function isGenericAllAccessoriesPath(normalizedPath: string) {
  return (
    normalizedPath === "MEN > ACCESSORIES & SHOES > ALL ACCESSORIES" ||
    normalizedPath === "WOMEN > ACCESSORIES & SHOES > ALL ACCESSORIES"
  );
}

function assignedHasSunglassesSubtype(paths: string[]) {
  return paths.some((p) => normalizeMenuPath(p).includes("SUNGLASSES"));
}

function textSuggestsHoodieOrSweatshirt(text: string) {
  const n = normalizeCandidateText(text);
  if (!n) return false;
  return /\b(hoodie|hoodies|sweatshirt|sweatshirts|crewneck|pullover)\b/.test(n);
}

function textSuggestsSunglasses(text: string) {
  const n = normalizeCandidateText(text);
  if (!n) return false;
  return n.includes("sunglass") || /\bsun\s*glasses\b/.test(n);
}

/**
 * High-confidence contradictions between product signals and assigned menu paths.
 * Does not mutate Shopify data — surface-only for review.
 */
export function detectCollectionPathConflicts(input: {
  title?: string;
  itemType?: string;
  sku?: string;
  assignedMenuPaths: string[];
}): CollectionPathConflictFlag[] {
  const out: CollectionPathConflictFlag[] = [];
  const text = combinedProductText(input);
  if (!String(text || "").trim()) return out;

  const normalizedPaths = (input.assignedMenuPaths || []).map((p) => normalizeMenuPath(p)).filter(Boolean);
  if (normalizedPaths.length < 1) return out;

  const seen = new Set<string>();

  if (textSuggestsHoodieOrSweatshirt(text)) {
    for (const path of normalizedPaths) {
      if (!pathHasSegment(path, "JACKETS & COATS")) continue;
      const key = `hoodie-vs-jackets::${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `conflict-${key}`,
        ruleId: "signal-hoodie-in-jackets-coats",
        path,
        message:
          "Title/type suggests hoodie or sweatshirt, but this row includes JACKETS & COATS. Consider SWEATSHIRTS & HOODIES or remove the jacket path if it is wrong.",
      });
    }
  }

  if (textSuggestsSunglasses(text) && !assignedHasSunglassesSubtype(normalizedPaths)) {
    for (const path of normalizedPaths) {
      if (!isGenericAllAccessoriesPath(path)) continue;
      const key = `sunglasses-generic::${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `conflict-${key}`,
        ruleId: "signal-sunglasses-only-generic-accessories",
        path,
        message:
          "Product looks like sunglasses; using only ALL ACCESSORIES may be too generic. Consider adding the SUNGLASSES subtype path (or replacing the generic bucket).",
      });
    }
  }

  return out;
}
