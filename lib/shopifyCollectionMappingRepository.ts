import { randomUUID } from "node:crypto";
import { ensureSqlReady, hasSqlDatabaseConfigured, sqlQuery } from "@/lib/sqlDb";
import { normalizeShopDomain } from "@/lib/shopify";

export type CollectionOption = {
  id: string;
  title: string;
  handle: string;
  productsCount: number | null;
  /** Smart/automated collections are not reliably manually assignable. */
  isAutomated?: boolean;
};

export type MenuNodeRecord = {
  nodeKey: string;
  label: string;
  parentKey: string | null;
  depth: number;
  sortOrder: number;
  enabled: boolean;
  collectionId: string | null;
  collectionTitle: string | null;
  collectionHandle: string | null;
  defaultCollectionHandle: string | null;
  updatedAt: string | null;
};

type MenuNodeSeed = {
  key: string;
  label: string;
  parentKey: string | null;
  depth: number;
  sortOrder: number;
  defaultCollectionHandle?: string;
  defaultUrl?: string;
};

type PersistedNodeRow = {
  node_key: string;
  label: string;
  parent_key: string | null;
  depth: number;
  sort_order: number;
  enabled: boolean;
  collection_id: string | null;
  collection_title: string | null;
  collection_handle: string | null;
  default_collection_handle: string | null;
  updated_at: string | null;
};

type ToggleAuditInput = {
  shop: string;
  productId: string;
  productTitle: string;
  nodeKey: string;
  checked: boolean;
  addedCollectionIds: string[];
  removedCollectionIds: string[];
  status: "ok" | "error";
  errorMessage?: string;
};

export type LiveMenuNodeInput = {
  nodeKey: string;
  label: string;
  parentKey: string | null;
  depth: number;
  sortOrder: number;
  collectionIdHint?: string | null;
  defaultCollectionHandle?: string | null;
};

type MappingAuditInput = {
  shop: string;
  action: string;
  summary: string;
  status: "ok" | "error";
  details?: Record<string, unknown> | null;
  errorMessage?: string;
};

export type MappingAuditLogRow = {
  id: string;
  action: string;
  summary: string;
  status: "ok" | "error";
  details: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: string;
};

export type ProductActionStatus = "PROCESSED" | "";

type PersistedMappingAuditRow = {
  id: string;
  action: string;
  summary: string;
  status: string;
  details: unknown;
  error_message: string | null;
  created_at: string;
};

const DEFAULT_SHOP_KEY = "__default_shop__";

const DEFAULT_MENU_NODES: MenuNodeSeed[] = [
  { key: "men", label: "MEN", parentKey: null, depth: 0, sortOrder: 1, defaultCollectionHandle: "men" },
  { key: "men/new-and-now", label: "NEW & NOW", parentKey: "men", depth: 1, sortOrder: 1, defaultCollectionHandle: "men-new-now" },
  { key: "men/new-and-now/new-arrivals", label: "NEW ARRIVALS", parentKey: "men/new-and-now", depth: 2, sortOrder: 1, defaultCollectionHandle: "new-arrivals" },
  { key: "men/new-and-now/limited-edition", label: "LIMITED EDITION", parentKey: "men/new-and-now", depth: 2, sortOrder: 2, defaultCollectionHandle: "limited-edition-men" },
  { key: "men/new-and-now/summer-sets", label: "SUMMER SETS", parentKey: "men/new-and-now", depth: 2, sortOrder: 3, defaultCollectionHandle: "summer-sets-men" },
  { key: "men/new-and-now/winter-sets", label: "WINTER SETS", parentKey: "men/new-and-now", depth: 2, sortOrder: 4, defaultCollectionHandle: "winter-sets" },
  { key: "men/clothing", label: "CLOTHING", parentKey: "men", depth: 1, sortOrder: 2, defaultCollectionHandle: "men-clothing" },
  { key: "men/clothing/shirts", label: "SHIRTS", parentKey: "men/clothing", depth: 2, sortOrder: 1, defaultCollectionHandle: "shirts" },
  { key: "men/clothing/tops", label: "TOPS", parentKey: "men/clothing", depth: 2, sortOrder: 2, defaultCollectionHandle: "tops-men" },
  { key: "men/clothing/jeans", label: "JEANS", parentKey: "men/clothing", depth: 2, sortOrder: 3, defaultUrl: "/pages/men-jeans-cuts-1" },
  { key: "men/clothing/sweatshirts-and-hoodies", label: "SWEATSHIRTS & HOODIES", parentKey: "men/clothing", depth: 2, sortOrder: 4, defaultCollectionHandle: "matching-sets" },
  { key: "men/clothing/jackets-and-coats", label: "JACKETS & COATS", parentKey: "men/clothing", depth: 2, sortOrder: 5, defaultCollectionHandle: "jackets-coats" },
  { key: "men/clothing/tracksuits", label: "TRACKSUITS", parentKey: "men/clothing", depth: 2, sortOrder: 6, defaultCollectionHandle: "tracksuits-1" },
  { key: "men/clothing/pants", label: "PANTS", parentKey: "men/clothing", depth: 2, sortOrder: 7, defaultCollectionHandle: "pants" },
  { key: "men/clothing/overalls", label: "OVERALLS", parentKey: "men/clothing", depth: 2, sortOrder: 8, defaultCollectionHandle: "overalls" },
  { key: "men/clothing/polos", label: "POLOS", parentKey: "men/clothing", depth: 2, sortOrder: 9, defaultCollectionHandle: "polos" },
  { key: "men/clothing/t-shirts", label: "T-SHIRTS", parentKey: "men/clothing", depth: 2, sortOrder: 10, defaultCollectionHandle: "t-shirts" },
  { key: "men/clothing/shorts", label: "SHORTS", parentKey: "men/clothing", depth: 2, sortOrder: 11, defaultCollectionHandle: "shorts-1" },
  { key: "men/clothing/swimwear", label: "SWIMWEAR", parentKey: "men/clothing", depth: 2, sortOrder: 12, defaultCollectionHandle: "swimwear-1" },
  { key: "men/clothing/sweatpants", label: "SWEATPANTS", parentKey: "men/clothing", depth: 2, sortOrder: 13, defaultCollectionHandle: "sweatpants-men" },
  { key: "men/clothing/sweaters", label: "SWEATERS", parentKey: "men/clothing", depth: 2, sortOrder: 14, defaultCollectionHandle: "sweaters-men" },
  { key: "men/clothing/tank-tops", label: "TANK TOPS", parentKey: "men/clothing", depth: 2, sortOrder: 15, defaultCollectionHandle: "tank-tops-men" },
  { key: "men/accessories-and-shoes", label: "ACCESSORIES & SHOES", parentKey: "men", depth: 1, sortOrder: 3, defaultCollectionHandle: "men-accessories-shoes" },
  { key: "men/accessories-and-shoes/shoes", label: "SHOES", parentKey: "men/accessories-and-shoes", depth: 2, sortOrder: 1, defaultCollectionHandle: "shoes" },
  { key: "men/accessories-and-shoes/socks-and-underwear", label: "SOCKS & UNDERWEAR", parentKey: "men/accessories-and-shoes", depth: 2, sortOrder: 2, defaultCollectionHandle: "socks-underwear" },
  { key: "men/accessories-and-shoes/ties", label: "TIES", parentKey: "men/accessories-and-shoes", depth: 2, sortOrder: 3, defaultCollectionHandle: "ties" },
  { key: "men/accessories-and-shoes/jewelry", label: "JEWELRY", parentKey: "men/accessories-and-shoes", depth: 2, sortOrder: 4, defaultCollectionHandle: "jewelry" },
  { key: "men/accessories-and-shoes/sunglasses", label: "SUNGLASSES", parentKey: "men/accessories-and-shoes", depth: 2, sortOrder: 5, defaultCollectionHandle: "sunglasses" },
  { key: "men/accessories-and-shoes/fragrance-and-beauty", label: "FRAGRANCE & BEAUTY", parentKey: "men/accessories-and-shoes", depth: 2, sortOrder: 6, defaultCollectionHandle: "fragrance-beauty" },
  { key: "men/accessories-and-shoes/all-accessories", label: "ALL ACCESSORIES", parentKey: "men/accessories-and-shoes", depth: 2, sortOrder: 7, defaultCollectionHandle: "all-accessories" },
  { key: "men/accessories-and-shoes/hats", label: "HATS", parentKey: "men/accessories-and-shoes", depth: 2, sortOrder: 8, defaultCollectionHandle: "hats-men" },
  { key: "men/accessories-and-shoes/belts", label: "BELTS", parentKey: "men/accessories-and-shoes", depth: 2, sortOrder: 9, defaultCollectionHandle: "belts" },
  { key: "men/shirt-shop", label: "SHIRT SHOP", parentKey: "men", depth: 1, sortOrder: 4, defaultCollectionHandle: "men-shirt-shop" },
  { key: "men/shirt-shop/graphic-t-shirts", label: "GRAPHIC T-SHIRTS", parentKey: "men/shirt-shop", depth: 2, sortOrder: 1, defaultCollectionHandle: "short-sleeve-shirts" },
  { key: "men/shirt-shop/dress-shirt", label: "DRESS SHIRT", parentKey: "men/shirt-shop", depth: 2, sortOrder: 2, defaultCollectionHandle: "dress-shirt" },
  { key: "men/shirt-shop/linen-shirts", label: "LINEN SHIRTS", parentKey: "men/shirt-shop", depth: 2, sortOrder: 3, defaultCollectionHandle: "linen-shirts" },
  { key: "men/shirt-shop/denim-shirts", label: "DENIM SHIRTS", parentKey: "men/shirt-shop", depth: 2, sortOrder: 4, defaultCollectionHandle: "denim-shirts" },
  { key: "women", label: "WOMEN", parentKey: null, depth: 0, sortOrder: 2, defaultCollectionHandle: "women" },
  { key: "women/new-and-now", label: "NEW & NOW", parentKey: "women", depth: 1, sortOrder: 1, defaultCollectionHandle: "women-new-now" },
  { key: "women/new-and-now/new-arrivals", label: "NEW ARRIVALS", parentKey: "women/new-and-now", depth: 2, sortOrder: 1, defaultCollectionHandle: "new-arrivals-women" },
  { key: "women/new-and-now/limited-edition", label: "LIMITED EDITION", parentKey: "women/new-and-now", depth: 2, sortOrder: 2, defaultCollectionHandle: "limited-edition" },
  { key: "women/new-and-now/summer-sets", label: "SUMMER SETS", parentKey: "women/new-and-now", depth: 2, sortOrder: 3, defaultCollectionHandle: "summer-sets" },
  { key: "women/new-and-now/winter-sets", label: "WINTER SETS", parentKey: "women/new-and-now", depth: 2, sortOrder: 4, defaultCollectionHandle: "winter-sets-women" },
  { key: "women/clothing", label: "CLOTHING", parentKey: "women", depth: 1, sortOrder: 2, defaultCollectionHandle: "clothing-1" },
  { key: "women/clothing/matching-sets", label: "MATCHING SETS", parentKey: "women/clothing", depth: 2, sortOrder: 1, defaultCollectionHandle: "matching-sets-1" },
  { key: "women/clothing/dresses", label: "DRESSES", parentKey: "women/clothing", depth: 2, sortOrder: 2, defaultCollectionHandle: "dresses" },
  { key: "women/clothing/jeans", label: "JEANS", parentKey: "women/clothing", depth: 2, sortOrder: 3, defaultUrl: "/pages/women-jeans-cuts" },
  { key: "women/clothing/shorts", label: "SHORTS", parentKey: "women/clothing", depth: 2, sortOrder: 4, defaultCollectionHandle: "shorts" },
  { key: "women/clothing/skirts", label: "SKIRTS", parentKey: "women/clothing", depth: 2, sortOrder: 5, defaultCollectionHandle: "skirts" },
  { key: "women/clothing/tops", label: "TOPS", parentKey: "women/clothing", depth: 2, sortOrder: 6, defaultCollectionHandle: "tops" },
  { key: "women/clothing/tank-tops", label: "TANK TOPS", parentKey: "women/clothing", depth: 2, sortOrder: 7, defaultCollectionHandle: "tank-tops" },
  { key: "women/clothing/t-shirts", label: "T-SHIRTS", parentKey: "women/clothing", depth: 2, sortOrder: 8, defaultCollectionHandle: "t-shirts-women" },
  { key: "women/clothing/jumpsuits-and-rompers", label: "JUMPSUITS & ROMPERS", parentKey: "women/clothing", depth: 2, sortOrder: 9, defaultCollectionHandle: "jumpsuits-rompers" },
  { key: "women/clothing/jackets-and-coats", label: "JACKETS & COATS", parentKey: "women/clothing", depth: 2, sortOrder: 10, defaultCollectionHandle: "jackets-coats-2" },
  { key: "women/clothing/bodysuits", label: "BODYSUITS", parentKey: "women/clothing", depth: 2, sortOrder: 11, defaultCollectionHandle: "bodysuits" },
  { key: "women/clothing/tracksuits", label: "TRACKSUITS", parentKey: "women/clothing", depth: 2, sortOrder: 12, defaultCollectionHandle: "tracksuits" },
  { key: "women/clothing/sweatpants", label: "SWEATPANTS", parentKey: "women/clothing", depth: 2, sortOrder: 13, defaultCollectionHandle: "sweatpants" },
  { key: "women/clothing/pants-and-leggings", label: "PANTS & LEGGINGS", parentKey: "women/clothing", depth: 2, sortOrder: 14, defaultCollectionHandle: "pants-women" },
  { key: "women/clothing/sweatshirts-and-hoodies", label: "SWEATSHIRTS & HOODIES", parentKey: "women/clothing", depth: 2, sortOrder: 15, defaultCollectionHandle: "sweatshirts-hoodies-women" },
  { key: "women/clothing/swimwear", label: "SWIMWEAR", parentKey: "women/clothing", depth: 2, sortOrder: 16, defaultCollectionHandle: "swimsuit-women" },
  { key: "women/clothing/sweaters", label: "SWEATERS", parentKey: "women/clothing", depth: 2, sortOrder: 17, defaultCollectionHandle: "sweaters-women" },
  { key: "women/accessories-and-shoes", label: "ACCESSORIES & SHOES", parentKey: "women", depth: 1, sortOrder: 3, defaultCollectionHandle: "accessories-shoes-women" },
  { key: "women/accessories-and-shoes/jewelry", label: "JEWELRY", parentKey: "women/accessories-and-shoes", depth: 2, sortOrder: 1, defaultCollectionHandle: "jewelry-women" },
  { key: "women/accessories-and-shoes/sunglasses", label: "SUNGLASSES", parentKey: "women/accessories-and-shoes", depth: 2, sortOrder: 2, defaultCollectionHandle: "sunglasses-women" },
  { key: "women/accessories-and-shoes/belts", label: "BELTS", parentKey: "women/accessories-and-shoes", depth: 2, sortOrder: 3, defaultCollectionHandle: "women-belts" },
  { key: "women/accessories-and-shoes/hats", label: "HATS", parentKey: "women/accessories-and-shoes", depth: 2, sortOrder: 4, defaultCollectionHandle: "hats" },
  { key: "women/accessories-and-shoes/shoes", label: "SHOES", parentKey: "women/accessories-and-shoes", depth: 2, sortOrder: 5, defaultCollectionHandle: "shoes-women" },
  { key: "women/accessories-and-shoes/fragrance-and-beauty", label: "FRAGRANCE & BEAUTY", parentKey: "women/accessories-and-shoes", depth: 2, sortOrder: 6, defaultCollectionHandle: "fragrance-beauty-women" },
  { key: "women/accessories-and-shoes/all-accessories", label: "ALL ACCESSORIES", parentKey: "women/accessories-and-shoes", depth: 2, sortOrder: 7, defaultCollectionHandle: "all-accessories-women" },
  { key: "jeans", label: "JEANS", parentKey: null, depth: 0, sortOrder: 3, defaultUrl: "/pages/jeans" },
  { key: "jeans/men", label: "MEN", parentKey: "jeans", depth: 1, sortOrder: 1, defaultUrl: "/pages/men-jeans-cuts-1" },
  { key: "jeans/men/skinny-jeans", label: "SKINNY JEANS", parentKey: "jeans/men", depth: 2, sortOrder: 1, defaultCollectionHandle: "skinny-jeans" },
  { key: "jeans/men/super-skinny-jeans", label: "SUPER SKINNY JEANS", parentKey: "jeans/men", depth: 2, sortOrder: 2, defaultCollectionHandle: "super-skinny-jeans-men" },
  { key: "jeans/men/baggy", label: "BAGGY", parentKey: "jeans/men", depth: 2, sortOrder: 3, defaultCollectionHandle: "baggy-men" },
  { key: "jeans/men/slim-jeans", label: "SLIM JEANS", parentKey: "jeans/men", depth: 2, sortOrder: 4, defaultCollectionHandle: "slim-jeans-men" },
  { key: "jeans/women", label: "WOMEN", parentKey: "jeans", depth: 1, sortOrder: 2, defaultUrl: "/pages/women-jeans-cuts" },
  { key: "jeans/women/skinny-jeans", label: "SKINNY JEANS", parentKey: "jeans/women", depth: 2, sortOrder: 1, defaultCollectionHandle: "skinny-jeans-women" },
  { key: "jeans/women/relaxed-jeans", label: "RELAXED JEANS", parentKey: "jeans/women", depth: 2, sortOrder: 2, defaultCollectionHandle: "relaxed-women" },
  { key: "jeans/women/flare-and-wide-leg-jeans", label: "FLARE & WIDE LEG JEANS", parentKey: "jeans/women", depth: 2, sortOrder: 3, defaultCollectionHandle: "jeans-women" },
  { key: "rewards", label: "REWARDS", parentKey: null, depth: 0, sortOrder: 4, defaultUrl: "/pages/rewards" },
  { key: "become-affiliate", label: "BECOME AFFILIATE", parentKey: null, depth: 0, sortOrder: 5, defaultUrl: "/pages/become-affiliate" },
];

const memoryNodesByShop = new Map<string, MenuNodeRecord[]>();
const memoryAuditLogsByShop = new Map<string, MappingAuditLogRow[]>();
const memoryRowReviewByShop = new Map<string, Map<string, boolean>>();
const memoryRowDraftByShop = new Map<string, Map<string, RowDraftState>>();
let sqlTablesEnsured = false;
const MAPPING_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const ROW_DRAFT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAPPING_AUDIT_LIMIT_MAX = 1000;
const TRIM_AUDIT_LOGS_INTERVAL_MS = 60 * 60 * 1000;
const trimAuditLogsLastRunByShop = new Map<string, number>();
const TRIM_ROW_DRAFTS_INTERVAL_MS = 10 * 60 * 1000;
const trimRowDraftsLastRunByShop = new Map<string, number>();

export type RowDraftState = {
  isReviewed: boolean;
  appCommitted?: boolean;
  appCommittedAt?: string;
  holdFromSync?: boolean;
  selectedSuggestionPaths: string[];
  selectedSuggestionCollections: string[];
  manualAddedPaths: string[];
  manualRemovedPaths: string[];
  mappingDecision?: "AUTO_MAPPED" | "SUGGESTED" | "MANUAL_REVIEW";
  collectionSyncStatus?: "REVIEW" | "REMOVAL_PENDING" | "ADD_PENDING" | "SYNCED";
  finalMenuPaths?: string[];
  finalDirectCollections?: string[];
  currentMatchesFinal?: boolean;
  updatedAt?: string;
};

type PersistedRowDraftRow = {
  row_id: string;
  draft_data: unknown;
  updated_at: string;
};

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeLower(value: unknown) {
  return normalizeText(value).toLowerCase();
}

function normalizeShopKey(shop: string) {
  return normalizeShopDomain(normalizeText(shop)) || DEFAULT_SHOP_KEY;
}

const DRAFT_ROW_SCOPE_DELIMITER = "::";
const DEFAULT_DRAFT_ACTOR_KEY = "anon:sessionless";

function normalizeDraftActorKey(value: unknown) {
  const raw = normalizeLower(value);
  if (!raw) return DEFAULT_DRAFT_ACTOR_KEY;
  return raw.replaceAll(DRAFT_ROW_SCOPE_DELIMITER, ":");
}

function toScopedDraftRowId(actorKey: string, rowId: string) {
  return `${normalizeDraftActorKey(actorKey)}${DRAFT_ROW_SCOPE_DELIMITER}${normalizeText(rowId)}`;
}

function fromScopedDraftRowId(scopedRowId: string, actorKey: string) {
  const scoped = normalizeText(scopedRowId);
  const prefix = `${normalizeDraftActorKey(actorKey)}${DRAFT_ROW_SCOPE_DELIMITER}`;
  if (!scoped.startsWith(prefix)) return "";
  return normalizeText(scoped.slice(prefix.length));
}

function toInt(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(normalizeText(value), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toBool(value: unknown, fallback = true) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeLower(value);
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function cloneNode(node: MenuNodeRecord): MenuNodeRecord {
  return {
    ...node,
    parentKey: node.parentKey || null,
    collectionId: node.collectionId || null,
    collectionTitle: node.collectionTitle || null,
    collectionHandle: node.collectionHandle || null,
    defaultCollectionHandle: node.defaultCollectionHandle || null,
    updatedAt: node.updatedAt || null,
  };
}

function sortNodes(rows: MenuNodeRecord[]) {
  return [...rows].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.nodeKey.localeCompare(b.nodeKey);
  });
}

function toCollectionMaps(collections: CollectionOption[]) {
  const byHandle = new Map<string, CollectionOption>();
  const byId = new Map<string, CollectionOption>();
  for (const row of collections) {
    const id = normalizeText(row.id);
    const handle = normalizeLower(row.handle);
    if (id) byId.set(id, row);
    if (handle) byHandle.set(handle, row);
  }
  return { byHandle, byId };
}

function buildSeededNodes(collections: CollectionOption[]): MenuNodeRecord[] {
  const { byHandle } = toCollectionMaps(collections);
  const nowIso = new Date().toISOString();
  return DEFAULT_MENU_NODES.map((seed) => {
    const matched = seed.defaultCollectionHandle
      ? byHandle.get(normalizeLower(seed.defaultCollectionHandle))
      : undefined;

    return {
      nodeKey: seed.key,
      label: seed.label,
      parentKey: seed.parentKey,
      depth: seed.depth,
      sortOrder: seed.sortOrder,
      enabled: true,
      collectionId: matched?.id || null,
      collectionTitle: matched?.title || null,
      collectionHandle: matched?.handle || null,
      defaultCollectionHandle: seed.defaultCollectionHandle || null,
      updatedAt: nowIso,
    };
  });
}

function parsePersistedNode(row: PersistedNodeRow): MenuNodeRecord {
  return {
    nodeKey: normalizeText(row.node_key),
    label: normalizeText(row.label),
    parentKey: normalizeText(row.parent_key) || null,
    depth: Math.max(0, toInt(row.depth)),
    sortOrder: toInt(row.sort_order),
    enabled: toBool(row.enabled, true),
    collectionId: normalizeText(row.collection_id) || null,
    collectionTitle: normalizeText(row.collection_title) || null,
    collectionHandle: normalizeText(row.collection_handle) || null,
    defaultCollectionHandle: normalizeText(row.default_collection_handle) || null,
    updatedAt: normalizeText(row.updated_at) || null,
  };
}

function normalizeDetails(details: unknown): Record<string, unknown> {
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return details as Record<string, unknown>;
  }
  return {};
}

function normalizeTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => normalizeText(entry))
        .filter(Boolean)
    )
  );
}

function normalizeRowDraftState(value: unknown): RowDraftState {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const mappingDecisionRaw = normalizeText(raw.mappingDecision);
  const collectionSyncStatusRaw = normalizeText(raw.collectionSyncStatus);
  const mappingDecision =
    mappingDecisionRaw === "AUTO_MAPPED" || mappingDecisionRaw === "SUGGESTED" || mappingDecisionRaw === "MANUAL_REVIEW"
      ? mappingDecisionRaw
      : undefined;
  const collectionSyncStatus =
    collectionSyncStatusRaw === "REVIEW" ||
    collectionSyncStatusRaw === "REMOVAL_PENDING" ||
    collectionSyncStatusRaw === "ADD_PENDING" ||
    collectionSyncStatusRaw === "SYNCED"
      ? collectionSyncStatusRaw
      : undefined;
  return {
    isReviewed: Boolean(raw.isReviewed),
    appCommitted: Boolean(raw.appCommitted),
    appCommittedAt: normalizeText(raw.appCommittedAt) || undefined,
    holdFromSync: Boolean(raw.holdFromSync),
    selectedSuggestionPaths: normalizeTextArray(raw.selectedSuggestionPaths),
    selectedSuggestionCollections: normalizeTextArray(raw.selectedSuggestionCollections),
    manualAddedPaths: normalizeTextArray(raw.manualAddedPaths),
    manualRemovedPaths: normalizeTextArray(raw.manualRemovedPaths),
    mappingDecision,
    collectionSyncStatus,
    finalMenuPaths: normalizeTextArray(raw.finalMenuPaths),
    finalDirectCollections: normalizeTextArray(raw.finalDirectCollections),
    currentMatchesFinal: typeof raw.currentMatchesFinal === "boolean" ? raw.currentMatchesFinal : undefined,
  };
}

function parsePersistedMappingAuditRow(row: PersistedMappingAuditRow): MappingAuditLogRow {
  return {
    id: normalizeText(row.id) || randomUUID(),
    action: normalizeText(row.action) || "unknown",
    summary: normalizeText(row.summary),
    status: normalizeLower(row.status) === "error" ? "error" : "ok",
    details: normalizeDetails(row.details),
    errorMessage: normalizeText(row.error_message) || null,
    createdAt: normalizeText(row.created_at) || new Date().toISOString(),
  };
}

function clampAuditLimit(limit: number) {
  if (!Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(MAPPING_AUDIT_LIMIT_MAX, Math.floor(limit)));
}

function pruneMemoryAuditLogs(shopKey: string) {
  const existing = memoryAuditLogsByShop.get(shopKey) || [];
  const threshold = Date.now() - MAPPING_AUDIT_RETENTION_MS;
  const next = existing.filter((row) => {
    const ts = Date.parse(row.createdAt);
    return Number.isFinite(ts) && ts >= threshold;
  });
  memoryAuditLogsByShop.set(shopKey, next);
  return next;
}

function getMemoryNodes(shop: string, collections: CollectionOption[]): MenuNodeRecord[] {
  const shopKey = normalizeShopKey(shop);
  const existing = memoryNodesByShop.get(shopKey);
  if (!existing || existing.length < 1) {
    const seeded = buildSeededNodes(collections);
    memoryNodesByShop.set(shopKey, seeded.map(cloneNode));
    return sortNodes(seeded);
  }

  const byKey = new Map(existing.map((row) => [row.nodeKey, row]));
  const seeded = buildSeededNodes(collections);
  for (const seed of seeded) {
    const current = byKey.get(seed.nodeKey);
    if (!current) {
      existing.push(cloneNode(seed));
      byKey.set(seed.nodeKey, existing[existing.length - 1]);
      continue;
    }
    current.label = seed.label;
    current.parentKey = seed.parentKey;
    current.depth = seed.depth;
    current.sortOrder = seed.sortOrder;
    current.defaultCollectionHandle = seed.defaultCollectionHandle;
  }

  memoryNodesByShop.set(shopKey, sortNodes(existing).map(cloneNode));
  return sortNodes(existing);
}

async function ensureSqlTables() {
  if (sqlTablesEnsured) return;
  await ensureSqlReady();
  await sqlQuery(`
    CREATE TABLE IF NOT EXISTS shopify_collection_menu_nodes (
      shop TEXT NOT NULL,
      node_key TEXT NOT NULL,
      label TEXT NOT NULL,
      parent_key TEXT,
      depth INT NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT true,
      collection_id TEXT,
      collection_title TEXT,
      collection_handle TEXT,
      default_collection_handle TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (shop, node_key)
    )
  `);

  await sqlQuery(`
    CREATE TABLE IF NOT EXISTS shopify_collection_mapping_actions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      shop TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_title TEXT,
      node_key TEXT NOT NULL,
      checked BOOLEAN NOT NULL,
      added_collection_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      removed_collection_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'ok',
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await sqlQuery(`
    CREATE TABLE IF NOT EXISTS shopify_collection_mapping_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      shop TEXT NOT NULL,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await sqlQuery(`
    CREATE TABLE IF NOT EXISTS shopify_collection_mapping_row_reviews (
      shop TEXT NOT NULL,
      row_id TEXT NOT NULL,
      is_reviewed BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (shop, row_id)
    )
  `);

  await sqlQuery(`
    CREATE TABLE IF NOT EXISTS shopify_collection_mapping_row_drafts (
      shop TEXT NOT NULL,
      row_id TEXT NOT NULL,
      draft_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (shop, row_id)
    )
  `);

  await sqlQuery(`
    CREATE INDEX IF NOT EXISTS idx_shopify_collection_menu_nodes_shop_sort
      ON shopify_collection_menu_nodes (shop, sort_order, node_key)
  `);

  await sqlQuery(`
    CREATE INDEX IF NOT EXISTS idx_shopify_collection_mapping_actions_shop_created
      ON shopify_collection_mapping_actions (shop, created_at DESC)
  `);

  await sqlQuery(`
    CREATE INDEX IF NOT EXISTS idx_shopify_collection_mapping_audit_shop_created
      ON shopify_collection_mapping_audit (shop, created_at DESC)
  `);

  await sqlQuery(`
    CREATE INDEX IF NOT EXISTS idx_shopify_collection_mapping_row_reviews_shop_updated
      ON shopify_collection_mapping_row_reviews (shop, updated_at DESC)
  `);

  await sqlQuery(`
    CREATE INDEX IF NOT EXISTS idx_shopify_collection_mapping_row_drafts_shop_updated
      ON shopify_collection_mapping_row_drafts (shop, updated_at DESC)
  `);

  sqlTablesEnsured = true;
}

async function canUseSql() {
  if (!hasSqlDatabaseConfigured()) return false;
  try {
    await ensureSqlTables();
    return true;
  } catch {
    return false;
  }
}

async function listSqlNodes(shop: string): Promise<MenuNodeRecord[]> {
  const shopKey = normalizeShopKey(shop);
  const rows = await sqlQuery<PersistedNodeRow>(
    `SELECT node_key, label, parent_key, depth, sort_order, enabled,
            collection_id, collection_title, collection_handle,
            default_collection_handle, updated_at
     FROM shopify_collection_menu_nodes
     WHERE shop = $1
     ORDER BY sort_order ASC, node_key ASC`,
    [shopKey]
  );
  return rows.map(parsePersistedNode);
}

async function seedSqlNodesIfMissing(shop: string, collections: CollectionOption[]) {
  const shopKey = normalizeShopKey(shop);
  const existing = await listSqlNodes(shopKey);
  // If any regular (non-local4) rows already exist, do not inject seed rows again.
  // Re-seeding on top of Shopify gid-based keys creates duplicate tree entries.
  const hasRegularRows = existing.some((row) => !String(row.nodeKey || "").startsWith("local4:"));
  if (hasRegularRows) return;
  const existingKeys = new Set(existing.map((row) => row.nodeKey));
  const seeded = buildSeededNodes(collections);

  for (const row of seeded) {
    if (existingKeys.has(row.nodeKey)) continue;
    await sqlQuery(
      `INSERT INTO shopify_collection_menu_nodes (
        shop, node_key, label, parent_key, depth, sort_order,
        enabled, collection_id, collection_title, collection_handle,
        default_collection_handle, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, now()
      )
      ON CONFLICT (shop, node_key) DO UPDATE
        SET label = EXCLUDED.label,
            parent_key = EXCLUDED.parent_key,
            depth = EXCLUDED.depth,
            sort_order = EXCLUDED.sort_order,
            default_collection_handle = EXCLUDED.default_collection_handle`,
      [
        shopKey,
        row.nodeKey,
        row.label,
        row.parentKey,
        row.depth,
        row.sortOrder,
        row.enabled,
        row.collectionId,
        row.collectionTitle,
        row.collectionHandle,
        row.defaultCollectionHandle,
      ]
    );
  }
}

export async function listAndEnsureMenuNodes(
  shop: string,
  collections: CollectionOption[]
): Promise<{ backend: "sql" | "memory"; nodes: MenuNodeRecord[]; warning?: string }> {
  const safeShop = normalizeShopKey(shop);
  if (!(await canUseSql())) {
    return {
      backend: "memory",
      warning: "SQL is not configured. Mapping data is running in memory for this local session.",
      nodes: getMemoryNodes(safeShop, collections),
    };
  }

  await seedSqlNodesIfMissing(safeShop, collections);
  return {
    backend: "sql",
    nodes: sortNodes(await listSqlNodes(safeShop)),
  };
}

export async function saveMenuMappings(
  shop: string,
  mappings: Array<{ nodeKey: string; collectionId: string | null; enabled?: boolean }>,
  collections: CollectionOption[]
): Promise<{
  backend: "sql" | "memory";
  nodes: MenuNodeRecord[];
  warning?: string;
  invalidNodeKeys: string[];
}> {
  const safeShop = normalizeShopKey(shop);
  const { byId } = toCollectionMaps(collections);

  if (!(await canUseSql())) {
    const current = getMemoryNodes(safeShop, collections);
    const byKey = new Map(current.map((row) => [row.nodeKey, cloneNode(row)]));
    const invalidNodeKeys = new Set<string>();
    for (const mapping of mappings) {
      const nodeKey = normalizeText(mapping.nodeKey);
      if (!nodeKey || !byKey.has(nodeKey)) {
        if (nodeKey) invalidNodeKeys.add(nodeKey);
        continue;
      }
      const row = byKey.get(nodeKey)!;
      const collectionId = normalizeText(mapping.collectionId) || "";
      const match = collectionId ? byId.get(collectionId) : null;
      row.collectionId = match?.id || null;
      row.collectionTitle = match?.title || null;
      row.collectionHandle = match?.handle || null;
      row.enabled = typeof mapping.enabled === "boolean" ? mapping.enabled : row.enabled;
      row.updatedAt = new Date().toISOString();
      byKey.set(nodeKey, row);
    }
    const next = sortNodes(Array.from(byKey.values()));
    memoryNodesByShop.set(safeShop, next.map(cloneNode));
    return {
      backend: "memory",
      warning: "SQL is not configured. Mapping data is running in memory for this local session.",
      nodes: next,
      invalidNodeKeys: Array.from(invalidNodeKeys).sort(),
    };
  }

  await seedSqlNodesIfMissing(safeShop, collections);
  const existing = await listSqlNodes(safeShop);
  const knownKeys = new Set(existing.map((row) => normalizeText(row.nodeKey)).filter(Boolean));
  const invalidNodeKeys = new Set<string>();
  const validMappings: Array<{
    nodeKey: string;
    collectionId: string | null;
    collectionTitle: string | null;
    collectionHandle: string | null;
    enabled: boolean | null;
  }> = [];

  for (const mapping of mappings) {
    const nodeKey = normalizeText(mapping.nodeKey);
    if (!nodeKey) continue;
    if (!knownKeys.has(nodeKey)) {
      invalidNodeKeys.add(nodeKey);
      continue;
    }
    const collectionId = normalizeText(mapping.collectionId) || "";
    const match = collectionId ? byId.get(collectionId) : null;
    validMappings.push({
      nodeKey,
      collectionId: match?.id || null,
      collectionTitle: match?.title || null,
      collectionHandle: match?.handle || null,
      enabled: typeof mapping.enabled === "boolean" ? mapping.enabled : null,
    });
  }
  if (validMappings.length > 0) {
    await sqlQuery(
      `WITH input_rows AS (
         SELECT
           unnest($2::text[]) AS node_key,
           unnest($3::text[]) AS collection_id,
           unnest($4::text[]) AS collection_title,
           unnest($5::text[]) AS collection_handle,
           unnest($6::boolean[]) AS enabled
       )
       UPDATE shopify_collection_menu_nodes AS n
       SET collection_id = i.collection_id,
           collection_title = i.collection_title,
           collection_handle = i.collection_handle,
           enabled = COALESCE(i.enabled, n.enabled),
           updated_at = now()
       FROM input_rows AS i
       WHERE n.shop = $1
         AND n.node_key = i.node_key`,
      [
        safeShop,
        validMappings.map((row) => row.nodeKey),
        validMappings.map((row) => row.collectionId),
        validMappings.map((row) => row.collectionTitle),
        validMappings.map((row) => row.collectionHandle),
        validMappings.map((row) => row.enabled),
      ]
    );
  }

  return {
    backend: "sql",
    nodes: sortNodes(await listSqlNodes(safeShop)),
    invalidNodeKeys: Array.from(invalidNodeKeys).sort(),
  };
}

export async function resetMenuMappingsToDefault(
  shop: string,
  collections: CollectionOption[]
): Promise<{ backend: "sql" | "memory"; nodes: MenuNodeRecord[]; warning?: string }> {
  const safeShop = normalizeShopKey(shop);
  const { byHandle } = toCollectionMaps(collections);

  if (!(await canUseSql())) {
    const rows = getMemoryNodes(safeShop, collections).map((row) => {
      const match = row.defaultCollectionHandle
        ? byHandle.get(normalizeLower(row.defaultCollectionHandle))
        : undefined;
      return {
        ...row,
        collectionId: match?.id || null,
        collectionTitle: match?.title || null,
        collectionHandle: match?.handle || null,
        enabled: true,
        updatedAt: new Date().toISOString(),
      };
    });
    memoryNodesByShop.set(safeShop, rows.map(cloneNode));
    return {
      backend: "memory",
      warning: "SQL is not configured. Mapping data is running in memory for this local session.",
      nodes: sortNodes(rows),
    };
  }

  await seedSqlNodesIfMissing(safeShop, collections);

  const current = await listSqlNodes(safeShop);
  for (const row of current) {
    const match = row.defaultCollectionHandle
      ? byHandle.get(normalizeLower(row.defaultCollectionHandle))
      : undefined;

    await sqlQuery(
      `UPDATE shopify_collection_menu_nodes
       SET collection_id = $3,
           collection_title = $4,
           collection_handle = $5,
           enabled = true,
           updated_at = now()
       WHERE shop = $1 AND node_key = $2`,
      [safeShop, row.nodeKey, match?.id || null, match?.title || null, match?.handle || null]
    );
  }

  return {
    backend: "sql",
    nodes: sortNodes(await listSqlNodes(safeShop)),
  };
}

function normalizeLiveNode(row: LiveMenuNodeInput): LiveMenuNodeInput {
  return {
    nodeKey: normalizeText(row.nodeKey),
    label: normalizeText(row.label),
    parentKey: normalizeText(row.parentKey) || null,
    depth: Math.max(0, toInt(row.depth)),
    sortOrder: toInt(row.sortOrder),
    collectionIdHint: normalizeText(row.collectionIdHint) || null,
    defaultCollectionHandle: normalizeText(row.defaultCollectionHandle) || null,
  };
}

function resolveNodeCollectionState(
  existing: MenuNodeRecord | undefined,
  incoming: LiveMenuNodeInput,
  byId: Map<string, CollectionOption>,
  byHandle: Map<string, CollectionOption>
) {
  const existingCollectionId = normalizeText(existing?.collectionId);
  const incomingCollectionIdHint = normalizeText(incoming.collectionIdHint);
  const existingDefaultHandle = normalizeText(existing?.defaultCollectionHandle);
  const incomingDefaultHandle = normalizeText(incoming.defaultCollectionHandle);

  const existingMatch = existingCollectionId ? byId.get(existingCollectionId) : undefined;
  const incomingHintMatch = incomingCollectionIdHint ? byId.get(incomingCollectionIdHint) : undefined;

  if (existingMatch) {
    return {
      collectionId: existingMatch.id,
      collectionTitle: existingMatch.title,
      collectionHandle: existingMatch.handle,
      defaultCollectionHandle: incomingDefaultHandle || existingDefaultHandle || existingMatch.handle || null,
    };
  }

  if (incomingHintMatch) {
    return {
      collectionId: incomingHintMatch.id,
      collectionTitle: incomingHintMatch.title,
      collectionHandle: incomingHintMatch.handle,
      defaultCollectionHandle:
        incomingDefaultHandle || existingDefaultHandle || incomingHintMatch.handle || null,
    };
  }

  if (existingCollectionId) {
    return {
      collectionId: existingCollectionId,
      collectionTitle: normalizeText(existing?.collectionTitle) || null,
      collectionHandle: normalizeText(existing?.collectionHandle) || null,
      defaultCollectionHandle: incomingDefaultHandle || existingDefaultHandle || null,
    };
  }

  const handleMatch =
    byHandle.get(normalizeLower(incomingDefaultHandle)) ||
    byHandle.get(normalizeLower(existingDefaultHandle));

  return {
    collectionId: handleMatch?.id || null,
    collectionTitle: handleMatch?.title || null,
    collectionHandle: handleMatch?.handle || null,
    defaultCollectionHandle: incomingDefaultHandle || existingDefaultHandle || handleMatch?.handle || null,
  };
}

export async function syncLiveMenuNodes(
  shop: string,
  liveNodes: LiveMenuNodeInput[],
  collections: CollectionOption[]
): Promise<{ backend: "sql" | "memory"; nodes: MenuNodeRecord[]; warning?: string }> {
  const safeShop = normalizeShopKey(shop);
  const { byId, byHandle } = toCollectionMaps(collections);
  const normalized = liveNodes
    .map(normalizeLiveNode)
    .filter((row) => row.nodeKey && row.label)
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.nodeKey.localeCompare(b.nodeKey);
    });
  if (normalized.length < 1) {
    if (!(await canUseSql())) {
      const existing = memoryNodesByShop.get(safeShop) || [];
      return {
        backend: "memory",
        warning:
          "Skipped live menu sync because Shopify returned no menu nodes. Kept existing local menu mapping state.",
        nodes: sortNodes(existing.map(cloneNode)),
      };
    }
    return {
      backend: "sql",
      warning:
        "Skipped live menu sync because Shopify returned no menu nodes. Kept existing local menu mapping state.",
      nodes: sortNodes(await listSqlNodes(safeShop)),
    };
  }

  if (!(await canUseSql())) {
    const existing = memoryNodesByShop.get(safeShop) || [];
    const byExisting = new Map(existing.map((row) => [row.nodeKey, row]));
    const normalizedKeys = new Set(normalized.map((row) => row.nodeKey));
    const nowIso = new Date().toISOString();
    // Same partial/throttled-pull guard as the SQL path: don't drop mappings
    // when Shopify returned far fewer nodes than we already have.
    const existingManagedMem = existing.filter(
      (row) => row.enabled && !row.nodeKey.startsWith("local4:")
    ).length;
    if (existingManagedMem >= 5 && normalized.length < existingManagedMem * 0.5) {
      return {
        backend: "memory",
        warning: `Skipped pruning stale menu nodes: Shopify returned ${normalized.length} node(s) but ${existingManagedMem} are stored — likely a partial/throttled menu pull, so existing mappings were preserved.`,
        nodes: sortNodes(existing.map(cloneNode)),
      };
    }
    const next: MenuNodeRecord[] = normalized.map((row) => {
      const current = byExisting.get(row.nodeKey);
      const collectionState = resolveNodeCollectionState(current, row, byId, byHandle);
      return {
        nodeKey: row.nodeKey,
        label: row.label,
        parentKey: row.parentKey,
        depth: row.depth,
        sortOrder: row.sortOrder,
        enabled: typeof current?.enabled === "boolean" ? current.enabled : true,
        collectionId: collectionState.collectionId,
        collectionTitle: collectionState.collectionTitle,
        collectionHandle: collectionState.collectionHandle,
        defaultCollectionHandle: collectionState.defaultCollectionHandle,
        updatedAt: nowIso,
      };
    });
    const preservedLocalOnly = existing
      .filter((row) => row.nodeKey.startsWith("local4:") && !normalizedKeys.has(row.nodeKey))
      .map((row) => ({ ...row, updatedAt: nowIso }));
    const preservedDisabledMissing = existing
      .filter((row) => !row.enabled && !row.nodeKey.startsWith("local4:") && !normalizedKeys.has(row.nodeKey))
      .map((row) => ({ ...row, updatedAt: nowIso }));
    next.push(...preservedLocalOnly, ...preservedDisabledMissing);

    memoryNodesByShop.set(safeShop, next.map(cloneNode));
    return {
      backend: "memory",
      warning: "SQL is not configured. Mapping data is running in memory for this local session.",
      nodes: sortNodes(next),
    };
  }

  const existingRows = await listSqlNodes(safeShop);
  const byExisting = new Map(existingRows.map((row) => [row.nodeKey, row]));
  const now = new Date().toISOString();

  const upsertRows = normalized.map((row) => {
    const current = byExisting.get(row.nodeKey);
    const collectionState = resolveNodeCollectionState(current, row, byId, byHandle);
    return {
      nodeKey: row.nodeKey,
      label: row.label,
      parentKey: row.parentKey,
      depth: row.depth,
      sortOrder: row.sortOrder,
      enabled: typeof current?.enabled === "boolean" ? current.enabled : true,
      collectionId: collectionState.collectionId,
      collectionTitle: collectionState.collectionTitle,
      collectionHandle: collectionState.collectionHandle,
      defaultCollectionHandle: collectionState.defaultCollectionHandle,
    };
  });
  if (upsertRows.length > 0) {
    await sqlQuery(
      `INSERT INTO shopify_collection_menu_nodes (
         shop, node_key, label, parent_key, depth, sort_order, enabled,
         collection_id, collection_title, collection_handle, default_collection_handle, updated_at
       )
       SELECT
         $1,
         unnest($2::text[]),
         unnest($3::text[]),
         unnest($4::text[]),
         unnest($5::int[]),
         unnest($6::int[]),
         unnest($7::boolean[]),
         unnest($8::text[]),
         unnest($9::text[]),
         unnest($10::text[]),
         unnest($11::text[]),
         $12::timestamptz
       ON CONFLICT (shop, node_key) DO UPDATE
         SET label = EXCLUDED.label,
             parent_key = EXCLUDED.parent_key,
             depth = EXCLUDED.depth,
             sort_order = EXCLUDED.sort_order,
             enabled = EXCLUDED.enabled,
             collection_id = EXCLUDED.collection_id,
             collection_title = EXCLUDED.collection_title,
             collection_handle = EXCLUDED.collection_handle,
             default_collection_handle = EXCLUDED.default_collection_handle,
             updated_at = EXCLUDED.updated_at`,
      [
        safeShop,
        upsertRows.map((row) => row.nodeKey),
        upsertRows.map((row) => row.label),
        upsertRows.map((row) => row.parentKey),
        upsertRows.map((row) => row.depth),
        upsertRows.map((row) => row.sortOrder),
        upsertRows.map((row) => row.enabled),
        upsertRows.map((row) => row.collectionId),
        upsertRows.map((row) => row.collectionTitle),
        upsertRows.map((row) => row.collectionHandle),
        upsertRows.map((row) => row.defaultCollectionHandle),
        now,
      ]
    );
  }

  // Guard against a partial/throttled menu pull silently wiping live mappings.
  // The deep menus{items{items{items}}} query Shopify aggressively throttles can
  // return a truncated item set; if that happened, the reconciling DELETE below
  // would permanently remove every enabled, mapped node missing from the
  // snapshot. If Shopify returned far fewer nodes than we already have stored,
  // treat the pull as incomplete and SKIP the destructive reconciliation — the
  // upsert above already applied any genuine additions/changes, and a real bulk
  // deletion can simply be re-run. (The empty-menu case is handled earlier.)
  const existingManaged = existingRows.filter(
    (row) => row.enabled && !row.nodeKey.startsWith("local4:")
  ).length;
  if (existingManaged >= 5 && normalized.length < existingManaged * 0.5) {
    return {
      backend: "sql",
      warning: `Skipped pruning stale menu nodes: Shopify returned ${normalized.length} node(s) but ${existingManaged} are stored — this looks like a partial or throttled menu pull, so existing mappings were preserved. Refresh again to reconcile.`,
      nodes: sortNodes(await listSqlNodes(safeShop)),
    };
  }

  const keys = normalized.map((row) => row.nodeKey);
  await sqlQuery(
    `DELETE FROM shopify_collection_menu_nodes
     WHERE shop = $1
       AND NOT (node_key = ANY($2::text[]))
       AND node_key NOT LIKE 'local4:%'
       AND enabled = true`,
    [safeShop, keys]
  );

  return {
    backend: "sql",
    nodes: sortNodes(await listSqlNodes(safeShop)),
  };
}

export async function logCollectionMappingAction(input: ToggleAuditInput): Promise<void> {
  const shop = normalizeShopKey(input.shop);
  if (!(await canUseSql())) return;

  try {
    await sqlQuery(
      `INSERT INTO shopify_collection_mapping_actions (
        shop,
        product_id,
        product_title,
        node_key,
        checked,
        added_collection_ids,
        removed_collection_ids,
        status,
        error_message
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
      [
        shop,
        normalizeText(input.productId),
        normalizeText(input.productTitle) || null,
        normalizeText(input.nodeKey),
        Boolean(input.checked),
        JSON.stringify(Array.isArray(input.addedCollectionIds) ? input.addedCollectionIds : []),
        JSON.stringify(Array.isArray(input.removedCollectionIds) ? input.removedCollectionIds : []),
        normalizeText(input.status) || "ok",
        normalizeText(input.errorMessage) || null,
      ]
    );
  } catch {
    // Best-effort audit log.
  }
}

async function trimSqlMappingAuditLogs(shop: string) {
  const now = Date.now();
  const lastTrim = trimAuditLogsLastRunByShop.get(shop) || 0;
  if (now - lastTrim < TRIM_AUDIT_LOGS_INTERVAL_MS) return;
  await sqlQuery(
    `DELETE FROM shopify_collection_mapping_audit
     WHERE shop = $1
       AND created_at < now() - interval '90 days'`,
    [shop]
  );
  trimAuditLogsLastRunByShop.set(shop, now);
}

async function trimSqlRowDrafts(shop: string) {
  const now = Date.now();
  const lastTrim = trimRowDraftsLastRunByShop.get(shop) || 0;
  if (now - lastTrim < TRIM_ROW_DRAFTS_INTERVAL_MS) return;
  await sqlQuery(
    `DELETE FROM shopify_collection_mapping_row_drafts
     WHERE shop = $1
       AND updated_at < now() - interval '7 days'`,
    [shop]
  );
  trimRowDraftsLastRunByShop.set(shop, now);
}

export async function logMappingAudit(input: MappingAuditInput): Promise<void> {
  const shop = normalizeShopKey(input.shop);
  const action = normalizeText(input.action) || "unknown";
  const summary = normalizeText(input.summary) || action;
  const status: "ok" | "error" = normalizeLower(input.status) === "error" ? "error" : "ok";
  const details = normalizeDetails(input.details);
  const errorMessage = normalizeText(input.errorMessage) || null;

  if (!(await canUseSql())) {
    const current = pruneMemoryAuditLogs(shop);
    const row: MappingAuditLogRow = {
      id: randomUUID(),
      action,
      summary,
      status,
      details,
      errorMessage,
      createdAt: new Date().toISOString(),
    };
    memoryAuditLogsByShop.set(shop, [row, ...current].slice(0, MAPPING_AUDIT_LIMIT_MAX));
    return;
  }

  try {
    await trimSqlMappingAuditLogs(shop);
    await sqlQuery(
      `INSERT INTO shopify_collection_mapping_audit (
        shop, action, summary, status, details, error_message
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [shop, action, summary, status, JSON.stringify(details), errorMessage]
    );
  } catch {
    // Best-effort audit log.
  }
}

export async function listMappingAuditLogs(
  shop: string,
  limit = 120
): Promise<{ backend: "sql" | "memory"; logs: MappingAuditLogRow[]; warning?: string }> {
  const safeShop = normalizeShopKey(shop);
  const safeLimit = clampAuditLimit(limit);

  if (!(await canUseSql())) {
    const rows = pruneMemoryAuditLogs(safeShop)
      .slice()
      .sort((a, b) => {
        const tA = Date.parse(a.createdAt) || 0;
        const tB = Date.parse(b.createdAt) || 0;
        return tB - tA;
      })
      .slice(0, safeLimit);
    return {
      backend: "memory",
      warning: "SQL is not configured. Mapping logs are only available for this local session.",
      logs: rows,
    };
  }

  await trimSqlMappingAuditLogs(safeShop);
  const rows = await sqlQuery<PersistedMappingAuditRow>(
    `SELECT id, action, summary, status, details, error_message, created_at
     FROM shopify_collection_mapping_audit
     WHERE shop = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [safeShop, safeLimit]
  );

  return {
    backend: "sql",
    logs: rows.map(parsePersistedMappingAuditRow),
  };
}

export async function listLatestProductActionStatus(
  shop: string,
  productIds: string[]
): Promise<{
  backend: "sql" | "memory";
  statusByProductId: Map<string, ProductActionStatus>;
  warning?: string;
}> {
  const safeShop = normalizeShopKey(shop);
  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(productIds) ? productIds : [])
        .map((row) => normalizeText(row))
        .filter(Boolean)
    )
  );
  const empty = new Map<string, ProductActionStatus>();
  if (normalizedIds.length < 1) {
    return { backend: (await canUseSql()) ? "sql" : "memory", statusByProductId: empty };
  }

  if (!(await canUseSql())) {
    return {
      backend: "memory",
      warning: "SQL is not configured. Product mapping status is unavailable in this local session.",
      statusByProductId: empty,
    };
  }

  type LatestActionRow = {
    product_id: string;
    status: string;
  };
  const rows = await sqlQuery<LatestActionRow>(
    `SELECT DISTINCT ON (product_id) product_id, status
     FROM shopify_collection_mapping_actions
     WHERE shop = $1
       AND product_id = ANY($2::text[])
     ORDER BY product_id ASC, created_at DESC`,
    [safeShop, normalizedIds]
  );
  const statusByProductId = new Map<string, ProductActionStatus>();
  for (const row of rows) {
    const productId = normalizeText(row.product_id);
    if (!productId) continue;
    const status = normalizeLower(row.status) === "ok" ? "PROCESSED" : "";
    statusByProductId.set(productId, status);
  }
  return { backend: "sql", statusByProductId };
}

export async function listRowReviewStates(
  shop: string,
  rowIds: string[]
): Promise<{
  backend: "sql" | "memory";
  statusByRowId: Map<string, boolean>;
  warning?: string;
}> {
  const safeShop = normalizeShopKey(shop);
  const normalizedRowIds = Array.from(
    new Set(
      (Array.isArray(rowIds) ? rowIds : [])
        .map((rowId) => normalizeText(rowId))
        .filter(Boolean)
    )
  );
  const empty = new Map<string, boolean>();
  if (normalizedRowIds.length < 1) {
    return { backend: (await canUseSql()) ? "sql" : "memory", statusByRowId: empty };
  }

  if (!(await canUseSql())) {
    const store = memoryRowReviewByShop.get(safeShop) || new Map<string, boolean>();
    const statusByRowId = new Map<string, boolean>();
    for (const rowId of normalizedRowIds) {
      if (!store.has(rowId)) continue;
      statusByRowId.set(rowId, Boolean(store.get(rowId)));
    }
    return {
      backend: "memory",
      warning: "SQL is not configured. Review approvals are only available for this local session.",
      statusByRowId,
    };
  }

  type PersistedReviewRow = {
    row_id: string;
    is_reviewed: boolean;
  };
  const rows = await sqlQuery<PersistedReviewRow>(
    `SELECT row_id, is_reviewed
     FROM shopify_collection_mapping_row_reviews
     WHERE shop = $1
       AND row_id = ANY($2::text[])`,
    [safeShop, normalizedRowIds]
  );
  const statusByRowId = new Map<string, boolean>();
  for (const row of rows) {
    const rowId = normalizeText(row.row_id);
    if (!rowId) continue;
    statusByRowId.set(rowId, Boolean(row.is_reviewed));
  }
  return { backend: "sql", statusByRowId };
}

export async function saveRowReviewStates(
  shop: string,
  reviews: Array<{ rowId: string; isReviewed: boolean }>
): Promise<{ backend: "sql" | "memory"; warning?: string }> {
  const safeShop = normalizeShopKey(shop);
  const normalized = Array.from(
    new Map(
      (Array.isArray(reviews) ? reviews : [])
        .map((entry) => ({
          rowId: normalizeText(entry?.rowId),
          isReviewed: Boolean(entry?.isReviewed),
        }))
        .filter((entry) => entry.rowId)
        .map((entry) => [entry.rowId, entry] as const)
    ).values()
  );
  if (normalized.length < 1) {
    return { backend: (await canUseSql()) ? "sql" : "memory" };
  }

  if (!(await canUseSql())) {
    const existing = memoryRowReviewByShop.get(safeShop) || new Map<string, boolean>();
    for (const entry of normalized) {
      existing.set(entry.rowId, entry.isReviewed);
    }
    memoryRowReviewByShop.set(safeShop, existing);
    return {
      backend: "memory",
      warning: "SQL is not configured. Review approvals are only available for this local session.",
    };
  }

  await sqlQuery(
    `INSERT INTO shopify_collection_mapping_row_reviews (shop, row_id, is_reviewed, updated_at)
     SELECT
       $1,
       unnest($2::text[]),
       unnest($3::boolean[]),
       now()
     ON CONFLICT (shop, row_id) DO UPDATE
       SET is_reviewed = EXCLUDED.is_reviewed,
           updated_at = EXCLUDED.updated_at`,
    [safeShop, normalized.map((entry) => entry.rowId), normalized.map((entry) => entry.isReviewed)]
  );

  return { backend: "sql" };
}

export async function listRowDraftStates(
  shop: string,
  rowIds: string[],
  actorKey?: string
): Promise<{
  backend: "sql" | "memory";
  draftByRowId: Map<string, RowDraftState>;
  warning?: string;
}> {
  const safeShop = normalizeShopKey(shop);
  const normalizedRowIds = Array.from(
    new Set(
      (Array.isArray(rowIds) ? rowIds : [])
        .map((rowId) => normalizeText(rowId))
        .filter(Boolean)
    )
  );
  const draftActorKey = normalizeDraftActorKey(actorKey);
  const scopedRowIds = normalizedRowIds.map((rowId) => toScopedDraftRowId(draftActorKey, rowId));
  const empty = new Map<string, RowDraftState>();
  if (normalizedRowIds.length < 1) {
    return { backend: (await canUseSql()) ? "sql" : "memory", draftByRowId: empty };
  }

  if (!(await canUseSql())) {
    const store = memoryRowDraftByShop.get(safeShop) || new Map<string, RowDraftState>();
    const threshold = Date.now() - ROW_DRAFT_RETENTION_MS;
    const nextStore = new Map<string, RowDraftState>();
    const draftByRowId = new Map<string, RowDraftState>();
    for (const [rowId, draft] of store.entries()) {
      const ts = Date.parse(normalizeText(draft.updatedAt));
      if (Number.isFinite(ts) && ts >= threshold) {
        nextStore.set(rowId, draft);
      }
    }
    memoryRowDraftByShop.set(safeShop, nextStore);
    for (const rowId of normalizedRowIds) {
      const draft = nextStore.get(toScopedDraftRowId(draftActorKey, rowId));
      if (!draft) continue;
      draftByRowId.set(rowId, { ...draft });
    }
    return {
      backend: "memory",
      warning: "SQL is not configured. Draft row state is only available for this local session.",
      draftByRowId,
    };
  }

  await trimSqlRowDrafts(safeShop);
  const rows = await sqlQuery<PersistedRowDraftRow>(
    `SELECT row_id, draft_data, updated_at
     FROM shopify_collection_mapping_row_drafts
     WHERE shop = $1
       AND row_id = ANY($2::text[])`,
    [safeShop, scopedRowIds]
  );
  const draftByRowId = new Map<string, RowDraftState>();
  for (const row of rows) {
    const rowId = fromScopedDraftRowId(normalizeText(row.row_id), draftActorKey);
    if (!rowId) continue;
    const parsed = normalizeRowDraftState(row.draft_data);
    parsed.updatedAt = normalizeText(row.updated_at) || new Date().toISOString();
    draftByRowId.set(rowId, parsed);
  }
  return { backend: "sql", draftByRowId };
}

export async function saveRowDraftStates(
  shop: string,
  drafts: Array<{ rowId: string; draft: RowDraftState }>,
  actorKey?: string
): Promise<{ backend: "sql" | "memory"; warning?: string }> {
  const safeShop = normalizeShopKey(shop);
  const draftActorKey = normalizeDraftActorKey(actorKey);
  const normalized = Array.from(
    new Map(
      (Array.isArray(drafts) ? drafts : [])
        .map((entry) => ({
          rowId: normalizeText(entry?.rowId),
          draft: normalizeRowDraftState(entry?.draft),
        }))
        .filter((entry) => entry.rowId)
        .map((entry) => [entry.rowId, entry] as const)
    ).values()
  );
  if (normalized.length < 1) {
    return { backend: (await canUseSql()) ? "sql" : "memory" };
  }

  if (!(await canUseSql())) {
    const existing = memoryRowDraftByShop.get(safeShop) || new Map<string, RowDraftState>();
    const nowIso = new Date().toISOString();
    for (const entry of normalized) {
      existing.set(toScopedDraftRowId(draftActorKey, entry.rowId), { ...entry.draft, updatedAt: nowIso });
    }
    memoryRowDraftByShop.set(safeShop, existing);
    return {
      backend: "memory",
      warning: "SQL is not configured. Draft row state is only available for this local session.",
    };
  }

  await trimSqlRowDrafts(safeShop);
  await sqlQuery(
    `INSERT INTO shopify_collection_mapping_row_drafts (shop, row_id, draft_data, updated_at)
     SELECT
       $1,
       unnest($2::text[]),
       unnest($3::jsonb[]),
       now()
     ON CONFLICT (shop, row_id) DO UPDATE
       SET draft_data = EXCLUDED.draft_data,
           updated_at = EXCLUDED.updated_at`,
    [
      safeShop,
      normalized.map((entry) => toScopedDraftRowId(draftActorKey, entry.rowId)),
      normalized.map((entry) => JSON.stringify(entry.draft)),
    ]
  );

  return { backend: "sql" };
}

export async function clearRowDraftStates(
  shop: string,
  rowIds: string[],
  actorKey?: string
): Promise<{ backend: "sql" | "memory"; warning?: string; cleared: number }> {
  const safeShop = normalizeShopKey(shop);
  const draftActorKey = normalizeDraftActorKey(actorKey);
  const normalizedRowIds = Array.from(
    new Set(
      (Array.isArray(rowIds) ? rowIds : [])
        .map((rowId) => normalizeText(rowId))
        .filter(Boolean)
    )
  );
  const scopedRowIds = normalizedRowIds.map((rowId) => toScopedDraftRowId(draftActorKey, rowId));
  if (normalizedRowIds.length < 1) {
    return { backend: (await canUseSql()) ? "sql" : "memory", cleared: 0 };
  }

  if (!(await canUseSql())) {
    const existing = memoryRowDraftByShop.get(safeShop) || new Map<string, RowDraftState>();
    let cleared = 0;
    for (const rowId of scopedRowIds) {
      if (existing.delete(rowId)) cleared += 1;
    }
    memoryRowDraftByShop.set(safeShop, existing);
    return {
      backend: "memory",
      warning: "SQL is not configured. Draft row state is only available for this local session.",
      cleared,
    };
  }

  const result = await sqlQuery<{ row_id: string }>(
    `DELETE FROM shopify_collection_mapping_row_drafts
     WHERE shop = $1
       AND row_id = ANY($2::text[])
     RETURNING row_id`,
    [safeShop, scopedRowIds]
  );
  return { backend: "sql", cleared: result.length };
}

export async function clearAllRowDraftStates(
  shop: string,
  actorKey?: string
): Promise<{ backend: "sql" | "memory"; warning?: string; cleared: number }> {
  const safeShop = normalizeShopKey(shop);
  const draftActorKey = normalizeDraftActorKey(actorKey);
  const scopedPrefix = `${draftActorKey}${DRAFT_ROW_SCOPE_DELIMITER}`;

  if (!(await canUseSql())) {
    const existing = memoryRowDraftByShop.get(safeShop) || new Map<string, RowDraftState>();
    let cleared = 0;
    for (const key of Array.from(existing.keys())) {
      if (!key.startsWith(scopedPrefix)) continue;
      existing.delete(key);
      cleared += 1;
    }
    memoryRowDraftByShop.set(safeShop, existing);
    return {
      backend: "memory",
      warning: "SQL is not configured. Draft row state is only available for this local session.",
      cleared,
    };
  }

  const result = await sqlQuery<{ row_id: string }>(
    `DELETE FROM shopify_collection_mapping_row_drafts
     WHERE shop = $1
       AND left(row_id, $2) = $3
     RETURNING row_id`,
    [safeShop, scopedPrefix.length, scopedPrefix]
  );
  return { backend: "sql", cleared: result.length };
}

export function getDefaultMenuNodes() {
  return DEFAULT_MENU_NODES.map((row) => ({ ...row }));
}
