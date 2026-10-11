/**
 * "Sync ads" worker job (job_type 'shopify_ads_sync'), started from
 * Integrations → Shopify.
 *
 *  1. Sales channels — every active product (gift cards aside) is published to
 *     every Shopify sales channel except POS (Carbon POS is not Shopify POS).
 *  2. Google — every Merchant Center listing gets the custom labels of the ad
 *     product groups it belongs to, and loses labels of groups it left
 *     (sold out, renamed, re-typed). Any Google campaign filtering on a label
 *     picks the products up automatically.
 *  3. Meta — each group's catalog product set is created / its filter updated.
 *  4. Report — per group: products, listings, Meta count, and which Google
 *     campaigns / Meta ad sets advertise it.
 */
import type { Pool } from "pg";
import { resolveShopContext, salesChannelPublicationIds, publishToPublication, type ShopCtx } from "@/lib/server/shopify-write";
import { runShopifyGraphql } from "@/lib/shopify";
import {
  loadAdGroups,
  groupMatchesProduct,
  memberVariants,
  metaFilterFor,
  type AdProductGroup,
  type GroupSyncResult,
  type ShopProduct,
} from "@/lib/server/ad-product-groups";
import {
  googleConfigured,
  googleAdsConfigured,
  listGmcListings,
  setGmcLabels,
  clearGmcLabels,
  googleCampaignLabelUse,
  type LabelUse,
} from "@/lib/server/google-merchant";
import {
  metaConfigured,
  catalogProductCount,
  upsertProductSet,
  productSetCount,
  metaProductSetUse,
  type SetUse,
} from "@/lib/server/meta-catalog";

async function progress(pool: Pool, jobId: string, pct: number, message: string) {
  await pool.query(
    `UPDATE sync_jobs SET progress_pct = $2, progress_done = $2, progress_total = 100,
            progress_message = $3, updated_at = now() WHERE id = $1::uuid`,
    [jobId, Math.max(0, Math.min(100, Math.round(pct))), message],
  );
}

type RawProduct = {
  id: string;
  title: string;
  productType: string;
  isGiftCard: boolean;
  resourcePublicationsCount?: { count: number };
  variants: { nodes: Array<{ id: string; inventoryQuantity: number | null }> };
};

const num = (gid: string) => gid.split("/").pop() || gid;

async function activeProducts(ctx: ShopCtx): Promise<Array<ShopProduct & { gid: string; isGiftCard: boolean; pubs: number }>> {
  const out: Array<ShopProduct & { gid: string; isGiftCard: boolean; pubs: number }> = [];
  let after: string | null = null;
  for (let page = 0; page < 200; page++) {
    const res = (await runShopifyGraphql<{
      products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawProduct[] };
    }>({
      shop: ctx.shop,
      token: ctx.token,
      apiVersion: ctx.apiVersion,
      query: `query($after: String) {
        products(first: 50, after: $after, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          nodes { id title productType isGiftCard resourcePublicationsCount { count }
                  variants(first: 250) { nodes { id inventoryQuantity } } }
        }
      }`,
      variables: { after },
    })) as { ok: boolean; data?: { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawProduct[] } } | null };
    const conn = res.data?.products;
    if (!conn) throw new Error("Could not read products from Shopify");
    for (const p of conn.nodes) {
      out.push({
        gid: p.id,
        id: num(p.id),
        title: p.title,
        productType: p.productType || "",
        isGiftCard: p.isGiftCard,
        pubs: p.resourcePublicationsCount?.count ?? 0,
        variants: p.variants.nodes.map((v) => ({ id: num(v.id), qty: v.inventoryQuantity ?? 0 })),
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

async function pool20<T>(items: T[], fn: (x: T) => Promise<void>, size = 20) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

export type AdsSyncResult = {
  products: number;
  channels: { names: string[]; published: number; failed: number };
  google: { configured: boolean; listings: number; labelled: number; cleared: number; failed: number; errors: string[] };
  meta: { configured: boolean; catalog: number | null };
  groups: Array<{ slug: string; name: string } & GroupSyncResult>;
  warnings: string[];
};

export async function executeShopifyAdsSync(pool: Pool, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE sync_jobs SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1::uuid`,
    [jobId],
  );
  const warnings: string[] = [];
  try {
    const ctx = await resolveShopContext();
    if (!ctx) throw new Error("Shopify is not connected");

    await progress(pool, jobId, 3, "Reading products from Shopify");
    const products = await activeProducts(ctx);

    // 1. Sales channels
    await progress(pool, jobId, 15, "Checking sales channels");
    const pubs = await salesChannelPublicationIds(ctx);
    const pubIds = pubs.map((p) => p.id);
    let published = 0;
    let pubFailed = 0;
    for (const p of products) {
      if (p.isGiftCard || p.pubs >= pubIds.length) continue;
      const r = await publishToPublication(ctx, p.gid, pubIds);
      if (r.ok) published++;
      else {
        pubFailed++;
        if (warnings.length < 20) warnings.push(`Publish ${p.title}: ${r.error}`);
      }
    }

    // 2. Group membership
    const groups = await loadAdGroups(pool, true);
    const bySlug = new Map(groups.map((g) => [g.slug, g]));
    const stats = new Map<string, { products: number; variants: Set<string> }>();
    for (const g of groups) stats.set(g.slug, { products: 0, variants: new Set() });
    const desired = new Map<string, Record<number, string>>(); // variant id → slot → value
    const owner = new Map<string, string>(); // `${slot}` → value already claimed, for clash warnings
    for (const p of products) {
      for (const g of groups) {
        if (!groupMatchesProduct(g, p, bySlug)) continue;
        const vs = memberVariants(g, p);
        if (!vs.length) continue;
        const st = stats.get(g.slug)!;
        st.products++;
        vs.forEach((v) => st.variants.add(v));
        if (g.google_label_slot === null || !g.google_label_value) continue;
        for (const v of vs) {
          const cur = desired.get(v) || {};
          const prev = cur[g.google_label_slot];
          if (prev && prev !== g.google_label_value) {
            const key = `${g.google_label_slot}:${prev}:${g.google_label_value}`;
            if (!owner.has(key)) {
              owner.set(key, "1");
              warnings.push(
                `Groups "${prev}" and "${g.google_label_value}" both use Google label slot ${g.google_label_slot} for some products — the first group (by order) wins. Give one of them a different slot.`,
              );
            }
            continue;
          }
          cur[g.google_label_slot] = g.google_label_value;
          desired.set(v, cur);
        }
      }
    }

    // 3. Google Merchant Center labels
    const google: AdsSyncResult["google"] = { configured: googleConfigured(), listings: 0, labelled: 0, cleared: 0, failed: 0, errors: [] };
    const listingsPerValue = new Map<string, number>();
    if (google.configured) {
      await progress(pool, jobId, 30, "Reading Google Merchant Center listings");
      const listings = await listGmcListings();
      google.listings = listings.length;
      const managed = [...new Set(groups.map((g) => g.google_label_slot).filter((s): s is number => s !== null))];
      const todo: Array<{ l: (typeof listings)[number]; want: Record<number, string> }> = [];
      for (const l of listings) {
        const m = /^shopify_[A-Z]{2}_(\d+)_(\d+)$/.exec(l.offerId);
        if (!m) continue;
        const want = desired.get(m[2]) || {};
        for (const v of Object.values(want)) listingsPerValue.set(v, (listingsPerValue.get(v) || 0) + 1);
        const differs = managed.some((s) => (want[s] ?? null) !== (l.labels[s] ? l.labels[s]!.toLowerCase() : null));
        if (differs) todo.push({ l, want });
      }
      let n = 0;
      await pool20(todo, async ({ l, want }) => {
        const r = Object.keys(want).length ? await setGmcLabels(l, want) : await clearGmcLabels(l);
        if (r.ok) {
          if (Object.keys(want).length) google.labelled++;
          else google.cleared++;
        }
        if (!r.ok) {
          google.failed++;
          if (google.errors.length < 5) google.errors.push(`${l.offerId}: ${r.error}`);
        }
        n++;
        if (n % 100 === 0) await progress(pool, jobId, 30 + (n / todo.length) * 40, `Google: updating labels ${n}/${todo.length}`);
      });
    } else {
      warnings.push("Google Merchant Center is not connected (GOOGLE_ADS_CLIENT_ID / _SECRET / _REFRESH_TOKEN) — Google labels skipped.");
    }

    // 4. Meta product sets
    const meta: AdsSyncResult["meta"] = { configured: metaConfigured(), catalog: null };
    const metaCounts = new Map<string, number>();
    let setUse: SetUse[] = [];
    if (meta.configured) {
      await progress(pool, jobId, 75, "Updating Meta product sets");
      for (const g of groups) {
        if (!g.meta_set_name) continue;
        try {
          const id = await upsertProductSet(g.meta_set_id, g.meta_set_name, metaFilterFor(g, bySlug));
          if (id !== g.meta_set_id) {
            await pool.query(`UPDATE ad_product_groups SET meta_set_id = $2, updated_at = now() WHERE id = $1::uuid`, [g.id, id]);
            g.meta_set_id = id;
          }
        } catch (e) {
          warnings.push(`Meta set "${g.meta_set_name}": ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Give Meta a moment to re-evaluate updated filters before counting.
      await new Promise((r) => setTimeout(r, 8000));
      meta.catalog = await catalogProductCount().catch(() => null);
      for (const g of groups) {
        if (g.meta_set_id) metaCounts.set(g.slug, await productSetCount(g.meta_set_id).catch(() => -1));
      }
      setUse = await metaProductSetUse().catch((e) => {
        warnings.push(`Meta ad sets: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      });
    } else {
      warnings.push("Meta is not connected (META_SYSTEM_USER_TOKEN) — Meta product sets skipped.");
    }

    // 5. Which campaigns use each group
    await progress(pool, jobId, 90, "Checking which campaigns use each group");
    let labelUse: LabelUse[] = [];
    if (googleAdsConfigured()) {
      labelUse = await googleCampaignLabelUse().catch((e) => {
        warnings.push(`Google Ads: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      });
    }

    const at = new Date().toISOString();
    const groupResults: AdsSyncResult["groups"] = [];
    for (const g of groups) {
      const st = stats.get(g.slug)!;
      const gc = g.google_label_value
        ? [...new Set(labelUse.filter((u) => u.value === g.google_label_value && (u.slot === g.google_label_slot || u.slot < 0)).map((u) => `${u.campaign} (${u.status.toLowerCase()})`))]
        : [];
      const ma = g.meta_set_id
        ? [...new Set(setUse.filter((u) => u.productSetId === g.meta_set_id).map((u) => `${u.campaign} › ${u.adSet} (${u.status.toLowerCase()})`))]
        : [];
      const gw: string[] = [];
      if (st.products === 0) gw.push("No products match this group's rules right now.");
      const res: GroupSyncResult = {
        at,
        products: st.products,
        variants: st.variants.size,
        google_listings: g.google_label_value && google.configured ? listingsPerValue.get(g.google_label_value) ?? 0 : null,
        meta_count: metaCounts.has(g.slug) ? metaCounts.get(g.slug)! : null,
        google_campaigns: gc,
        meta_ad_sets: ma,
        warnings: gw,
      };
      await pool.query(`UPDATE ad_product_groups SET last_sync = $2::jsonb WHERE id = $1::uuid`, [g.id, JSON.stringify(res)]);
      groupResults.push({ slug: g.slug, name: g.name, ...res });
    }

    const result: AdsSyncResult = {
      products: products.length,
      channels: { names: pubs.map((p) => p.name), published, failed: pubFailed },
      google,
      meta,
      groups: groupResults,
      warnings,
    };
    const summary = [
      `${products.length} products`,
      published ? `${published} added to sales channels` : "all on every sales channel",
      google.configured ? `Google: ${google.labelled + google.cleared} listings updated` : null,
      meta.configured ? `Meta: ${groupResults.filter((g) => g.meta_count !== null).length} product sets` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    await pool.query(
      `UPDATE sync_jobs SET status = 'completed', progress_pct = 100, progress_done = 100, progress_total = 100,
              progress_message = $2, finished_at = now(), updated_at = now(),
              payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('result', $3::jsonb)
        WHERE id = $1::uuid`,
      [jobId, summary, JSON.stringify(result)],
    );
  } catch (e) {
    await pool.query(
      `UPDATE sync_jobs SET status = 'failed', error = $2, finished_at = now(), updated_at = now() WHERE id = $1::uuid`,
      [jobId, e instanceof Error ? e.message : String(e)],
    );
  }
}

export type { AdProductGroup };
