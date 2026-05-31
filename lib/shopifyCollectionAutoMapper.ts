import { detectCollectionPathConflicts, type CollectionPathConflictFlag } from "@/lib/shopifyCollectionMappingConflicts";
import { resolveCollectionMappingRules } from "@/lib/shopifyCollectionMappingRules";
import { parseSkuRouteInfo } from "@/lib/shopifyCollectionSkuParser";
import { buildCollectionSuggestions } from "@/lib/shopifyCollectionSuggestions";

export type MappingDecision = "AUTO_MAPPED" | "SUGGESTED" | "MANUAL_REVIEW";
export type AutoMapFailureCode =
  | "PARSE_FAILED"
  | "UNKNOWN_PARSER"
  | "MISSING_ROUTE_KEY"
  | "INVALID_CATEGORY_DIGIT"
  | "NO_RULE_MATCH"
  | "LOW_CONFIDENCE_FALLBACK"
  | "LEGACY_REVIEW_REQUIRED"
  | "PRESERVED_EXISTING_ASSIGNMENT"
  | "MULTIPLE_MATCHES";

export type CollectionAutoMapInput = {
  sku: string;
  upc: string;
  title: string;
  itemType: string;
  assignedMenuPaths: string[];
};

export type CollectionAutoMapResult = {
  parserType: "NEW" | "LEGACY" | "UNKNOWN";
  routeKey: string;
  digit: string;
  normalizedCode: string;
  barcodeLabel: string;
  mappingDecision: MappingDecision;
  reviewReason: string;
  autoMappedPaths: string[];
  directCollectionsToAssign: string[];
  suggestedPaths: string[];
  suggestedDirectCollections: string[];
  autoMapSucceeded: boolean;
  autoMapFailureCode: AutoMapFailureCode | "";
  autoMapFailureReason: string;
  autoMapFailureDetails: string[];
  reviewReasons: string[];
  collectionConflictFlags: CollectionPathConflictFlag[];
};

function dedupe(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function mapRuleReasonToFailureCode(reason: string): AutoMapFailureCode {
  const normalized = String(reason || "").toLowerCase();
  if (normalized.includes("missing route key") || (normalized.includes("missing") && normalized.includes("digit"))) {
    return "MISSING_ROUTE_KEY";
  }
  if (normalized.includes("equal score") || normalized.includes("multiple candidate")) {
    return "MULTIPLE_MATCHES";
  }
  if (normalized.includes("no candidate category matched")) {
    return "LOW_CONFIDENCE_FALLBACK";
  }
  if (normalized.includes("no workbook rule row") || normalized.includes("no usable rows")) {
    return "NO_RULE_MATCH";
  }
  if (normalized.includes("intentional unresolved rule")) {
    return "NO_RULE_MATCH";
  }
  if (normalized.includes("produced no applicable targets")) {
    return "NO_RULE_MATCH";
  }
  return "NO_RULE_MATCH";
}

function toHumanFailureReason(code: AutoMapFailureCode, contextReason: string) {
  if (code === "PARSE_FAILED") {
    return "We could not read this product code in a way that supports automatic mapping.";
  }
  if (code === "UNKNOWN_PARSER") {
    return "We could not determine which parser format this product code uses.";
  }
  if (code === "MISSING_ROUTE_KEY") {
    return "We could not determine the route and category parts needed for mapping.";
  }
  if (code === "INVALID_CATEGORY_DIGIT") {
    return "The category digit in the code is missing or invalid for mapping rules.";
  }
  if (code === "LOW_CONFIDENCE_FALLBACK") {
    return "We found possible matches, but not with enough confidence to auto-map.";
  }
  if (code === "LEGACY_REVIEW_REQUIRED") {
    return "This item uses an older code format and needs manual review.";
  }
  if (code === "PRESERVED_EXISTING_ASSIGNMENT") {
    return "We kept the current Shopify assignments, but no confirmed auto-map was produced.";
  }
  if (code === "MULTIPLE_MATCHES") {
    return "Multiple possible category matches were found, so manual review is required.";
  }
  if (contextReason) {
    return "No exact mapping rule matched this product.";
  }
  return "No exact mapping rule matched this product.";
}

export function computeCollectionAutoMap(input: CollectionAutoMapInput): CollectionAutoMapResult {
  const parsed = parseSkuRouteInfo({
    sku: input.sku,
    upc: input.upc,
    title: input.title,
    itemType: input.itemType,
  });
  const ruleResult = resolveCollectionMappingRules({
    parserType: parsed.parserType,
    routeKey: parsed.routeKey,
    digit: parsed.digit,
    title: input.title,
    itemType: input.itemType,
    sku: input.sku,
  });
  const autoMappedPaths = dedupe(ruleResult.menuPathsToAssign);
  const directCollectionsToAssign = dedupe(ruleResult.directCollectionsToAssign);
  const autoMapResolved = !ruleResult.unresolved && (autoMappedPaths.length > 0 || directCollectionsToAssign.length > 0);

  const collectionConflictFlags = detectCollectionPathConflicts({
    title: input.title,
    itemType: input.itemType,
    sku: input.sku,
    assignedMenuPaths: input.assignedMenuPaths,
  });

  const suggestions = autoMapResolved
    ? buildCollectionSuggestions({
        autoMappedPaths,
        matchingFallbackPaths: input.assignedMenuPaths,
        alreadyAssignedPaths: [...input.assignedMenuPaths, ...autoMappedPaths],
        alreadyAssignedDirectCollections: directCollectionsToAssign,
        title: input.title,
        itemType: input.itemType,
        sku: input.sku,
      })
    : { menuPaths: [], directCollections: [] };
  const suggestedPaths = suggestions.menuPaths;
  const suggestedDirectCollections = suggestions.directCollections;

  let mappingDecision: MappingDecision = "MANUAL_REVIEW";
  let reviewReason = ruleResult.reason;
  // Subtype / follow-on suggestions must win over pure AUTO_MAPPED so rows stay in review until approved.
  if (suggestedPaths.length > 0 || suggestedDirectCollections.length > 0) {
    mappingDecision = "SUGGESTED";
    if (!reviewReason) reviewReason = "Suggestion candidates available.";
  } else if (!ruleResult.unresolved && (autoMappedPaths.length > 0 || directCollectionsToAssign.length > 0)) {
    mappingDecision = "AUTO_MAPPED";
  } else if (!reviewReason) {
    reviewReason = "No auto-map or suggestions matched.";
  }

  const autoMapSucceeded = mappingDecision === "AUTO_MAPPED";
  let autoMapFailureCode: AutoMapFailureCode | "" = "";
  const autoMapFailureDetails: string[] = [];
  if (!autoMapSucceeded) {
    const compactSku = String(input.sku || "").trim().toUpperCase();
    // Order matters. The SKU parser resets parserType to "UNKNOWN" whenever
    // routeKey/digit are empty, so gating MISSING_ROUTE_KEY/INVALID_CATEGORY_DIGIT
    // behind `parserType !== "UNKNOWN"` made them unreachable — those rows were
    // mislabeled PARSE_FAILED/UNKNOWN_PARSER. Check the specific empties first.
    if (!compactSku) {
      autoMapFailureCode = "PARSE_FAILED";
    } else if (compactSku.startsWith("C")) {
      autoMapFailureCode = "LEGACY_REVIEW_REQUIRED";
    } else if (!parsed.routeKey) {
      autoMapFailureCode = "MISSING_ROUTE_KEY";
    } else if (!parsed.digit) {
      autoMapFailureCode = "INVALID_CATEGORY_DIGIT";
    } else if (parsed.parserType === "UNKNOWN") {
      autoMapFailureCode =
        compactSku.startsWith("1") || compactSku.startsWith("2") ? "PARSE_FAILED" : "UNKNOWN_PARSER";
    } else {
      autoMapFailureCode = mapRuleReasonToFailureCode(ruleResult.reason);
    }
    if (ruleResult.reason) autoMapFailureDetails.push(ruleResult.reason);
    if (suggestedPaths.length > 0 || suggestedDirectCollections.length > 0) {
      autoMapFailureDetails.push("Suggestion candidates were produced for manual confirmation.");
    }
    if ((input.assignedMenuPaths || []).length > 0) {
      autoMapFailureDetails.push("Existing Shopify assignments were preserved while awaiting confirmation.");
      if (!autoMapFailureCode) autoMapFailureCode = "PRESERVED_EXISTING_ASSIGNMENT";
    }
  }
  const autoMapFailureReason = autoMapFailureCode ? toHumanFailureReason(autoMapFailureCode, ruleResult.reason) : "";
  const reviewReasons = dedupe([reviewReason, autoMapFailureReason, ...autoMapFailureDetails]);

  return {
    parserType: parsed.parserType,
    routeKey: parsed.routeKey,
    digit: parsed.digit,
    normalizedCode: parsed.normalizedCode,
    barcodeLabel: parsed.barcodeLabel,
    mappingDecision,
    reviewReason,
    autoMappedPaths,
    directCollectionsToAssign,
    suggestedPaths,
    suggestedDirectCollections,
    autoMapSucceeded,
    autoMapFailureCode,
    autoMapFailureReason,
    autoMapFailureDetails,
    reviewReasons,
    collectionConflictFlags,
  };
}
