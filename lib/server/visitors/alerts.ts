/**
 * Visitor alerts (owner 2026-10-21): a phone/computer notification when
 *  - someone new is on the store              (visitor_new)
 *  - a returning or named visitor is back     (visitor_back)
 *  - someone starts checkout                  (visitor_checkout)
 *  - someone adds to cart                     (visitor_cart, off by default)
 * Sent through the same Web Push as the order alerts (lib/server/web-push.ts),
 * to devices whose Settings › Alerts switches include that kind. Tapping one
 * opens the visitor on Shopify → Visitors.
 *
 * Real visitors only (callers are the Shield-verified recorders). At most one
 * alert per visitor, per visit, per kind, and never more than 60 visitor alerts
 * an hour in total (a flood of fake visitors must not flood the phone).
 * Never throws.
 */
import type { Pool } from "pg";
import { placeWords } from "./geo";
import { sendPush, type PushKind } from "@/lib/server/web-push";
import { decodeEntities, visitorAlertTag } from "./rules";

export type VisitorAlertKind = "visitor_new" | "visitor_back" | "visitor_checkout" | "visitor_cart";
export const MAX_VISITOR_ALERTS_PER_HOUR = 60;

const SOURCES: Record<string, string> = {
  "ad:meta": "Meta ad",
  "ad:google": "Google ad",
  "ad:tiktok": "TikTok ad",
  google: "Google search",
  facebook: "Facebook",
  instagram: "Instagram",
  bing: "Bing",
  tiktok: "TikTok",
  pinterest: "Pinterest",
  other: "another website",
};

export function sourceWords(s: string | null | undefined): string | null {
  if (!s || s === "direct" || s === "internal") return null;
  return SOURCES[s] ?? s;
}

export function pageWords(title: string | null | undefined, path: string | null | undefined): string {
  const t = decodeEntities(title ?? "").replace(/\s*[|–—-]\s*CARBON\s*$/i, "").trim();
  if (t) return t;
  if (!path || path === "/") return "the home page";
  return path;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

let regionNames: Intl.DisplayNames | null = null;
export function countryWords(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export type AlertInput = {
  kind: VisitorAlertKind;
  visitorId: string;
  visit: number;
  /** Nickname, name or email — null for an unknown visitor. */
  label: string | null;
  country: string | null;
  /** From the IP (lib/server/visitors/geo.ts) — city level at best. */
  city?: string | null;
  regionCode?: string | null;
  region?: string | null;
  source: string | null;
  device: string | null;
  pageTitle: string | null;
  path: string | null;
  /** Cart add: product, size, price. Checkout: items so far this visit. */
  product?: string | null;
  variant?: string | null;
  price?: number | null;
  cartItems?: string[];
};

/** Title + body of one alert (pure; unit-tested). */
export function alertText(a: AlertInput): { title: string; body: string } {
  const who = a.label || "A visitor";
  const where = placeWords(a.city ?? null, a.regionCode ?? null, a.region ?? null, countryWords(a.country), a.country) ?? countryWords(a.country);
  const visitNo = a.visit > 1 ? `${ordinal(a.visit)} visit` : null;
  const from = sourceWords(a.source);
  const page = pageWords(a.pageTitle, a.path);
  const money = typeof a.price === "number" ? ` · $${a.price.toFixed(2)}` : "";
  switch (a.kind) {
    case "visitor_new":
      return {
        title: ["New visitor", where, from].filter(Boolean).join(" · "),
        body: [`Looking at ${page}`, a.device].filter(Boolean).join(" · "),
      };
    case "visitor_back":
      return {
        title: `${a.label ? `${a.label} is` : "A visitor is"} back · ${ordinal(a.visit)} visit`,
        body: [`Looking at ${page}`, where, from, a.device].filter(Boolean).join(" · "),
      };
    case "visitor_checkout": {
      const items = a.cartItems ?? [];
      return {
        title: `Started checkout · ${who}`,
        body: [
          items.length ? `${items.length} item${items.length === 1 ? "" : "s"}: ${items.slice(0, 3).join(", ")}${items.length > 3 ? "…" : ""}` : null,
          where, from, visitNo,
        ].filter(Boolean).join(" · ") || "Tap to see their visit",
      };
    }
    case "visitor_cart":
      return {
        title: `Added to cart · ${who}`,
        body: [`${a.product || "A product"}${a.variant ? ` (${a.variant})` : ""}${money}`, where].filter(Boolean).join(" · "),
      };
  }
}

export async function notifyVisitor(pool: Pool, a: AlertInput): Promise<void> {
  try {
    const cap = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM visitor_alerts WHERE at > now() - interval '1 hour'`);
    if (Number(cap.rows[0]?.n ?? 0) >= MAX_VISITOR_ALERTS_PER_HOUR) return;
    const claim = await pool.query(
      `INSERT INTO visitor_alerts (visitor_id, visit, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [a.visitorId, a.visit, a.kind],
    );
    if (!claim.rowCount) return; // already alerted for this visit
    const { title, body } = alertText(a);
    await sendPush(pool, {
      kind: a.kind as PushKind,
      title,
      body,
      url: `/shopify/visitors?visitor=${encodeURIComponent(a.visitorId)}`,
      tag: visitorAlertTag(a.kind, a.visitorId, a.visit),
      // Visitors have their own sounds — not the order ka-ching or the Studio chime (owner, 2026-10-21).
      sound: a.kind === "visitor_checkout" ? "checkout" : "visitor",
    });
  } catch (e) {
    console.warn("[visitors] alert skipped:", e instanceof Error ? e.message : e);
  }
}
