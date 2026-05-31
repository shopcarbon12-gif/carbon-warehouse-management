import { tokenizeCandidateText, type CollectionParserType } from "@/lib/shopifyCollectionSkuParser";

export type MappingRuleResult = {
  menuPathsToAssign: string[];
  directCollectionsToAssign: string[];
  unresolved: boolean;
  reason: string;
};

type MappingRuleInput = {
  parserType: CollectionParserType;
  routeKey: string;
  digit: string;
  title?: string;
  itemType?: string;
  sku?: string;
};

type WorkbookRuleRow = {
  routeKey: string;
  digit: string;
  category?: string;
  targetCells: string[];
  note?: string;
};

type CompiledInstruction =
  | {
      kind: "menu";
      conditionalToken: string;
      value: string;
      sourceCell: string;
    }
  | {
      kind: "collection";
      conditionalToken: string;
      value: string;
      sourceCell: string;
    }
  | {
      kind: "error";
      conditionalToken: string;
      sourceCell: string;
    };

type CompiledRuleRow = {
  routeKey: string;
  digit: string;
  category: string;
  instructions: CompiledInstruction[];
  note: string;
};

type RuleBucket = {
  exactRows: CompiledRuleRow[];
  ambiguousRows: CompiledRuleRow[];
};

type ScoredAmbiguousRow = {
  row: CompiledRuleRow;
  score: number;
  coverage: number;
};

type BucketTieBreakerKeywords = Record<string, string[]>;

const WORKBOOK_RULE_ROWS: WorkbookRuleRow[] = [
  // Route 11 (Men Summer)
  { routeKey: "11", digit: "0", targetCells: ["MEN > CLOTHING > JEANS", "JEANS > MEN", "COLLECTION: jeans-men"] },
  { routeKey: "11", digit: "1", category: "JEANS", targetCells: ["MEN > CLOTHING > JEANS", "JEANS > MEN", "COLLECTION: jeans-men"] },
  { routeKey: "11", digit: "1", category: "OVERALL", targetCells: ["MEN > CLOTHING > OVERALLS"] },
  { routeKey: "11", digit: "2", category: "TANK TOP", targetCells: ["MEN > CLOTHING > TANK TOPS"] },
  { routeKey: "11", digit: "2", category: "JACKET", targetCells: ["MEN > CLOTHING > JACKETS & COATS"] },
  { routeKey: "11", digit: "2", category: "DENIM JACKET", targetCells: ["MEN > CLOTHING > JACKETS & COATS"] },
  { routeKey: "11", digit: "3", targetCells: ["MEN > CLOTHING > SHORTS"] },
  { routeKey: "11", digit: "4", category: "T-SHIRT", targetCells: ["MEN > CLOTHING > T-SHIRTS"] },
  { routeKey: "11", digit: "4", category: "TOP", targetCells: ["MEN > CLOTHING > TOPS"] },
  // Men Summer digit 5 intentionally same as digit 4.
  {
    routeKey: "11",
    digit: "5",
    category: "T-SHIRT",
    targetCells: ["MEN > CLOTHING > T-SHIRTS"],
    note: "Intentional same mapping as Route 11 digit 4",
  },
  {
    routeKey: "11",
    digit: "5",
    category: "TOP",
    targetCells: ["MEN > CLOTHING > TOPS"],
    note: "Intentional same mapping as Route 11 digit 4",
  },
  { routeKey: "11", digit: "6", targetCells: ["MEN > ACCESSORIES & SHOES > SHOES"] },
  { routeKey: "11", digit: "7", category: "DENIM SHIRT", targetCells: ["MEN > CLOTHING > DENIM SHIRTS"] },
  { routeKey: "11", digit: "7", category: "BUTTON SHIRT", targetCells: ["MEN > CLOTHING > DRESS SHIRT"] },
  { routeKey: "11", digit: "8", category: "PANTS", targetCells: ["MEN > CLOTHING > PANTS"] },
  { routeKey: "11", digit: "8", category: "EVENING PANTS", targetCells: ["MEN > CLOTHING > PANTS"] },
  { routeKey: "11", digit: "9", category: "ACCESSORIES", targetCells: ["MEN > ACCESSORIES & SHOES > ALL ACCESSORIES"] },
  { routeKey: "11", digit: "9", category: "SWIMWEAR", targetCells: ["MEN > CLOTHING > SWIMWEAR"] },

  // Route 12 (Men Winter)
  { routeKey: "12", digit: "0", targetCells: ["MEN > CLOTHING > JEANS", "JEANS > MEN", "COLLECTION: jeans-men"] },
  { routeKey: "12", digit: "1", category: "JEANS", targetCells: ["MEN > CLOTHING > JEANS", "JEANS > MEN", "COLLECTION: jeans-men"] },
  { routeKey: "12", digit: "1", category: "OVERALL", targetCells: ["MEN > CLOTHING > OVERALLS"] },
  { routeKey: "12", digit: "2", targetCells: ["MEN > CLOTHING > SWEATSHIRTS & HOODIES"] },
  { routeKey: "12", digit: "3", category: "JACKET", targetCells: ["MEN > CLOTHING > JACKETS & COATS"] },
  { routeKey: "12", digit: "3", category: "COAT", targetCells: ["MEN > CLOTHING > JACKETS & COATS"] },
  { routeKey: "12", digit: "3", category: "VEST", targetCells: ["MEN > CLOTHING > JACKETS & COATS"] },
  { routeKey: "12", digit: "3", category: "DENIM JACKET", targetCells: ["MEN > CLOTHING > JACKETS & COATS"] },
  { routeKey: "12", digit: "4", category: "T-SHIRT", targetCells: ["MEN > CLOTHING > T-SHIRTS"] },
  { routeKey: "12", digit: "4", category: "TOP", targetCells: ["MEN > CLOTHING > TOPS"] },
  { routeKey: "12", digit: "5", targetCells: ["MEN > CLOTHING > SWEATERS"] },
  { routeKey: "12", digit: "6", targetCells: ["MEN > ACCESSORIES & SHOES > SHOES"] },
  { routeKey: "12", digit: "7", category: "DENIM SHIRT", targetCells: ["MEN > CLOTHING > DENIM SHIRTS"] },
  { routeKey: "12", digit: "7", category: "BUTTON SHIRT", targetCells: ["MEN > CLOTHING > DRESS SHIRT"] },
  // 12::8 — auto PANTS; SWEATPANTS comes from suggestion rules (base MEN > CLOTHING > PANTS).
  { routeKey: "12", digit: "8", targetCells: ["MEN > CLOTHING > PANTS"] },
  { routeKey: "12", digit: "9", targetCells: ["MEN > ACCESSORIES & SHOES > ALL ACCESSORIES"] },

  // Route 21 (Women Summer)
  { routeKey: "21", digit: "0", targetCells: ["WOMEN > CLOTHING > JEANS", "JEANS > WOMEN", "COLLECTION: clothing-jeans"] },
  { routeKey: "21", digit: "1", targetCells: ["WOMEN > CLOTHING > DRESSES"] },
  { routeKey: "21", digit: "2", category: "JACKET", targetCells: ["WOMEN > CLOTHING > JACKETS & COATS"] },
  { routeKey: "21", digit: "2", category: "VEST", targetCells: ["WOMEN > CLOTHING > JACKETS & COATS"] },
  { routeKey: "21", digit: "3", targetCells: ["WOMEN > CLOTHING > SHORTS"] },
  { routeKey: "21", digit: "4", category: "TOP", targetCells: ["WOMEN > CLOTHING > TOPS"] },
  { routeKey: "21", digit: "4", category: "TEES", targetCells: ["WOMEN > CLOTHING > T-SHIRTS"] },
  { routeKey: "21", digit: "4", category: "BLOUSE", targetCells: ["WOMEN > CLOTHING > TOPS"] },
  { routeKey: "21", digit: "5", category: "SKIRT", targetCells: ["WOMEN > CLOTHING > SKIRTS"] },
  {
    routeKey: "21",
    digit: "5",
    category: "SET",
    targetCells: ["IF SET: ERROR"],
    note: "Intentional unresolved workbook rule",
  },
  { routeKey: "21", digit: "6", targetCells: ["WOMEN > ACCESSORIES & SHOES > SHOES"] },
  { routeKey: "21", digit: "7", category: "JUMPSUIT", targetCells: ["WOMEN > CLOTHING > JUMPSUITS & ROMPERS"] },
  { routeKey: "21", digit: "7", category: "ROMPER", targetCells: ["WOMEN > CLOTHING > JUMPSUITS & ROMPERS"] },
  { routeKey: "21", digit: "7", category: "BODYSUIT", targetCells: ["WOMEN > CLOTHING > BODYSUITS"] },
  { routeKey: "21", digit: "8", category: "PANTS", targetCells: ["WOMEN > CLOTHING > PANTS & LEGGINGS"] },
  { routeKey: "21", digit: "8", category: "LEGGINGS", targetCells: ["WOMEN > CLOTHING > LEGGINGS"] },
  { routeKey: "21", digit: "9", category: "ACCESSORIES", targetCells: ["WOMEN > ACCESSORIES & SHOES > ALL ACCESSORIES"] },
  { routeKey: "21", digit: "9", category: "SWIMSUIT", targetCells: ["WOMEN > CLOTHING > SWIMWEAR"] },

  // Route 22 (Women Winter)
  { routeKey: "22", digit: "0", targetCells: ["WOMEN > CLOTHING > JEANS", "JEANS > WOMEN", "COLLECTION: clothing-jeans"] },
  { routeKey: "22", digit: "1", targetCells: ["WOMEN > CLOTHING > DRESSES"] },
  { routeKey: "22", digit: "2", category: "JACKET", targetCells: ["WOMEN > CLOTHING > JACKETS & COATS"] },
  { routeKey: "22", digit: "2", category: "COAT", targetCells: ["WOMEN > CLOTHING > JACKETS & COATS"] },
  { routeKey: "22", digit: "2", category: "VEST", targetCells: ["WOMEN > CLOTHING > JACKETS & COATS"] },
  { routeKey: "22", digit: "3", category: "HOODIE", targetCells: ["WOMEN > CLOTHING > SWEATSHIRTS & HOODIES"] },
  { routeKey: "22", digit: "3", category: "SWEATSHIRT", targetCells: ["WOMEN > CLOTHING > SWEATSHIRTS & HOODIES"] },
  { routeKey: "22", digit: "4", category: "TOP", targetCells: ["WOMEN > CLOTHING > TOPS"] },
  { routeKey: "22", digit: "4", category: "TEES", targetCells: ["WOMEN > CLOTHING > T-SHIRTS"] },
  { routeKey: "22", digit: "4", category: "BLOUSE", targetCells: ["WOMEN > CLOTHING > TOPS"] },
  { routeKey: "22", digit: "5", targetCells: ["WOMEN > CLOTHING > SKIRTS"] },
  { routeKey: "22", digit: "6", targetCells: ["WOMEN > ACCESSORIES & SHOES > SHOES"] },
  { routeKey: "22", digit: "7", category: "JUMPSUIT", targetCells: ["WOMEN > CLOTHING > JUMPSUITS & ROMPERS"] },
  { routeKey: "22", digit: "7", category: "ROMPER", targetCells: ["WOMEN > CLOTHING > JUMPSUITS & ROMPERS"] },
  { routeKey: "22", digit: "7", category: "BODYSUIT", targetCells: ["WOMEN > CLOTHING > BODYSUITS"] },
  { routeKey: "22", digit: "8", category: "PANTS", targetCells: ["WOMEN > CLOTHING > PANTS & LEGGINGS"] },
  { routeKey: "22", digit: "8", category: "LEGGINGS", targetCells: ["WOMEN > CLOTHING > LEGGINGS"] },
  { routeKey: "22", digit: "8", category: "SWEATPANTS", targetCells: ["WOMEN > CLOTHING > SWEATPANTS"] },
  { routeKey: "22", digit: "9", targetCells: ["WOMEN > ACCESSORIES & SHOES > ALL ACCESSORIES"] },
];

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeUpper(value: unknown) {
  return normalizeText(value).toUpperCase();
}

function normalizePath(value: unknown) {
  return normalizeUpper(value).replace(/\s*>\s*/g, " > ").replace(/\s+/g, " ").trim();
}

function normalizeCollectionHandle(value: unknown) {
  return normalizeText(value).toLowerCase();
}

function dedupe(values: string[]) {
  return Array.from(new Set(values.map((value) => normalizeText(value)).filter(Boolean)));
}

function splitCellTargets(cell: string) {
  const raw = normalizeText(cell);
  if (!raw) return [];
  return raw
    .split(/\r?\n|;/g)
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

function parseTargetExpression(cellValue: string): CompiledInstruction {
  const raw = normalizeText(cellValue);
  const conditionalMatch = raw.match(/^IF\s+(.+?)\s*:\s*(.+)$/i);
  const conditionToken = conditionalMatch ? normalizeUpper(conditionalMatch[1]) : "";
  const rhs = conditionalMatch ? normalizeText(conditionalMatch[2]) : raw;
  const rhsUpper = normalizeUpper(rhs);

  if (rhsUpper === "ERROR" || rhsUpper === "IF SET: ERROR") {
    return {
      kind: "error",
      conditionalToken: conditionToken,
      sourceCell: raw,
    };
  }

  const collectionMatch = rhs.match(/^COLLECTION\s*:\s*(.+)$/i);
  if (collectionMatch) {
    return {
      kind: "collection",
      conditionalToken: conditionToken,
      value: normalizeCollectionHandle(collectionMatch[1]),
      sourceCell: raw,
    };
  }

  return {
    kind: "menu",
    conditionalToken: conditionToken,
    value: normalizePath(rhs),
    sourceCell: raw,
  };
}

function compileWorkbookRows(rows: WorkbookRuleRow[]) {
  const buckets = new Map<string, RuleBucket>();

  for (const row of rows) {
    const routeKey = normalizeText(row.routeKey);
    const digit = normalizeText(row.digit);
    if (!routeKey || !digit) continue;

    const key = `${routeKey}::${digit}`;
    const existing = buckets.get(key) || { exactRows: [], ambiguousRows: [] };

    const instructions = row.targetCells.flatMap(splitCellTargets).map(parseTargetExpression);
    const compiled: CompiledRuleRow = {
      routeKey,
      digit,
      category: normalizeUpper(row.category || ""),
      instructions,
      note: normalizeText(row.note || ""),
    };

    if (compiled.category) existing.ambiguousRows.push(compiled);
    else existing.exactRows.push(compiled);

    buckets.set(key, existing);
  }

  return buckets;
}

const COMPILED_WORKBOOK_RULES = compileWorkbookRows(WORKBOOK_RULE_ROWS);

const BUCKET_TIE_BREAKER_KEYWORDS: Record<string, BucketTieBreakerKeywords> = {
  "11::7": {
    "DENIM SHIRT": ["DENIM"],
    "BUTTON SHIRT": ["BUTTON", "BUTTON-DOWN", "BUTTONDOWN"],
  },
  "12::7": {
    "DENIM SHIRT": ["DENIM"],
    "BUTTON SHIRT": ["BUTTON", "BUTTON-DOWN", "BUTTONDOWN"],
  },
  "21::4": {
    BLOUSE: ["BLOUSE"],
    TEES: ["TEE", "TEES", "T-SHIRT", "TSHIRT"],
    TOP: ["TOP", "TOPS"],
  },
  "22::4": {
    BLOUSE: ["BLOUSE"],
    TEES: ["TEE", "TEES", "T-SHIRT", "TSHIRT"],
    TOP: ["TOP", "TOPS"],
  },
  "21::7": {
    BODYSUIT: ["BODYSUIT"],
    ROMPER: ["ROMPER"],
    JUMPSUIT: ["JUMPSUIT"],
  },
  "22::7": {
    BODYSUIT: ["BODYSUIT"],
    ROMPER: ["ROMPER"],
    JUMPSUIT: ["JUMPSUIT"],
  },
  "21::8": {
    LEGGINGS: ["LEGGINGS"],
    PANTS: ["PANTS", "PANT"],
  },
  "22::8": {
    LEGGINGS: ["LEGGINGS"],
    SWEATPANTS: ["SWEATPANTS", "JOGGER", "JOGGERS"],
    PANTS: ["PANTS", "PANT"],
  },
  "11::9": {
    SWIMWEAR: ["SWIM", "SWIMWEAR", "SWIMSUIT", "BIKINI", "TRUNKS"],
    ACCESSORIES: ["ACCESSORY", "ACCESSORIES", "BELT", "BAG", "HAT", "SCARF", "SOCK", "SOCKS", "GLOVE", "GLOVES"],
  },
  "21::9": {
    SWIMSUIT: ["SWIM", "SWIMWEAR", "SWIMSUIT", "BIKINI", "TRUNKS"],
    ACCESSORIES: ["ACCESSORY", "ACCESSORIES", "BELT", "BAG", "HAT", "SCARF", "SOCK", "SOCKS", "GLOVE", "GLOVES"],
  },
};

function buildProductTokens(input: MappingRuleInput) {
  const rawTokens = [
    ...tokenizeCandidateText(input.itemType || ""),
    ...tokenizeCandidateText(input.title || ""),
    ...tokenizeCandidateText(input.sku || ""),
  ];
  const out = new Set<string>();
  for (const token of rawTokens) {
    const normalized = normalizeUpper(token);
    if (normalized) out.add(normalized);
  }
  return out;
}

function conditionMatches(conditionToken: string, productTokens: Set<string>) {
  if (!conditionToken) return true;
  const normalized = normalizeUpper(conditionToken);
  if (!normalized) return true;
  return productTokens.has(normalized);
}

function evaluateRuleRow(row: CompiledRuleRow, productTokens: Set<string>): MappingRuleResult {
  const menuPaths: string[] = [];
  const collections: string[] = [];

  for (const instruction of row.instructions) {
    if (!conditionMatches(instruction.conditionalToken, productTokens)) continue;

    if (instruction.kind === "error") {
      return {
        menuPathsToAssign: [],
        directCollectionsToAssign: [],
        unresolved: true,
        reason: `Intentional unresolved rule: ${instruction.sourceCell}`,
      };
    }

    if (instruction.kind === "menu") {
      if (instruction.value) menuPaths.push(instruction.value);
      continue;
    }

    if (instruction.kind === "collection") {
      if (instruction.value) collections.push(instruction.value);
    }
  }

  const dedupedMenuPaths = dedupe(menuPaths).map((value) => normalizePath(value));
  const dedupedCollections = dedupe(collections).map((value) => normalizeCollectionHandle(value));
  const hasOutputs = dedupedMenuPaths.length > 0 || dedupedCollections.length > 0;

  if (!hasOutputs) {
    return {
      menuPathsToAssign: [],
      directCollectionsToAssign: [],
      unresolved: true,
      reason: row.category
        ? `Ambiguous rule matched category ${row.category} but produced no applicable targets.`
        : "Rule produced no applicable targets.",
    };
  }

  return {
    menuPathsToAssign: dedupedMenuPaths,
    directCollectionsToAssign: dedupedCollections,
    unresolved: false,
    reason: row.category ? `Resolved via category ${row.category}.` : "Resolved via exact workbook row.",
  };
}

function resolveBucketSiblingTie(
  bucketKey: string,
  tiedRows: ScoredAmbiguousRow[],
  productTokens: Set<string>
) {
  const bucketRules = BUCKET_TIE_BREAKER_KEYWORDS[bucketKey];
  if (!bucketRules || tiedRows.length < 2) return null;
  const tokenSet = new Set(Array.from(productTokens).map((token) => normalizeUpper(token)));
  const byCategory = new Map(
    tiedRows.map((entry) => [normalizeUpper(entry.row.category), entry.row] as const)
  );
  const scoredByCategory = Object.entries(bucketRules)
    .map(([category, keywords]) => {
      const normalizedCategory = normalizeUpper(category);
      if (!byCategory.has(normalizedCategory)) return null;
      const hitCount = new Set(
        keywords.map((keyword) => normalizeUpper(keyword)).filter((keyword) => tokenSet.has(keyword))
      ).size;
      return {
        category: normalizedCategory,
        hitCount,
      };
    })
    .filter((entry): entry is { category: string; hitCount: number } => Boolean(entry));
  if (scoredByCategory.length < 1) return null;
  const maxHits = Math.max(...scoredByCategory.map((entry) => entry.hitCount));
  if (maxHits < 1) return null;
  const winners = scoredByCategory.filter((entry) => entry.hitCount === maxHits);
  if (winners.length !== 1) return null;
  return byCategory.get(winners[0].category) || null;
}

function pickAmbiguousRow(rows: CompiledRuleRow[], productTokens: Set<string>, bucketKey: string) {
  const scored = rows
    .map((row) => {
      const categoryTokens = tokenizeCandidateText(row.category).map((token) => normalizeUpper(token));
      const matches = categoryTokens.filter((token) => productTokens.has(token));
      const coverage = categoryTokens.length > 0 ? matches.length / categoryTokens.length : 0;
      return {
        row,
        score: matches.length,
        coverage,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.coverage !== left.coverage) return right.coverage - left.coverage;
      return 0;
    });

  if (scored.length < 1) {
    return {
      row: null as CompiledRuleRow | null,
      reason: "Ambiguous workbook rows exist, but no candidate category matched product tokens.",
    };
  }

  if (scored.length > 1 && scored[0].score === scored[1].score) {
    if (scored[0].coverage > scored[1].coverage) {
      return {
        row: scored[0].row,
        reason: "",
      };
    }
    if (scored[0].coverage === scored[1].coverage) {
      const topTiedRows = scored.filter(
        (entry) => entry.score === scored[0].score && entry.coverage === scored[0].coverage
      );
      const siblingWinner = resolveBucketSiblingTie(bucketKey, topTiedRows, productTokens);
      if (siblingWinner) {
        return {
          row: siblingWinner,
          reason: "",
        };
      }
    }
    return {
      row: null as CompiledRuleRow | null,
      reason: "Ambiguous workbook rows matched multiple candidate categories with equal score.",
    };
  }

  return {
    row: scored[0].row,
    reason: "",
  };
}

export function resolveCollectionMappingRules(input: MappingRuleInput): MappingRuleResult {
  const routeKey = normalizeText(input.routeKey);
  const digit = normalizeText(input.digit);

  if (!routeKey || !digit) {
    return {
      menuPathsToAssign: [],
      directCollectionsToAssign: [],
      unresolved: true,
      reason: "Missing route key or digit.",
    };
  }

  const bucket = COMPILED_WORKBOOK_RULES.get(`${routeKey}::${digit}`);
  if (!bucket) {
    return {
      menuPathsToAssign: [],
      directCollectionsToAssign: [],
      unresolved: true,
      reason: `No workbook rule row found for routeKey=${routeKey}, digit=${digit}.`,
    };
  }

  const productTokens = buildProductTokens(input);

  if (bucket.exactRows.length > 0) {
    const mergedMenu: string[] = [];
    const mergedCollections: string[] = [];
    for (const row of bucket.exactRows) {
      const result = evaluateRuleRow(row, productTokens);
      if (result.unresolved) return result;
      mergedMenu.push(...result.menuPathsToAssign);
      mergedCollections.push(...result.directCollectionsToAssign);
    }
    return {
      menuPathsToAssign: dedupe(mergedMenu).map((value) => normalizePath(value)),
      directCollectionsToAssign: dedupe(mergedCollections).map((value) => normalizeCollectionHandle(value)),
      unresolved: false,
      reason: "Resolved via exact workbook row(s).",
    };
  }

  if (bucket.ambiguousRows.length > 0) {
    const picked = pickAmbiguousRow(bucket.ambiguousRows, productTokens, `${routeKey}::${digit}`);
    if (!picked.row) {
      return {
        menuPathsToAssign: [],
        directCollectionsToAssign: [],
        unresolved: true,
        reason: picked.reason,
      };
    }
    return evaluateRuleRow(picked.row, productTokens);
  }

  return {
    menuPathsToAssign: [],
    directCollectionsToAssign: [],
    unresolved: true,
    reason: `Workbook bucket routeKey=${routeKey}, digit=${digit} has no usable rows.`,
  };
}
