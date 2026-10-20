/**
 * Which networks are server farms, which visitors are automation, and which
 * crawlers must be let through. Pure data + small helpers (unit-tested in
 * scripts/test-carbon-shield.ts).
 */

/**
 * Hosting / cloud networks. Real shoppers do not browse from these; bots and
 * scrapers do. Checked by ASN (from the IP data), so it covers every range the
 * provider announces.
 */
export const DATACENTER_ASNS = new Map<number, string>([
  [16509, "Amazon AWS"],
  [14618, "Amazon AWS"],
  [8987, "Amazon AWS"],
  [396982, "Google Cloud"],
  [8075, "Microsoft Azure"],
  [14061, "DigitalOcean"],
  [16276, "OVH"],
  [24940, "Hetzner"],
  [213230, "Hetzner"],
  [212317, "Hetzner"],
  [63949, "Linode / Akamai Cloud"],
  [31898, "Oracle Cloud"],
  [20473, "Vultr"],
  [45102, "Alibaba Cloud"],
  [37963, "Alibaba Cloud"],
  [132203, "Tencent Cloud"],
  [45090, "Tencent Cloud"],
  [136907, "Huawei Cloud"],
  [55990, "Huawei Cloud"],
  [51167, "Contabo"],
  [40021, "Contabo"],
  [60781, "Leaseweb"],
  [28753, "Leaseweb"],
  [16265, "Leaseweb"],
  [30633, "Leaseweb"],
  [12876, "Scaleway"],
  [9009, "M247"],
  [60068, "Datacamp / CDN77"],
  [212238, "Datacamp / CDN77"],
  [47583, "Hostinger"],
  [8560, "IONOS"],
  [36352, "ColoCrossing"],
  [8100, "QuadraNet"],
  [53667, "FranTech / BuyVM"],
  [22612, "Namecheap"],
  [29802, "HIVELOCITY"],
  [46562, "Performive"],
  [62904, "Eonix"],
  [54290, "Hostwinds"],
  [19318, "Interserver"],
  [46844, "Sharktech"],
  [202425, "IP Volume"],
  [23470, "ReliableSite"],
  [397423, "Tier.Net"],
  [32613, "iWeb"],
  [26496, "GoDaddy"],
  [398101, "GoDaddy"],
  [46606, "Unified Layer"],
  [210644, "Aeza"],
  [44477, "Stark Industries"],
]);

/**
 * Networks real people come through even though they are big infrastructure
 * companies: iCloud Private Relay (Akamai, Cloudflare, Fastly egress), the
 * Cloudflare WARP app, Apple itself, Meta (its crawler is handled separately).
 * Never treated as server farms, whatever their name says.
 */
const NEVER_DATACENTER = new Set<number>([13335, 20940, 16625, 36183, 12222, 54113, 714, 6185, 32934]);

/**
 * Privacy relays whose exit addresses the free IP data places in the wrong
 * country (iCloud Private Relay via Akamai / Cloudflare / Fastly, Cloudflare
 * WARP): an iPhone in Orlando can look like Mexico or Guam. The country check
 * is skipped for them; Blockify's own geolocation still applies.
 */
export const RELAY_ASNS = new Set<number>([13335, 20940, 16625, 36183, 12222, 54113]);

/** Words that, in a network owner's name, mean a hosting company. Conservative on purpose. */
const HOSTING_WORDS = /\b(hosting|hoster|data ?cent(?:er|re)s?|datacenter|vps|colocation|colo\b|dedicated servers?|server ?farm|cloud ?servers?|virtual servers?)\b/i;

/** "Amazon AWS" etc. when the network is a server farm, else null. */
export function datacenterLabel(asn: number | null, org: string | null): string | null {
  if (asn && NEVER_DATACENTER.has(asn)) return null;
  if (asn && DATACENTER_ASNS.has(asn)) return DATACENTER_ASNS.get(asn) ?? "Hosting";
  if (org && HOSTING_WORDS.test(org)) return org;
  return null;
}

/** User agents of tools, scripts and headless browsers — not people. */
const AUTOMATION_UA =
  /HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium|WebDriver|python-requests|python-urllib|aiohttp|httpx|\bcurl\/|\bWget\b|Go-http-client|okhttp|axios\/|node-fetch|undici|\bJava\/|libwww|Scrapy|Apache-HttpClient|HttpClient|colly|Nutch|Electron\/|AhrefsBot|SemrushBot|MJ12bot|DotBot|PetalBot|Bytespider|GPTBot|ClaudeBot|CCBot|DataForSeoBot|BLEXBot|serpstatbot|YandexBot|Baiduspider|Sogou|\bspider\b|crawler|scraper/i;

export function isAutomationUa(ua: string): boolean {
  return AUTOMATION_UA.test(ua);
}

/** A user agent that CLAIMS to be a major crawler (must then come from that crawler's network). */
export function claimedCrawler(ua: string): "google" | "bing" | "apple" | "meta" | "pinterest" | "duckduckgo" | null {
  if (/Googlebot|AdsBot-Google|Mediapartners-Google|Storebot-Google|Google-InspectionTool|GoogleOther|Google-Extended|FeedFetcher-Google|Google-Read-Aloud|APIs-Google/i.test(ua)) return "google";
  if (/bingbot|BingPreview|msnbot|adidxbot/i.test(ua)) return "bing";
  if (/Applebot/i.test(ua)) return "apple";
  if (/facebookexternalhit|Facebot|meta-externalagent|meta-externalfetcher|meta-webindexer/i.test(ua)) return "meta";
  if (/Pinterestbot|Pinterest\/0\./i.test(ua)) return "pinterest";
  if (/DuckDuckBot|DuckAssistBot/i.test(ua)) return "duckduckgo";
  return null;
}
