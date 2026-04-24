import type { CatalogSyncMatrixPayload, CatalogSyncVariantPayload } from "@/lib/types/catalog-sync";
import { stableLsSystemIdFromString } from "@/lib/utils/ls-id";

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

const SIZE_LETTER_SUFFIX = /\s+(XXL|XXS|XL|XS|S|M|L)\s*$/i;

/**
 * Strip a trailing `<color> <size>`, `<size>`, or `<color>` tail from a product
 * description. Only used when ItemMatrix.description is unavailable (fallback
 * path via the bare Item endpoint) so we don't bake a variant's color+size
 * into the shared matrix row.
 *
 * Iterates so e.g. "RYAN POLO SHIRT BLUE S" with color=BLUE, size=S peels
 * `" S"` first, then `" BLUE"`, leaving `"RYAN POLO SHIRT"`.
 */
function stripVariantSuffix(description: string, color: string | null, size: string | null): string {
  let out = description.replace(/\s+$/u, "");
  const sz = (size ?? "").trim();
  const cl = (color ?? "").trim();

  const stripTail = (tail: string): boolean => {
    if (!tail) return false;
    const lower = out.toLowerCase();
    const t = tail.toLowerCase();
    if (lower.endsWith(` ${t}`)) {
      out = out.slice(0, out.length - (t.length + 1)).replace(/\s+$/u, "");
      return true;
    }
    return false;
  };

  let changed = true;
  let guard = 0;
  while (changed && guard < 4) {
    changed = false;
    guard++;
    if (sz && cl && stripTail(`${cl} ${sz}`)) { changed = true; continue; }
    if (sz && stripTail(sz)) { changed = true; continue; }
    if (cl && stripTail(cl)) { changed = true; continue; }
    if (SIZE_LETTER_SUFFIX.test(out)) {
      out = out.replace(SIZE_LETTER_SUFFIX, "").replace(/\s+$/u, "");
      changed = true;
      continue;
    }
  }
  return out || description;  // never return empty — caller expects non-empty
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

function parseLsItemIdNumeric(item: Record<string, unknown>): number | null {
  const raw = normalizeText(item.itemID);
  if (!raw || raw === "0") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

type NormalizedRow = {
  itemId: string;
  lsItemId: number | null;
  groupKey: string;
  systemSku: string;
  customSku: string;
  description: string;
  /** Parent ItemMatrix description when the item was fetched via the V3
   * ItemMatrix endpoint; null when fetched via the bare V3/legacy Item
   * endpoint. Preferred over [description] for the matrix-level name because
   * per-variant [description] typically bakes in color+size. */
  matrixDescription: string | null;
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
  const lsItemId = parseLsItemIdNumeric(item);
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
    lsItemId,
    groupKey,
    systemSku,
    customSku: customSku || systemSku || itemId,
    description: normalizeText(item.description) || customSku || systemSku || "Item",
    // Annotated by the fetcher when the item came from an ItemMatrix page.
    matrixDescription: normalizeText(item.__matrixDescription) || null,
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
    // Matrix-level description selection:
    //   1. Prefer the parent ItemMatrix.description annotated by the fetcher.
    //      This is the clean, variant-free product name.
    //   2. Otherwise, fall back to [head.description] but with the variant's
    //      own color/size stripped from the tail — the per-Item description
    //      typically reads "RYAN POLO SHIRT BLUE S"; without this strip we'd
    //      bake one specific variant's color+size into the shared matrix row.
    const description =
      (variants.map((v) => v.matrixDescription).find((d): d is string => !!d && d.length > 0)) ??
      stripVariantSuffix(head.description, head.color, head.size);
    const brand = head.brand;
    const category = head.category;
    const vendor = head.brand;
    const upc =
      variants.map((v) => v.upc).find((u) => u.length > 0) ||
      `SYN-${hash(`${head.groupKey}:upc`)}`;

    const vPayloads: CatalogSyncVariantPayload[] = variants.map((v) => ({
      lsSystemId: lsSystemIdForVariant(v.itemId, v.systemSku, hash),
      lsItemId: v.lsItemId,
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
