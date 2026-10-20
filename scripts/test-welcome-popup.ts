/**
 * Email Popup unit tests (no network, no database).
 *   npx tsx scripts/test-welcome-popup.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EMAIL_COPY,
  MIN_OPEN_MS,
  emailDomain,
  formOf,
  langOf,
  longDate,
  normalizeEmail,
  screenRequest,
  welcomeCode,
} from "@/lib/server/welcome/rules";
import { buildWelcomeEmail } from "@/lib/server/welcome/email";
import { themeConfig, WELCOME_DEFAULTS } from "@/lib/server/welcome/config";

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

// ── Emails ──────────────────────────────────────────────────────────────────
test("normalizeEmail keeps real addresses, lower-cased and trimmed", () => {
  assert.equal(normalizeEmail("  Maria.Lopez@Gmail.com "), "maria.lopez@gmail.com");
  assert.equal(normalizeEmail("a+carbon@sub.example.co.uk"), "a+carbon@sub.example.co.uk");
  assert.equal(normalizeEmail("o'neil@icloud.com"), "o'neil@icloud.com");
});
test("normalizeEmail rejects what can't be an address", () => {
  for (const bad of ["", "maria", "maria@", "@gmail.com", "maria@gmail", "maria@gmail.c", "maria@@gmail.com", "ma ria@gmail.com",
    ".maria@gmail.com", "maria.@gmail.com", "ma..ria@gmail.com", "maria@-gmail.com", "maria@1.2.3.4", "x".repeat(65) + "@gmail.com", 42, null]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
});
test("emailDomain", () => {
  assert.equal(emailDomain("maria@gmail.com"), "gmail.com");
});

// ── Codes ───────────────────────────────────────────────────────────────────
test("welcomeCode: WELCOME{percent}-XXXXXX from the no-look-alike alphabet", () => {
  for (let i = 0; i < 200; i++) assert.match(welcomeCode(15), /^WELCOME15-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  assert.equal(welcomeCode(10, () => 0), "WELCOME10-222222");
});

// ── Bot screen ──────────────────────────────────────────────────────────────
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
test("screenRequest lets a person through", () => {
  assert.equal(screenRequest({ honeypot: "", openMs: 6400, ua: UA }), null);
  assert.equal(screenRequest({ honeypot: undefined, openMs: MIN_OPEN_MS, ua: UA }), null);
});
test("screenRequest turns away bots", () => {
  assert.equal(screenRequest({ honeypot: "Acme Inc", openMs: 6400, ua: UA }), "honeypot");
  assert.equal(screenRequest({ honeypot: "", openMs: 300, ua: UA }), "too_quick");
  assert.equal(screenRequest({ honeypot: "", openMs: "soon", ua: UA }), "too_quick");
  assert.equal(screenRequest({ honeypot: "", openMs: 6400, ua: "  " }), "no_user_agent");
});

// ── Languages + dates ───────────────────────────────────────────────────────
test("langOf maps Shopify locales", () => {
  assert.equal(langOf("es"), "es");
  assert.equal(langOf("pt-BR"), "pt");
  assert.equal(langOf("en-US"), "en");
  assert.equal(langOf(undefined), "en");
  assert.equal(langOf("fr"), "en");
});
test("longDate is store time (Eastern), in the shopper's language", () => {
  // 03:30 UTC on Nov 20 is still Nov 19 in Orlando.
  assert.equal(longDate("2026-11-20T03:30:00Z", "en"), "November 19, 2026");
  assert.match(longDate("2026-11-20T03:30:00Z", "es"), /19 de noviembre de 2026/);
  assert.match(longDate("2026-11-20T03:30:00Z", "pt"), /19 de novembro de 2026/);
});

// ── Email ───────────────────────────────────────────────────────────────────
test("welcome email carries the code, the shop link, the unsubscribe link and the address", () => {
  const m = buildWelcomeEmail({ code: "WELCOME15-ABC234", percent: 15, endsAt: "2026-11-19T15:00:00Z", locale: "en", unsubToken: "tok_123" });
  assert.equal(m.subject, "Your 15% code for Carbon");
  assert.ok(m.html.includes("WELCOME15-ABC234"));
  assert.ok(m.html.includes("https://shopcarbon.com/discount/WELCOME15-ABC234?redirect=%2F"));
  assert.ok(m.html.includes("https://wms.shopcarbon.com/api/storefront/welcome-unsubscribe?t=tok_123"));
  assert.ok(m.html.includes("6250 Edgewater Drive"));
  assert.ok(m.text.includes("November 19, 2026"));
  assert.ok(!/carbon jeans/i.test(m.html + m.text), "brand is Carbon");
});
test("welcome email in Spanish and Portuguese", () => {
  const es = buildWelcomeEmail({ code: "WELCOME15-ABC234", percent: 15, endsAt: "2026-11-19T15:00:00Z", locale: "es", unsubToken: "t" });
  assert.equal(es.subject, "Tu código de 15% para Carbon");
  assert.ok(es.html.includes('lang="es"'));
  const pt = buildWelcomeEmail({ code: "WELCOME15-ABC234", percent: 15, endsAt: "2026-11-19T15:00:00Z", locale: "pt-BR", unsubToken: "t" });
  assert.equal(pt.subject, "Seu código de 15% da Carbon");
  assert.ok(pt.html.includes('lang="pt-BR"'));
});
test("email copy never names another brand or the products' origin", () => {
  const all = JSON.stringify(
    Object.values(EMAIL_COPY).map((c) => Object.values(c).map((v) => (typeof v === "function" ? (v as (x: unknown) => string)(15) : v))),
  );
  assert.ok(!/jeans|made in|imported|inspired by/i.test(all));
});
test("email escapes what it prints", () => {
  const m = buildWelcomeEmail({ code: "<b>X</b>", percent: 15, endsAt: "2026-11-19T15:00:00Z", locale: "en", unsubToken: '"><script>' });
  assert.ok(!m.html.includes("<b>X</b>"));
  assert.ok(!m.html.includes("<script>"));
});

// ── Theme config + snippet ──────────────────────────────────────────────────
test("themeConfig ships only what the snippet reads", () => {
  assert.deepEqual(themeConfig({ ...WELCOME_DEFAULTS, enabled: true, percentOff: 15 }), { enabled: true, percent: 15, delay: 8, validDays: 30 });
});
test("formOf: popup unless it says footer", () => {
  assert.equal(formOf("footer"), "footer");
  assert.equal(formOf("popup"), "popup");
  assert.equal(formOf(undefined), "popup");
  assert.equal(formOf("<script>"), "popup");
});

const snippet = readFileSync(path.join(process.cwd(), "theme/snippets/carbon-welcome-popup.liquid"), "utf8");
test("snippet: posts to the public route, honours off / preview / Shield blocks, never replaces a cart code", () => {
  const s = snippet;
  assert.ok(s.includes('"https://wms.shopcarbon.com/api/storefront/welcome-signup"'));
  assert.ok(s.includes("shop.metafields.carbon.welcome_popup.value"));
  assert.ok(s.includes("carbon_welcome=preview"));
  // Off (and not previewing) → nothing runs, so the footer form stays Shopify's own.
  assert.ok(s.includes("if (!(preview || CFG.enabled) || navigator.webdriver) return;"));
  // Signed-in subscribers and visitors who already signed up / closed it never get the popup.
  assert.ok(s.includes("if (SUBSCRIBED || seen) popupAllowed = false;"));
  assert.ok(s.includes('st.s === "done"'));
  assert.ok(s.includes("cs_v=b"));
  assert.ok(s.includes("c.discount_codes && c.discount_codes.length"));
  assert.ok(/name="cwp_x"/.test(s), "honeypot name no autofill fills");
  assert.ok(!/name="(company|organization|name|address)"/.test(s));
  assert.ok(!/carbon jeans/i.test(s));
  // Every inner rule is scoped under .cwp, so theme rules like input[type=email] can't win.
  const css = s.slice(s.indexOf("var CSS ="), s.indexOf("var root, card"));
  const bare = css.match(/(?:^|[}"])\s*\.cwp-[a-z]/g) ?? [];
  assert.equal(bare.length, 0, `unscoped rules: ${bare.join(" ")}`);
});
test("snippet: the footer newsletter uses the same signup (form=footer), keeps its consent box, stops the popup", () => {
  const s = snippet;
  assert.ok(s.includes('d.querySelectorAll(".signup-container form")'));
  assert.ok(s.includes('postSignup(email, hp.value,') && s.includes('"footer")'));
  assert.ok(s.includes('"popup")'));
  assert.ok(s.includes("e.stopImmediatePropagation();") && s.includes("}, true);"), "captures submit before other scripts");
  assert.ok(!/required\s*=\s*false|removeAttribute\("required"\)/.test(s), "consent checkbox stays required");
  assert.ok(s.includes("if (shown || signedUp) return;"), "a footer signup stops the popup on this page");
  const foot = s.slice(s.indexOf("var FOOT_CSS ="), s.indexOf("function wireFooterForm"));
  const bare = foot.match(/(?:^|[}"])\s*\.cwf-[a-z]/g) ?? [];
  assert.equal(bare.length, 0, `unscoped footer rules: ${bare.join(" ")}`);
  for (const lang of ["Sign up and get", "Suscríbete y recibe", "Cadastre-se e ganhe"]) assert.ok(s.includes(lang), lang);
});

console.log(`welcome-popup: ${passed} tests passed`);
