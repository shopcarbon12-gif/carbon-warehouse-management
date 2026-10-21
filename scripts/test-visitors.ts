/**
 * Shopify → Visitors unit tests (no network, no database).
 *   npx tsx scripts/test-visitors.ts
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanLabel, decodeEntities, describeDevice, shortName, visitorLabel } from "@/lib/server/visitors/rules";
import { verifiedCustomer } from "@/lib/server/visitors/record";
import { alertText, ordinal } from "@/lib/server/visitors/alerts";

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

test("decodeEntities: page titles back to plain text", () => {
  assert.equal(decodeEntities("Men&#39;s Clothing, Jeans &amp; Shoes | CARBON"), "Men's Clothing, Jeans & Shoes | CARBON");
  assert.equal(decodeEntities("&quot;Eden&quot; &lt;3"), '"Eden" <3');
});

test("shortName: First L.", () => {
  assert.equal(shortName("Maria", "lopez"), "Maria L.");
  assert.equal(shortName("Maria", ""), "Maria");
  assert.equal(shortName("", "Lopez"), null);
});

test("describeDevice: phones, tablets, computers and in-app browsers", () => {
  assert.deepEqual(
    describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0"),
    { device: "phone", os: "iOS", browser: "Instagram app" },
  );
  assert.deepEqual(
    describeDevice("Mozilla/5.0 (Linux; Android 14; SM-S918U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36"),
    { device: "phone", os: "Android", browser: "Chrome" },
  );
  assert.equal(describeDevice("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1").device, "tablet");
  assert.deepEqual(
    describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0"),
    { device: "computer", os: "Windows", browser: "Edge" },
  );
  assert.equal(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) [FBAN/FBIOS;FBAV/480.0]").browser, "Facebook app");
  assert.equal(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15").browser, "Safari");
});

test("visitorLabel: nickname, then name, then email, then a short id", () => {
  assert.equal(visitorLabel({ visitor_id: "a1b2c3d4-e5", nickname: "Miami regular", customer_name: "Maria L." }), "Miami regular");
  assert.equal(visitorLabel({ visitor_id: "a1b2c3d4-e5", customer_name: "Maria L.", email: "m@x.com" }), "Maria L.");
  assert.equal(visitorLabel({ visitor_id: "a1b2c3d4-e5", email: "m@x.com" }), "m@x.com");
  assert.equal(visitorLabel({ visitor_id: "a1b2c3d4-e5" }), "Visitor A1B2C3");
});

test("cleanLabel trims, collapses spaces, caps and empties to null", () => {
  assert.equal(cleanLabel("  Blue   dress  ", 60), "Blue dress");
  assert.equal(cleanLabel("   ", 60), null);
  assert.equal(cleanLabel(null, 60), null);
  assert.equal(cleanLabel("x".repeat(80), 60)?.length, 60);
});

test("verifiedCustomer: only Liquid's signature names a shopper", () => {
  process.env.CARBON_WISHLIST_SECRET = "'" + "ab".repeat(32) + "'"; // quoted like the Coolify entry
  const key = "ab".repeat(32);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", key).update(`12345.${ts}`).digest("hex");
  assert.deepEqual(verifiedCustomer({ id: "12345", ts, sig, f: "Maria", l: "Lopez", e: "Maria@Gmail.com" }), {
    id: "12345",
    name: "Maria L.",
    email: "maria@gmail.com",
  });
  assert.equal(verifiedCustomer({ id: "99999", ts, sig, f: "Eve" }), null, "someone else's id");
  assert.equal(verifiedCustomer({ id: "12345", ts, sig: "0".repeat(64) }), null, "made-up signature");
  const old = String(Math.floor(Date.now() / 1000) - 8 * 86400);
  assert.equal(verifiedCustomer({ id: "12345", ts: old, sig: crypto.createHmac("sha256", key).update(`12345.${old}`).digest("hex") }), null, "older than 7 days");
  assert.equal(verifiedCustomer(null), null);
});

const shield = readFileSync(path.join(process.cwd(), "theme/snippets/carbon-shield.liquid"), "utf8");
test("shield snippet: repo copy keeps the secret placeholder; no screen recording, no form reading", () => {
  assert.ok(shield.includes("'__CARBON_WISHLIST_SECRET__'"));
  assert.ok(!/[a-f0-9]{64}/i.test(shield), "no secret in the repo");
  assert.ok(!/addEventListener\(["'](keydown|keyup|keypress|input|mousemove)["']/.test(shield), "no keystroke / mouse tracking");
  assert.ok(!/rrweb|MutationObserver|\.value\b/.test(shield), "no recording, no reading form values");
});
test("shield snippet: sends title / product / signed customer; reports cart adds, checkout, pings; tags the cart", () => {
  assert.ok(shield.includes("t: PAGE.t, h: PAGE.h, c: WHO"));
  for (const k of ['send("cart_add"', 'send("checkout")', 'send("ping")']) assert.ok(shield.includes(k), k);
  assert.ok(shield.includes("_cs_vid"));
  assert.ok(shield.includes('"https://wms.shopcarbon.com/api/shield/event"'));
  assert.ok(shield.includes('if (cached === "b" || test) return;'), "blocked visitors send nothing more");
});

const base = { visitorId: "v1", visit: 1, label: null, country: "US", source: "instagram", device: "phone", pageTitle: "Eden Dress 2 Pieces | CARBON", path: "/products/eden" };
test("alertText: new visitor", () => {
  assert.deepEqual(alertText({ ...base, kind: "visitor_new" }), { title: "New visitor · United States · Instagram", body: "Looking at Eden Dress 2 Pieces · phone" });
  assert.equal(alertText({ ...base, kind: "visitor_new", source: "direct", pageTitle: null, path: "/" }).body, "Looking at the home page · phone");
});
test("alertText: back, checkout, cart", () => {
  assert.equal(alertText({ ...base, kind: "visitor_back", visit: 3, label: "Orlando VIP" }).title, "Orlando VIP is back · 3rd visit");
  assert.equal(alertText({ ...base, kind: "visitor_back", visit: 2 }).title, "A visitor is back · 2nd visit");
  assert.deepEqual(alertText({ ...base, kind: "visitor_checkout", label: "Maria L.", cartItems: ["Eden Dress", "Kyle Cargo Pants"] }), {
    title: "Started checkout · Maria L.",
    body: "2 items: Eden Dress, Kyle Cargo Pants",
  });
  assert.equal(alertText({ ...base, kind: "visitor_cart", product: "73 Shorts Set", variant: "STONE / L", price: 56.7 }).body, "73 Shorts Set (STONE / L) · $56.70");
  assert.equal(ordinal(11), "11th");
  assert.equal(ordinal(22), "22nd");
});
test("service worker: Carbon logo, kept until dismissed", () => {
  const sw = readFileSync(path.join(process.cwd(), "public/sw.js"), "utf8");
  assert.ok(sw.includes('icon: "/carbon-notify-icon.png"') && sw.includes('badge: "/carbon-notify-badge.png"'));
  assert.ok(sw.includes("requireInteraction: true"));
});

console.log(`visitors: ${passed} tests passed`);
