import { SHOPCARBON_SUGGESTION_RULE_ROWS } from "@/lib/shopcarbonSuggestionRulesData";
import { normalizeMenuPath, tokenizeCandidateText } from "@/lib/shopifyCollectionSkuParser";

export type SuggestionInput = {
  autoMappedPaths?: string[];
  /**
   * When barcode auto-map assigns only direct collections (no menu paths), match suggestion rules
   * against these normalized tree paths (e.g. current Shopify menu assignments).
   */
  matchingFallbackPaths?: string[];
  /** Retained for API compatibility; positive suggestions are not filtered server-side (UI disables duplicates). */
  alreadyAssignedPaths?: string[];
  alreadyAssignedDirectCollections?: string[];
  title?: string;
  itemType?: string;
  sku?: string;
};

type CompiledSuggestionRule = {
  id: string;
  basePaths: string[];
  menuPaths: string[];
  directCollections: string[];
  requiresAnyTokens: string[];
};

export type CollectionSuggestionsResult = {
  menuPaths: string[];
  directCollections: string[];
};

function dedupePaths(values: string[]) {
  return Array.from(new Set(values.map((value) => normalizeMenuPath(value)).filter(Boolean)));
}

function normalizeToken(value: string) {
  return String(value || "").trim().toLowerCase();
}

function dedupeTokens(values: string[]) {
  return Array.from(new Set(values.map((value) => normalizeToken(value)).filter(Boolean)));
}

function normalizeCollectionHandle(value: string) {
  return String(value || "").trim().toLowerCase();
}

function dedupeCollectionHandles(values: string[]) {
  return Array.from(new Set(values.map((value) => normalizeCollectionHandle(value)).filter(Boolean)));
}

/** Preserve first-seen order; normalize keys for dedupe. */
function stableDedupeMenuPathsInOrder(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const normalized = normalizeMenuPath(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function stableDedupeHandlesInOrder(handles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of handles) {
    const h = normalizeCollectionHandle(raw);
    if (!h || seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  return out;
}

const COMPILED_SUGGESTION_RULES: CompiledSuggestionRule[] = SHOPCARBON_SUGGESTION_RULE_ROWS.map((row) => ({
  id: row.id,
  basePaths: dedupePaths(row.basePaths),
  menuPaths: stableDedupeMenuPathsInOrder(row.menuPaths),
  directCollections: stableDedupeHandlesInOrder(row.directCollections || []),
  requiresAnyTokens: [],
}));

/**
 * Positive suggestions from the ShopCarbon ruleset (`shopcarbonSuggestionRulesData.ts`, synced from xlsx).
 * Match on full normalized auto-mapped base paths; emit menu paths and direct collection handles (stable order, deduped).
 * Items already assigned are still returned — the UI may mark overlap (Current / Auto / etc.) but keeps chips clickable.
 */
export function buildCollectionSuggestions(input: SuggestionInput): CollectionSuggestionsResult {
  const fromAuto = dedupePaths(input.autoMappedPaths || []);
  const fromFallback = dedupePaths(input.matchingFallbackPaths || []);
  /** Prefer real auto-mapped menu paths; if none, use current menu paths (direct-only barcode targets). */
  const basesForMatching = fromAuto.length > 0 ? fromAuto : fromFallback;
  const autoMappedPathSet = new Set(basesForMatching);
  if (autoMappedPathSet.size < 1) {
    return { menuPaths: [], directCollections: [] };
  }
  const tokenSet = new Set(
    dedupeTokens([
      ...tokenizeCandidateText(input.title || ""),
      ...tokenizeCandidateText(input.itemType || ""),
      ...tokenizeCandidateText(input.sku || ""),
    ])
  );
  const orderedMenuPaths: string[] = [];
  const orderedDirectCollections: string[] = [];

  for (const rule of COMPILED_SUGGESTION_RULES) {
    if (!rule.basePaths.some((path) => autoMappedPathSet.has(path))) continue;
    if (rule.requiresAnyTokens.length > 0 && !rule.requiresAnyTokens.some((token) => tokenSet.has(token))) continue;
    for (const path of rule.menuPaths) {
      const normalizedPath = normalizeMenuPath(path);
      if (!normalizedPath) continue;
      orderedMenuPaths.push(normalizedPath);
    }
    for (const handle of rule.directCollections) {
      const normalizedHandle = normalizeCollectionHandle(handle);
      if (!normalizedHandle) continue;
      orderedDirectCollections.push(normalizedHandle);
    }
  }

  return {
    menuPaths: stableDedupeMenuPathsInOrder(orderedMenuPaths),
    directCollections: dedupeCollectionHandles(stableDedupeHandlesInOrder(orderedDirectCollections)),
  };
}
