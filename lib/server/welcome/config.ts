/**
 * Email Popup — settings, the Shopify connection, and the two things on the
 * Shopify side that every code shares:
 *  - the shop metafield carbon.welcome_popup — the theme snippet
 *    (snippets/carbon-welcome-popup.liquid) reads on/off, percent, delay and
 *    days from it, so a change in the WMS reaches the store without a deploy;
 *  - the hidden smart collection "Full price (welcome offer)" — every product
 *    with no sale (compare-at) price. Codes discount only these products.
 */
import type { Pool } from "pg";
import { runShopifyGraphql, SHOPIFY_API_VERSION } from "@/lib/shopify";
import { resolveShopContext, type ShopCtx } from "@/lib/server/shopify-write";

export type WelcomeSettings = {
  enabled: boolean;
  percentOff: number;
  validDays: number;
  delaySeconds: number;
  sendEmail: boolean;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

export const WELCOME_DEFAULTS: WelcomeSettings = {
  enabled: false,
  percentOff: 10,
  validDays: 30,
  delaySeconds: 8,
  sendEmail: true,
  updatedAt: null,
  updatedByEmail: null,
};

type SettingsRow = {
  enabled: boolean;
  percent_off: number;
  valid_days: number;
  delay_seconds: number;
  send_email: boolean;
  updated_at: Date;
  updated_by_email: string | null;
};

export async function getWelcomeSettings(pool: Pool): Promise<WelcomeSettings> {
  const r = await pool.query<SettingsRow>(`SELECT * FROM welcome_settings WHERE id = 1`);
  const row = r.rows[0];
  if (!row) return WELCOME_DEFAULTS;
  return {
    enabled: row.enabled,
    percentOff: row.percent_off,
    validDays: row.valid_days,
    delaySeconds: row.delay_seconds,
    sendEmail: row.send_email,
    updatedAt: row.updated_at.toISOString(),
    updatedByEmail: row.updated_by_email,
  };
}

/**
 * The welcome code's Shopify calls run on the version the code is written for
 * (production env can still name an older one, which Shopify floats).
 */
export async function welcomeShopCtx(): Promise<ShopCtx | null> {
  const ctx = await resolveShopContext();
  return ctx ? { ...ctx, apiVersion: SHOPIFY_API_VERSION } : null;
}

type UserError = { field?: string[] | null; message: string; code?: string | null };

export async function welcomeGql<T>(ctx: ShopCtx, query: string, variables?: Record<string, unknown>): Promise<T> {
  const r = await runShopifyGraphql<T>({ ...ctx, query, variables });
  if (!r.ok || !r.data) {
    const msg = Array.isArray(r.errors)
      ? (r.errors as { message?: string }[]).map((e) => e?.message).filter(Boolean).join("; ")
      : "";
    throw new Error(msg || `Shopify returned HTTP ${r.status}`);
  }
  return r.data;
}

export function userErrorText(errs: UserError[] | null | undefined): string {
  return (errs ?? []).map((e) => e.message).join("; ");
}

/** What the theme snippet reads. Keep the keys short — they ship in every page. */
export function themeConfig(s: WelcomeSettings) {
  return { enabled: s.enabled, percent: s.percentOff, delay: s.delaySeconds, validDays: s.validDays };
}

/** Copy the settings to the shop metafield the theme reads. Throws on failure. */
export async function syncWelcomeMetafield(s: WelcomeSettings): Promise<void> {
  const ctx = await welcomeShopCtx();
  if (!ctx) throw new Error("Shopify is not connected");
  const shop = await welcomeGql<{ shop: { id: string } }>(ctx, `{ shop { id } }`);
  const r = await welcomeGql<{ metafieldsSet: { userErrors: UserError[] } }>(
    ctx,
    `mutation WelcomeConfig($m: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $m) { userErrors { field message code } }
    }`,
    {
      m: [
        {
          ownerId: shop.shop.id,
          namespace: "carbon",
          key: "welcome_popup",
          type: "json",
          value: JSON.stringify(themeConfig(s)),
        },
      ],
    },
  );
  const errs = userErrorText(r.metafieldsSet.userErrors);
  if (errs) throw new Error(errs);
}

export const FULL_PRICE_HANDLE = "full-price-welcome";
let fullPriceGid: string | null = null;

/** The hidden "Full price (welcome offer)" smart collection — found, or made once. */
export async function fullPriceCollectionId(ctx: ShopCtx): Promise<string> {
  if (fullPriceGid) return fullPriceGid;
  const found = await welcomeGql<{ collectionByHandle: { id: string } | null }>(
    ctx,
    `query FullPrice($h: String!) { collectionByHandle(handle: $h) { id } }`,
    { h: FULL_PRICE_HANDLE },
  );
  if (found.collectionByHandle) return (fullPriceGid = found.collectionByHandle.id);
  /* IS_PRICE_REDUCED / IS_NOT_SET is product-level: a product counts as full
     price when at least one of its variants has no compare-at price. Today no
     product has one (the flash sale is automatic discounts, which the codes
     never stack with). Created unpublished: it never shows on the store. */
  const made = await welcomeGql<{ collectionCreate: { collection: { id: string } | null; userErrors: UserError[] } }>(
    ctx,
    `mutation FullPriceCreate($i: CollectionInput!) {
      collectionCreate(input: $i) { collection { id } userErrors { field message } }
    }`,
    {
      i: {
        title: "Full price (welcome offer)",
        handle: FULL_PRICE_HANDLE,
        descriptionHtml:
          "<p>Hidden. Every product with no sale (compare-at) price. The email-popup welcome codes discount only these products. Made by the WMS (Shopify → Email Popup).</p>",
        ruleSet: { appliedDisjunctively: false, rules: [{ column: "IS_PRICE_REDUCED", relation: "IS_NOT_SET", condition: "" }] },
      },
    },
  );
  const id = made.collectionCreate.collection?.id;
  if (!id) throw new Error(userErrorText(made.collectionCreate.userErrors) || "Could not create the full-price collection");
  return (fullPriceGid = id);
}
