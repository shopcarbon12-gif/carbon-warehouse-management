/**
 * Carbon Shield unit tests (no network, no database).
 *   npx tsx scripts/test-carbon-shield.ts
 */
import assert from "node:assert/strict";
import { cidrToRange, ipv4ToInt, lookupIp, packIpDb, unpackIpDb } from "@/lib/server/shield/ipdb";
import { datacenterLabel, isAutomationUa, claimedCrawler } from "@/lib/server/shield/networks";
import { decide, type ShieldSettings, type VerdictInput } from "@/lib/server/shield/verdict";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}`);
    throw e;
  }
}

// ── IPv4 helpers ────────────────────────────────────────────────────────────
test("ipv4ToInt", () => {
  assert.equal(ipv4ToInt("0.0.0.0"), 0);
  assert.equal(ipv4ToInt("1.2.3.4"), 16909060);
  assert.equal(ipv4ToInt("255.255.255.255"), 4294967295);
  assert.equal(ipv4ToInt("::ffff:10.0.0.1"), 167772161);
  assert.equal(ipv4ToInt("256.1.1.1"), null);
  assert.equal(ipv4ToInt("2001:db8::1"), null);
  assert.equal(ipv4ToInt(""), null);
});
test("cidrToRange", () => {
  assert.deepEqual(cidrToRange("10.0.0.0/8"), [167772160, 184549375]);
  assert.deepEqual(cidrToRange("66.249.66.7/24"), [ipv4ToInt("66.249.66.0"), ipv4ToInt("66.249.66.255")]);
  assert.deepEqual(cidrToRange("1.2.3.4"), [16909060, 16909060]);
  assert.equal(cidrToRange("1.2.3.4/33"), null);
});

// ── Pack / unpack / lookup ──────────────────────────────────────────────────
const countryCsv = [
  "0.0.0.0,0.255.255.255,ZZ",
  "3.0.0.0,3.255.255.255,US",
  "8.8.8.0,8.8.8.255,US",
  "66.249.64.0,66.249.95.255,US",
  "177.0.0.0,177.255.255.255,BR",
  "2001:db8::,2001:db8::ffff,US",
].join("\n");
const asnCsv = [
  '3.0.0.0,3.255.255.255,16509,"Amazon.com, Inc."',
  '8.8.8.0,8.8.8.255,15169,"Google LLC"',
  '66.249.64.0,66.249.95.255,15169,"Google LLC"',
  '177.0.0.0,177.127.255.255,28573,"Claro NXT"',
  '177.128.0.0,177.255.255.255,99999,"Fast Hosting Ltda"',
].join("\n");
const range = (c: string, l: number) => {
  const r = cidrToRange(c)!;
  return { s: r[0], e: r[1], l };
};
const packed = packIpDb({
  countryCsv,
  asnCsv,
  month: "2026-10",
  good: { rows: [range("66.249.66.0/24", 0)], labels: ["Googlebot"] },
  cloud: { rows: [range("35.190.0.0/17", 0)], labels: ["Google Cloud"] },
});
const db = unpackIpDb(packed.blob);

test("pack/unpack keeps every section", () => {
  assert.equal(db.counts.country, 5);
  assert.equal(db.counts.network, 5);
  assert.equal(db.counts.goodBots, 1);
  assert.equal(db.counts.cloud, 1);
});
test("lookup: AWS address", () => {
  const i = lookupIp(db, ipv4ToInt("3.5.140.1"));
  assert.equal(i.country, "US");
  assert.equal(i.asn, 16509);
  assert.equal(i.org, "Amazon.com, Inc.");
  assert.equal(i.goodBot, null);
});
test("lookup: Googlebot range", () => {
  const i = lookupIp(db, ipv4ToInt("66.249.66.12"));
  assert.equal(i.goodBot, "Googlebot");
  assert.equal(i.asn, 15169);
});
test("lookup: ZZ means unknown, unknown space is empty", () => {
  assert.equal(lookupIp(db, ipv4ToInt("0.1.2.3")).country, null);
  const none = lookupIp(db, ipv4ToInt("200.1.1.1"));
  assert.equal(none.country, null);
  assert.equal(none.asn, null);
});
test("lookup: cloud range + edges", () => {
  assert.equal(lookupIp(db, ipv4ToInt("35.190.0.0")).cloud, "Google Cloud");
  assert.equal(lookupIp(db, ipv4ToInt("35.190.127.255")).cloud, "Google Cloud");
  assert.equal(lookupIp(db, ipv4ToInt("35.190.128.0")).cloud, null);
  assert.equal(lookupIp(db, ipv4ToInt("177.255.255.255")).country, "BR");
});
test("lookup: no data → nothing known", () => {
  assert.deepEqual(lookupIp(null, 1), { country: null, asn: null, org: null, goodBot: null, cloud: null });
});

// ── Networks ───────────────────────────────────────────────────────────────
test("datacenterLabel", () => {
  assert.equal(datacenterLabel(16509, "Amazon.com, Inc."), "Amazon AWS");
  assert.equal(datacenterLabel(99999, "Fast Hosting Ltda"), "Fast Hosting Ltda");
  assert.equal(datacenterLabel(7922, "Comcast Cable Communications, LLC"), null);
  assert.equal(datacenterLabel(21928, "T-Mobile USA, Inc."), null);
  // iCloud Private Relay / Cloudflare WARP — real people.
  assert.equal(datacenterLabel(36183, "Akamai Technologies, Inc."), null);
  assert.equal(datacenterLabel(13335, "Cloudflare, Inc."), null);
});
test("automation + crawler claims", () => {
  assert.ok(isAutomationUa("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0 Safari/537.36"));
  assert.ok(isAutomationUa("python-requests/2.31"));
  assert.ok(!isAutomationUa("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"));
  assert.equal(claimedCrawler("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), "google");
  assert.equal(claimedCrawler("facebookexternalhit/1.1"), "meta");
  assert.equal(claimedCrawler("Mozilla/5.0 (Windows NT 10.0) Chrome/126"), null);
});

// ── Verdicts ───────────────────────────────────────────────────────────────
const S: ShieldSettings = {
  mode: "monitor",
  allowedCountries: ["US", "CA"],
  blockCountries: true,
  blockDatacenter: true,
  blockAutomation: true,
  blockFast: true,
  maxPagesPerMinute: 40,
  silencePixels: true,
};
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
function input(over: Partial<VerdictInput>): VerdictInput {
  return {
    ipInt: ipv4ToInt("73.1.2.3"),
    ip: "73.1.2.3",
    ua: IPHONE,
    visitorId: "a1b2c3d4-0000-4000-8000-000000000000",
    webdriver: false,
    country: "US",
    asn: 7922,
    org: "Comcast Cable Communications, LLC",
    goodBotRange: null,
    cloudRange: null,
    pagesLastMinuteVisitor: 1,
    pagesLastMinuteIp: 1,
    ...over,
  };
}
test("a real shopper in Orlando is allowed", () => {
  const v = decide(input({}), S, []);
  assert.equal(v.would, "allow");
  assert.deepEqual(v.reasons, []);
});
test("Amazon server farm is blocked", () => {
  const v = decide(input({ asn: 16509, org: "Amazon.com, Inc." }), S, []);
  assert.equal(v.would, "block");
  assert.deepEqual(v.reasons, ["datacenter"]);
  assert.equal(v.datacenter, "Amazon AWS");
});
test("Google Cloud by published range is blocked", () => {
  const v = decide(input({ asn: 15169, org: "Google LLC", cloudRange: "Google Cloud" }), S, []);
  assert.deepEqual(v.reasons, ["datacenter"]);
});
test("a country you don't ship to is blocked; Canada is not", () => {
  assert.deepEqual(decide(input({ country: "BR", asn: 28573, org: "Claro NXT" }), S, []).reasons, ["country"]);
  assert.equal(decide(input({ country: "CA" }), S, []).would, "allow");
  assert.equal(decide(input({ country: null }), S, []).would, "allow");
});
test("iCloud Private Relay placed abroad is not a country block", () => {
  assert.equal(decide(input({ country: "GU", asn: 36183, org: "Akamai Technologies, Inc." }), S, []).would, "allow");
  assert.equal(decide(input({ country: "MX", asn: 13335, org: "Cloudflare, Inc." }), S, []).would, "allow");
});
test("real Googlebot is allowed even from Google's network", () => {
  const v = decide(input({ ua: "Mozilla/5.0 (compatible; Googlebot/2.1)", asn: 15169, org: "Google LLC", goodBotRange: "Googlebot" }), S, []);
  assert.equal(v.would, "allow");
  assert.equal(v.goodBot, "Googlebot");
});
test("fake Googlebot from Amazon is blocked", () => {
  const v = decide(input({ ua: "Mozilla/5.0 (compatible; Googlebot/2.1)", asn: 16509, org: "Amazon.com, Inc." }), S, []);
  assert.equal(v.would, "block");
  assert.ok(v.reasons.includes("fake_crawler"));
  assert.ok(v.reasons.includes("datacenter"));
});
test("Meta crawler only from Meta's network", () => {
  assert.equal(decide(input({ ua: "facebookexternalhit/1.1", asn: 32934, org: "Facebook, Inc." }), S, []).goodBot, "Meta crawler");
  assert.equal(decide(input({ ua: "facebookexternalhit/1.1", asn: 14061, org: "DigitalOcean, LLC" }), S, []).would, "block");
});
test("headless browser / webdriver is automation", () => {
  assert.ok(decide(input({ webdriver: true }), S, []).reasons.includes("automation"));
  assert.ok(decide(input({ ua: "HeadlessChrome/126" }), S, []).reasons.includes("automation"));
  assert.ok(decide(input({ ua: "" }), S, []).reasons.includes("automation"));
});
test("too fast", () => {
  assert.ok(decide(input({ pagesLastMinuteVisitor: 41 }), S, []).reasons.includes("too_fast"));
  assert.ok(decide(input({ pagesLastMinuteIp: 161 }), S, []).reasons.includes("too_fast"));
  assert.equal(decide(input({ pagesLastMinuteIp: 120 }), S, []).would, "allow");
});
test("an allow rule beats every check", () => {
  const v = decide(input({ ip: "3.5.140.1", ipInt: ipv4ToInt("3.5.140.1"), asn: 16509, org: "Amazon.com, Inc.", country: "BR" }), S, [
    { kind: "ip", value: "3.5.140.1", action: "allow" },
  ]);
  assert.equal(v.would, "allow");
  assert.deepEqual(v.reasons, ["allow_rule"]);
  const byRef = decide(input({ asn: 16509, org: "Amazon.com, Inc." }), S, [{ kind: "visitor", value: "a1b2c3d4", action: "allow" }]);
  assert.equal(byRef.would, "allow");
  const byRange = decide(input({ asn: 16509, org: "Amazon.com, Inc." }), S, [{ kind: "cidr", value: "73.1.0.0/16", action: "allow" }]);
  assert.equal(byRange.would, "allow");
});
test("a block rule blocks a normal visitor", () => {
  const v = decide(input({}), S, [{ kind: "asn", value: "AS7922", action: "block" }]);
  assert.deepEqual(v.reasons, ["block_rule"]);
});
test("switched-off checks don't fire", () => {
  const off: ShieldSettings = { ...S, blockCountries: false, blockDatacenter: false, blockAutomation: false, blockFast: false };
  const v = decide(input({ country: "BR", asn: 16509, org: "Amazon.com, Inc.", webdriver: true, pagesLastMinuteVisitor: 999 }), off, []);
  assert.equal(v.would, "allow");
});

console.log(`carbon-shield: ${passed} tests passed`);
