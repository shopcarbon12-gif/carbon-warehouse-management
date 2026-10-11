/**
 * Ad product groups — the product lists ad campaigns advertise (table
 * ad_product_groups, edited in Integrations → Shopify).
 *
 * One set of rules drives both channels so Google and Meta always advertise
 * the same products:
 *   • Google: member listings get customLabel{slot} = value in Merchant Center.
 *   • Meta:   an equivalent catalog product-set filter.
 * A product belongs when its type is in product_types OR its title contains one
 * of name_contains, and its title contains none of name_excludes; plus every
 * product of include_groups. in_stock_only keeps sold-out sizes out.
 */
import type { Pool } from "pg";

export type AdProductGroup = {
  id: string;
  slug: string;
  name: string;
  product_types: string[];
  name_contains: string[];
  name_excludes: string[];
  include_groups: string[];
  in_stock_only: boolean;
  google_label_slot: number | null;
  google_label_value: string | null;
  meta_set_name: string | null;
  meta_set_id: string | null;
  active: boolean;
  sort_order: number;
  last_sync: GroupSyncResult | null;
};

export type GroupSyncResult = {
  at: string;
  products: number;
  variants: number;
  google_listings: number | null;
  meta_count: number | null;
  google_campaigns: string[];
  meta_ad_sets: string[];
  warnings: string[];
};

export async function loadAdGroups(pool: Pool, activeOnly = false): Promise<AdProductGroup[]> {
  const r = await pool.query<AdProductGroup>(
    `SELECT id::text, slug, name, product_types, name_contains, name_excludes, include_groups,
            in_stock_only, google_label_slot, google_label_value, meta_set_name, meta_set_id,
            active, sort_order, last_sync
       FROM ad_product_groups
      ${activeOnly ? "WHERE active" : ""}
      ORDER BY sort_order, name`,
  );
  return r.rows;
}

export type ShopProduct = {
  id: string; // numeric Shopify product id
  title: string;
  productType: string;
  variants: Array<{ id: string; qty: number }>;
};

const norm = (s: string) => s.trim().toLowerCase();

/** Does this product match the group's own rules (not include_groups, not stock)? */
function matchesOwnRules(g: AdProductGroup, p: ShopProduct): boolean {
  const title = norm(p.title);
  const type = norm(p.productType);
  const byType = g.product_types.some((t) => norm(t) === type);
  const byName = g.name_contains.some((n) => n.trim() && title.includes(norm(n)));
  if (!byType && !byName) return false;
  return !g.name_excludes.some((x) => x.trim() && title.includes(norm(x)));
}

/** Product ids matching a group, following include_groups (cycle-safe). */
export function groupMatchesProduct(
  g: AdProductGroup,
  p: ShopProduct,
  bySlug: Map<string, AdProductGroup>,
  seen: Set<string> = new Set(),
): boolean {
  if (seen.has(g.slug)) return false;
  seen.add(g.slug);
  if (matchesOwnRules(g, p)) return true;
  return g.include_groups.some((s) => {
    const inc = bySlug.get(s);
    return inc ? groupMatchesProduct(inc, p, bySlug, seen) : false;
  });
}

/** Variant ids of a product that count for a group (stock rule applied). */
export function memberVariants(g: AdProductGroup, p: ShopProduct): string[] {
  return p.variants.filter((v) => !g.in_stock_only || v.qty > 0).map((v) => v.id);
}

/** The group's rules as a Meta catalog product-set filter. */
export function metaFilterFor(
  g: AdProductGroup,
  bySlug: Map<string, AdProductGroup>,
  seen: Set<string> = new Set(),
): Record<string, unknown> {
  seen.add(g.slug);
  const own: Record<string, unknown>[] = [
    ...g.product_types.filter((t) => t.trim()).map((t) => ({ product_type: { eq: t } })),
    ...g.name_contains.filter((n) => n.trim()).map((n) => ({ name: { i_contains: n } })),
  ];
  const parts: Record<string, unknown>[] = [];
  if (own.length) {
    const excludes = g.name_excludes.filter((x) => x.trim()).map((x) => ({ name: { i_not_contains: x } }));
    parts.push(excludes.length ? { and: [{ or: own }, ...excludes] } : { or: own });
  }
  for (const s of g.include_groups) {
    const inc = bySlug.get(s);
    if (inc && !seen.has(inc.slug)) parts.push(metaFilterFor({ ...inc, in_stock_only: false }, bySlug, seen));
  }
  const body = parts.length === 1 ? parts[0] : { or: parts.length ? parts : [{ name: { i_contains: "__no_rules__" } }] };
  return g.in_stock_only ? { and: [body, { availability: { eq: "in stock" } }] } : body;
}

/** Validate + normalise an edited group from the UI. */
export function cleanGroupInput(raw: Record<string, unknown>): Omit<AdProductGroup, "id" | "last_sync" | "meta_set_id"> & { meta_set_id?: string | null } {
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : [])
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 200);
  const slug = String(raw.slug || raw.name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!slug) throw new Error("Give the group a name");
  const slotRaw = raw.google_label_slot;
  const slot = slotRaw === null || slotRaw === "" || slotRaw === undefined ? null : Number(slotRaw);
  if (slot !== null && (!Number.isInteger(slot) || slot < 0 || slot > 4)) throw new Error("Google label slot must be 0–4");
  const gval = String(raw.google_label_value || "").trim().toLowerCase().slice(0, 100) || null;
  return {
    slug,
    name: String(raw.name || slug).trim().slice(0, 120),
    product_types: list(raw.product_types),
    name_contains: list(raw.name_contains),
    name_excludes: list(raw.name_excludes),
    include_groups: list(raw.include_groups).map((s) => s.toLowerCase()),
    in_stock_only: raw.in_stock_only !== false,
    google_label_slot: gval ? (slot ?? 0) : null,
    google_label_value: gval,
    meta_set_name: String(raw.meta_set_name || "").trim().slice(0, 120) || null,
    meta_set_id: typeof raw.meta_set_id === "string" && /^\d+$/.test(raw.meta_set_id) ? raw.meta_set_id : null,
    active: raw.active !== false,
    sort_order: Number.isFinite(Number(raw.sort_order)) ? Number(raw.sort_order) : 100,
  };
}
