import type { CatalogSyncMatrixPayload, CatalogSyncVariantPayload } from "@/lib/types/catalog-sync";
import { stableLsSystemIdFromString } from "@/lib/utils/ls-id";

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function extractMatrixColorAndSize(item: Record<string, unknown>): { color: string | null; size: string | null } {
  const attributes = (item.ItemAttributes as Record<string, unknown> | undefined) ?? {};
  const color =
    normalizeText(attributes.attribute1 ?? attributes.color ?? item.attribute1 ?? item.color) || null;
  const size =
    normalizeText(attributes.attribute2 ?? attributes.size ?? item.attribute2 ?? item.size) || null;
  return { color, size };
}

function extractDefaultRetailPrice(item: Record<string, unknown>): string | null {
  const pricesRoot = item.Prices as { ItemPrice?: unknown } | undefined;
  const prices = toArray(pricesRoot?.ItemPrice) as Record<string, unknown>[];
  if (prices.length === 0) return null;

  const defaultPrice = prices.find((price) => {
    const useType = normalizeText(price?.useType).toLowerCase();
    return normalizeText(price?.useTypeID) === "1" || useType === "default";
  });

  const selected = defaultPrice || prices[0];
  const amount = normalizeText(selected?.amount);
  return amount || null;
}

function lsSystemIdForVariant(itemId: string, systemSku: string, hash: (s: string) => number): number {
  const n = Number.parseInt(normalizeText(systemSku), 10);
  if (Number.isFinite(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER) return n;
  return hash(`${itemId}:variant`);
}

function matrixLsSystemId(matrixKey: string, hash: (s: string) => number): number | null {
  if (matrixKey.startsWith("m:")) {
    const id = matrixKey.slice(2);
    const n = Number.parseInt(id, 10);
    if (Number.isFinite(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER) return n;
    return hash(`matrix:${id}`);
  }
  return null;
}

type NormalizedRow = {
  itemId: string;
  groupKey: string;
  systemSku: string;
  customSku: string;
  description: string;
  upc: string;
  color: string | null;
  size: string | null;
  retailPrice: string | null;
  category: string | null;
  brand: string | null;
  onHandTotal: number | null;
};

function extractRseriesOnHandTotal(item: Record<string, unknown>): number | null {
  const qoh = Number.parseInt(normalizeText(item.qoh), 10);
  if (Number.isFinite(qoh) && qoh >= 0) return qoh;
  const roots = item.ItemShops as Record<string, unknown> | undefined;
  const shops = toArray(roots?.ItemShop) as Record<string, unknown>[];
  let sum = 0;
  let found = false;
  for (const sh of shops) {
    const n = Number.parseInt(normalizeText(sh.qoh), 10);
    if (Number.isFinite(n) && n >= 0) {
      sum += n;
      found = true;
    }
  }
  return found ? sum : null;
}

function normalizeRawItem(
  item: Record<string, unknown>,
  categoryNameById: Record<string, string>,
  manufacturerNameById: Record<string, string>,
): NormalizedRow | null {
  const itemId = normalizeText(item.itemID);
  const systemSku = normalizeText(item.systemSku);
  const customSku = normalizeText(item.customSku);
  if (!itemId && !systemSku && !customSku) return null;

  const itemMatrixId = normalizeText(item.itemMatrixID);
  const groupKey =
    itemMatrixId && itemMatrixId !== "0" ? `m:${itemMatrixId}` : `i:${itemId || systemSku || customSku}`;

  const { color, size } = extractMatrixColorAndSize(item);
  const categoryId = normalizeText(item.categoryID);
  const category =
    (categoryId && categoryId !== "0" ? categoryNameById[categoryId] : null) ||
    (categoryId && categoryId !== "0" ? `Category ${categoryId}` : null);

  const manufacturerId = normalizeText(item.manufacturerID);
  const brand =
    (manufacturerId && manufacturerId !== "0" ? manufacturerNameById[manufacturerId] : null) || null;

  return {
    itemId: itemId || systemSku || customSku,
    groupKey,
    systemSku,
    customSku: customSku || systemSku || itemId,
    description: normalizeText(item.description) || customSku || systemSku || "Item",
    upc: normalizeText(item.upc) || normalizeText(item.ean) || "",
    color,
    size,
    retailPrice: extractDefaultRetailPrice(item),
    category,
    brand,
    onHandTotal: extractRseriesOnHandTotal(item),
  };
}

/**
 * Maps R-Series `Item` payloads (as returned by carbon-gen style catalog pulls) into WMS catalog sync rows.
 */
export function mapRseriesRawItemsToCatalogSync(
  rawItems: unknown[],
  categoryNameById: Record<string, string>,
  manufacturerNameById: Record<string, string>,
  hash: (input: string) => number = stableLsSystemIdFromString,
): CatalogSyncMatrixPayload[] | null {
  const rows: NormalizedRow[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const n = normalizeRawItem(raw as Record<string, unknown>, categoryNameById, manufacturerNameById);
    if (n) rows.push(n);
  }
  if (rows.length === 0) return null;

  const byGroup = new Map<string, NormalizedRow[]>();
  for (const r of rows) {
    const list = byGroup.get(r.groupKey) ?? [];
    list.push(r);
    byGroup.set(r.groupKey, list);
  }

  const out: CatalogSyncMatrixPayload[] = [];

  for (const [, variants] of byGroup) {
    if (variants.length === 0) continue;
    const head = variants[0]!;
    const matrixId = matrixLsSystemId(head.groupKey, hash);
    const description = head.description;
    const brand = head.brand;
    const category = head.category;
    const vendor = head.brand;
    const upc =
      variants.map((v) => v.upc).find((u) => u.length > 0) ||
      `SYN-${hash(`${head.groupKey}:upc`)}`;

    const vPayloads: CatalogSyncVariantPayload[] = variants.map((v) => ({
      lsSystemId: lsSystemIdForVariant(v.itemId, v.systemSku, hash),
      sku: v.customSku || v.systemSku || v.itemId,
      upc: v.upc || null,
      color: v.color,
      size: v.size,
      retailPrice: v.retailPrice,
      onHandTotal: v.onHandTotal,
    }));

    out.push({
      matrixLsSystemId: matrixId,
      description,
      brand,
      category,
      vendor,
      upc,
      variants: vPayloads,
    });
  }

  return out.length ? out : null;
}
