/**
 * Social product tags that went stale after a colour rename (owner, 2026-11-07).
 *
 * Renaming a colour re-creates the product's Shopify variants. Meta keeps the
 * old variants but hides them ("visible_only_with_overrides"), and Instagram
 * refuses a whole post when one tag points at a hidden item — the Elena Reel
 * (2026-11-06) failed on Riley Dress BEIGE after BEIGE became IVORY.
 *
 * For every tag of a post still to go out, this checks the Meta catalog item.
 * When it is hidden or gone it moves the tag to the live item of the same
 * product (Meta group = Shopify product), picking the colour:
 *   1. the same colour (variants re-created, name unchanged);
 *   2. the colour it was renamed to (colour_renames, following chains);
 *   3. the product's only live colour.
 * Same size first, then any in-stock size. If none of those is certain the tag
 * is left alone and reported, never guessed.
 *
 * Runs before every Instagram publish, before approval's tag check, and hourly
 * over every post still to go out (so the Social page shows the right tags).
 */
import type { Pool } from "pg";
import { catalogGroupItems, catalogItem, type CatalogItem } from "./meta";

export type TagFix = { postId: string; tagId: string; from: string; to: string; oldLabel: string; label: string };
export type TagStuck = { postId: string; tagId: string; label: string; why: string };

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s/-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "Riley Dress Beige" + BEIGE → IVORY = "Riley Dress Ivory". */
function relabel(label: string, from: string, to: string): string {
  const re = new RegExp(`\\b${escapeRe(from)}\\b`, "i");
  return re.test(label) ? label.replace(re, titleCase(to)) : label;
}

async function renamedTo(pool: Pool, productId: string, colour: string): Promise<string | null> {
  const r = await pool.query<{ from_colour: string; to_colour: string }>(
    `SELECT from_colour, to_colour FROM colour_renames WHERE shopify_product_id = $1 ORDER BY created_at`,
    [productId],
  );
  let c = norm(colour);
  let hit: string | null = null;
  for (let hop = 0; hop < 5; hop++) {
    const next = [...r.rows].reverse().find((x) => norm(x.from_colour) === c);
    if (!next || norm(next.to_colour) === c) break;
    c = norm(next.to_colour);
    hit = c;
  }
  return hit;
}

function pick(items: CatalogItem[], colour: string, size: string): CatalogItem | null {
  const same = items.filter((i) => norm(i.color) === colour);
  const inStock = (i: CatalogItem) => i.availability === "in stock";
  return (
    same.find((i) => norm(i.size) === norm(size) && inStock(i)) ??
    same.find(inStock) ??
    same.find((i) => norm(i.size) === norm(size)) ??
    same[0] ??
    null
  );
}

/** Which live catalog item a stale tag should point at, or why it can't be decided. */
export async function replacementFor(pool: Pool, old: CatalogItem): Promise<{ item: CatalogItem } | { why: string }> {
  if (!old.groupId) return { why: "the catalog item has no product" };
  const live = (await catalogGroupItems(old.groupId)).filter((i) => i.visibility === "published");
  if (!live.length) return { why: "the product has nothing live in the Meta catalog" };
  const colours = [...new Set(live.map((i) => norm(i.color)))];
  const want = norm(old.color);
  let colour: string | null = colours.includes(want) ? want : null;
  if (!colour) {
    const to = await renamedTo(pool, old.groupId, old.color);
    if (to && colours.includes(to)) colour = to;
  }
  if (!colour && colours.length === 1) colour = colours[0];
  if (!colour) return { why: `${old.color || "its colour"} is gone and the new colour is not certain (${colours.join(", ")})` };
  const item = pick(live, colour, old.size);
  return item ? { item } : { why: "no live item in that colour" };
}

/**
 * Check (and fix) the tags of posts that still have an Instagram target to
 * publish. `postIds` limits it to those posts; otherwise every open or
 * approved post scheduled from 6 hours ago on.
 */
export async function refreshStaleTags(pool: Pool, opts: { postIds?: string[] } = {}): Promise<{ checked: number; fixed: TagFix[]; stuck: TagStuck[] }> {
  const vals: unknown[] = [];
  let where = `p.status IN ('draft','changes_requested','approved','publishing','partly_published','failed')
               AND (p.scheduled_at IS NULL OR p.scheduled_at > now() - interval '6 hours')`;
  if (opts.postIds?.length) {
    vals.push(opts.postIds);
    where = `p.id = ANY($1::uuid[])`;
  }
  const tags = await pool.query<{ id: string; post_id: string; meta_product_id: string; label: string }>(
    `SELECT t.id::text, t.post_id::text, t.meta_product_id, t.label
       FROM marketing_post_tags t
       JOIN marketing_posts p ON p.id = t.post_id
      WHERE ${where}
        AND EXISTS (SELECT 1 FROM marketing_post_targets g
                     WHERE g.post_id = p.id AND g.provider = 'instagram' AND g.status NOT IN ('published','skipped'))`,
    vals,
  );
  const fixed: TagFix[] = [];
  const stuck: TagStuck[] = [];
  const items = new Map<string, CatalogItem | null>();
  const swaps = new Map<string, { item: CatalogItem } | { why: string }>();

  for (const t of tags.rows) {
    if (!items.has(t.meta_product_id)) items.set(t.meta_product_id, await catalogItem(t.meta_product_id));
    const old = items.get(t.meta_product_id) ?? null;
    if (old?.visibility === "published") continue;
    if (!old) {
      stuck.push({ postId: t.post_id, tagId: t.id, label: t.label, why: "Meta no longer has this item" });
      continue;
    }
    if (!swaps.has(old.id)) swaps.set(old.id, await replacementFor(pool, old));
    const swap = swaps.get(old.id)!;
    if ("why" in swap) {
      stuck.push({ postId: t.post_id, tagId: t.id, label: t.label, why: swap.why });
      continue;
    }
    const label = relabel(t.label, old.color, swap.item.color);
    await pool.query(`UPDATE marketing_post_tags SET meta_product_id = $2, label = $3 WHERE id = $1::uuid`, [t.id, swap.item.id, label]);
    fixed.push({ postId: t.post_id, tagId: t.id, from: old.id, to: swap.item.id, oldLabel: t.label, label });
  }
  for (const f of fixed) console.log(`[social] tag ${f.oldLabel} → ${f.label} (${f.from} → ${f.to}) on post ${f.postId}`);
  for (const s of stuck) console.warn(`[social] stale tag ${s.label} on post ${s.postId}: ${s.why}`);
  return { checked: tags.rows.length, fixed, stuck };
}
