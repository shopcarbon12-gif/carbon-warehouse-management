/**
 * Carbon Shield check — what /api/shield/check runs for every storefront page
 * view: look the visitor up, decide, log it, answer the theme script.
 *
 * Fast path only: settings and rules are cached for 30 s, the IP data lives in
 * memory, and the log write is not awaited. Fails open — any error means the
 * visitor is allowed.
 */
import type { Pool } from "pg";
import { getIpDb, ipv4ToInt, lookupIp } from "./ipdb";
import { decide, type ShieldRule, type ShieldSettings } from "./verdict";
import { recordPageView, type SignedCustomer } from "@/lib/server/visitors/record";

export const SHIELD_DEFAULTS: ShieldSettings = {
  mode: "monitor",
  allowedCountries: ["US", "CA"],
  blockCountries: true,
  blockDatacenter: true,
  blockAutomation: true,
  blockFast: true,
  maxPagesPerMinute: 40,
  silencePixels: true,
};

type SettingsRow = {
  mode: ShieldSettings["mode"];
  allowed_countries: string[];
  block_countries: boolean;
  block_datacenter: boolean;
  block_automation: boolean;
  block_fast: boolean;
  max_pages_per_minute: number;
  silence_pixels: boolean;
};

export function settingsFromRow(r: SettingsRow | undefined): ShieldSettings {
  if (!r) return SHIELD_DEFAULTS;
  return {
    mode: r.mode,
    allowedCountries: r.allowed_countries ?? [],
    blockCountries: r.block_countries,
    blockDatacenter: r.block_datacenter,
    blockAutomation: r.block_automation,
    blockFast: r.block_fast,
    maxPagesPerMinute: r.max_pages_per_minute,
    silencePixels: r.silence_pixels,
  };
}

let config: { settings: ShieldSettings; rules: ShieldRule[]; at: number } | null = null;
const CONFIG_TTL_MS = 30_000;

export async function getShieldConfig(pool: Pool): Promise<{ settings: ShieldSettings; rules: ShieldRule[] }> {
  if (config && Date.now() - config.at < CONFIG_TTL_MS) return config;
  try {
    const [s, r] = await Promise.all([
      pool.query<SettingsRow>(`SELECT * FROM shield_settings WHERE id = 1`),
      pool.query<ShieldRule>(`SELECT kind, value, action FROM shield_rules ORDER BY id`),
    ]);
    config = { settings: settingsFromRow(s.rows[0]), rules: r.rows, at: Date.now() };
  } catch (e) {
    console.warn("[shield] config load failed:", e instanceof Error ? e.message : e);
    config = { settings: config?.settings ?? { ...SHIELD_DEFAULTS, mode: "off" }, rules: config?.rules ?? [], at: Date.now() };
  }
  return config;
}

/** Drop the cache so a saved setting / rule applies to the very next check. */
export function invalidateShieldConfig(): void {
  config = null;
}

// ── Pages-per-minute counter (in memory; one web process) ──────────────────

const hits = new Map<string, number[]>();
let lastSweep = 0;

function countHit(key: string, now: number): number {
  const cutoff = now - 60_000;
  const arr = (hits.get(key) ?? []).filter((t) => t > cutoff);
  arr.push(now);
  hits.set(key, arr);
  if (now - lastSweep > 60_000 || hits.size > 50_000) {
    lastSweep = now;
    for (const [k, v] of hits) if (!v.length || v[v.length - 1] <= cutoff) hits.delete(k);
  }
  return arr.length;
}

// ── The check ──────────────────────────────────────────────────────────────

export type CheckBody = {
  /** Visitor id (random, first-party cookie set by the theme script). */
  v?: string;
  /** Page path. */
  p?: string;
  /** Referrer host. */
  r?: string;
  /** navigator.webdriver. */
  wd?: boolean;
  /** Ad click marker: "meta" | "google" | "tiktok" | "". */
  ad?: string;
  /** utm_source. */
  utm?: string;
  /** Page title (Liquid page_title) — for Shopify → Visitors. */
  t?: string;
  /** Product handle on a product page. */
  h?: string;
  /** Logged-in customer, signed by Liquid (lib/server/visitors/record.ts). */
  c?: SignedCustomer;
};

export type CheckAnswer = {
  /** What the theme script must do. */
  action: "allow" | "block";
  /** Shield mode, so the script stays quiet when off. */
  mode: ShieldSettings["mode"];
  /** Minutes the browser may reuse this answer. */
  ttl: number;
  /** Tell Shopify "no tracking" for this visitor (blocked visitors only). */
  silence: boolean;
};

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : "");

function sourceOf(body: CheckBody): string {
  const ad = clip(body.ad, 16);
  if (ad) return `ad:${ad}`;
  const ref = clip(body.r, 120).toLowerCase();
  if (!ref) return "direct";
  if (/(^|\.)shopcarbon\.com$|myshopify\.com$/.test(ref)) return "internal";
  if (/google\./.test(ref)) return "google";
  if (/facebook\.com|fb\.com|messenger\.com/.test(ref)) return "facebook";
  if (/instagram\.com/.test(ref)) return "instagram";
  if (/bing\.com/.test(ref)) return "bing";
  if (/tiktok\.com/.test(ref)) return "tiktok";
  if (/pinterest\./.test(ref)) return "pinterest";
  return "other";
}

export async function runShieldCheck(
  pool: Pool,
  ip: string | null,
  ua: string,
  body: CheckBody,
): Promise<CheckAnswer> {
  const { settings, rules } = await getShieldConfig(pool);
  if (settings.mode === "off") return { action: "allow", mode: "off", ttl: 30, silence: false };

  const now = Date.now();
  const visitorId = clip(body.v, 64) || null;
  const ipInt = ipv4ToInt(ip);
  const perIp = ip ? countHit(`i:${ip}`, now) : 0;
  const perVisitor = visitorId ? countHit(`v:${visitorId}`, now) : 0;

  const db = await getIpDb(pool);
  const info = lookupIp(db, ipInt);
  const verdict = decide(
    {
      ipInt,
      ip,
      ua,
      visitorId,
      webdriver: body.wd === true,
      country: info.country,
      asn: info.asn,
      org: info.org,
      goodBotRange: info.goodBot,
      cloudRange: info.cloud,
      pagesLastMinuteVisitor: perVisitor,
      pagesLastMinuteIp: perIp,
    },
    settings,
    rules,
  );
  const enforce = settings.mode === "enforce";
  const action = enforce && verdict.would === "block" ? "block" : "allow";

  /* One flood source must not fill the log: past 3× the page limit in a
     minute, only every 10th check of that IP is written. */
  const flood = perIp > settings.maxPagesPerMinute * 3;
  if (!flood || perIp % 10 === 0) {
    void pool
      .query(
        `INSERT INTO shield_events
           (visitor_id, ip, country, asn, as_org, verdict, would_verdict, reasons, good_bot, mode, path, referrer_host, source, ad_click, ua)
         VALUES ($1, $2::inet, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          visitorId,
          ipInt !== null ? ip : null,
          info.country,
          info.asn,
          info.org ?? verdict.datacenter,
          action,
          verdict.would,
          verdict.reasons,
          verdict.goodBot,
          settings.mode,
          clip(body.p, 300) || null,
          clip(body.r, 120) || null,
          sourceOf(body),
          clip(body.ad, 16) || null,
          ua.slice(0, 300) || null,
        ],
      )
      .catch((e: unknown) => console.warn("[shield] log write failed:", e instanceof Error ? e.message : e));
  }

  // Shopify → Visitors: real people only (never bots, crawlers or floods).
  if (visitorId && verdict.would === "allow" && !verdict.goodBot && !flood) {
    void recordPageView(pool, {
      visitorId,
      ip: ipInt !== null ? ip : null,
      ua,
      country: info.country,
      asn: info.asn,
      network: info.org,
      source: sourceOf(body),
      ad: clip(body.ad, 16) || null,
      path: clip(body.p, 300) || null,
      title: clip(body.t, 200) || null,
      product: clip(body.h, 200) || null,
      customer: body.c,
    });
  }

  return {
    action,
    mode: settings.mode,
    ttl: action === "block" ? 60 : 30,
    silence: action === "block" && settings.silencePixels,
  };
}
