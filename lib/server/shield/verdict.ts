/**
 * Carbon Shield verdict — pure, so it can be unit-tested
 * (scripts/test-carbon-shield.ts). The order matters:
 *   1. an "allow" rule always wins (a customer someone let in by hand);
 *   2. verified crawlers (Google, Bing, Apple, Meta) are always let through,
 *      or Google Shopping and the Meta catalog stop updating;
 *   3. a "block" rule;
 *   4. then the automatic checks — a fake crawler, automation, a server farm,
 *      a country you don't ship to, a visitor loading pages too fast.
 * Every reason found is recorded (the dashboard shows them all); one is enough
 * to block.
 */
import { cidrToRange } from "./ipdb";
import { RELAY_ASNS, claimedCrawler, datacenterLabel, isAutomationUa } from "./networks";

export type ShieldMode = "off" | "monitor" | "enforce";

export type ShieldSettings = {
  mode: ShieldMode;
  allowedCountries: string[];
  blockCountries: boolean;
  blockDatacenter: boolean;
  blockAutomation: boolean;
  blockFast: boolean;
  maxPagesPerMinute: number;
  silencePixels: boolean;
};

export type ShieldRuleKind = "ip" | "cidr" | "asn" | "country" | "ua" | "visitor";
export type ShieldRule = { kind: ShieldRuleKind; value: string; action: "allow" | "block" };

export type VerdictInput = {
  ipInt: number | null;
  ip: string | null;
  ua: string;
  visitorId: string | null;
  webdriver: boolean;
  country: string | null;
  asn: number | null;
  org: string | null;
  /** IP is inside a published crawler range (label), from the IP data. */
  goodBotRange: string | null;
  /** IP is inside a published cloud customer range (label). */
  cloudRange: string | null;
  pagesLastMinuteVisitor: number;
  pagesLastMinuteIp: number;
};

export type Verdict = {
  /** What enforce mode does with this visitor. */
  would: "allow" | "block";
  reasons: string[];
  /** Set when the visitor is a verified (or harmless unverifiable) crawler. */
  goodBot: string | null;
  /** The server-farm label when the network is one. */
  datacenter: string | null;
};

function ruleMatches(r: ShieldRule, v: VerdictInput): boolean {
  const val = r.value.trim();
  switch (r.kind) {
    case "ip":
      return !!v.ip && v.ip === val;
    case "cidr": {
      const range = cidrToRange(val);
      return !!range && v.ipInt !== null && v.ipInt >= range[0] && v.ipInt <= range[1];
    }
    case "asn":
      return v.asn !== null && String(v.asn) === val.replace(/^AS/i, "");
    case "country":
      return !!v.country && v.country.toUpperCase() === val.toUpperCase();
    case "ua":
      return !!val && v.ua.toLowerCase().includes(val.toLowerCase());
    case "visitor":
      return !!v.visitorId && v.visitorId.toLowerCase().startsWith(val.toLowerCase()) && val.length >= 6;
  }
}

/** A crawler claim backed by its owner's published ranges / network. */
function verifiedCrawler(v: VerdictInput): string | null {
  const claim = claimedCrawler(v.ua);
  if (v.goodBotRange) {
    // Inside Google / Bing / Apple published ranges — trust it whatever the user agent.
    return v.goodBotRange;
  }
  /* Meta's own network: its crawlers (link previews, ad review, the catalog's
     meta-webindexer) run a real Chrome there, so they look like automation —
     blocking them breaks the catalog and gets ads rejected. */
  if (v.asn === 32934) return "Meta crawler";
  // Pinterest and DuckDuckGo publish no IPv4 list we can check against; their
  // crawlers do not run the theme script anyway. Let them through.
  if (claim === "pinterest") return "Pinterest crawler";
  if (claim === "duckduckgo") return "DuckDuckGo crawler";
  return null;
}

export function decide(v: VerdictInput, s: ShieldSettings, rules: ShieldRule[]): Verdict {
  const datacenter = v.cloudRange ?? datacenterLabel(v.asn, v.org);
  const base = { goodBot: null as string | null, datacenter };

  if (rules.some((r) => r.action === "allow" && ruleMatches(r, v))) {
    return { ...base, would: "allow", reasons: ["allow_rule"] };
  }
  const crawler = verifiedCrawler(v);
  if (crawler) return { ...base, goodBot: crawler, would: "allow", reasons: ["good_bot"] };

  const reasons: string[] = [];
  if (rules.some((r) => r.action === "block" && ruleMatches(r, v))) reasons.push("block_rule");

  const claim = claimedCrawler(v.ua);
  if (claim && claim !== "pinterest" && claim !== "duckduckgo") reasons.push("fake_crawler");

  if (s.blockAutomation && (v.webdriver || !v.ua.trim() || isAutomationUa(v.ua))) reasons.push("automation");
  if (s.blockDatacenter && datacenter) reasons.push("datacenter");
  if (
    s.blockCountries &&
    v.country &&
    !(v.asn !== null && RELAY_ASNS.has(v.asn)) &&
    s.allowedCountries.length > 0 &&
    !s.allowedCountries.map((c) => c.toUpperCase()).includes(v.country.toUpperCase())
  ) {
    reasons.push("country");
  }
  if (
    s.blockFast &&
    (v.pagesLastMinuteVisitor > s.maxPagesPerMinute || v.pagesLastMinuteIp > s.maxPagesPerMinute * 4)
  ) {
    reasons.push("too_fast");
  }
  return { ...base, would: reasons.length ? "block" : "allow", reasons };
}
