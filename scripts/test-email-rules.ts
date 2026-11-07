/**
 * Tests for CarbonWMS Email's pure rules: npx tsx scripts/test-email-rules.ts
 */
import assert from "node:assert/strict";
import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import {
  cleanFirstName,
  cleanPrefix,
  exclusionReason,
  fillMergeTags,
  htmlToText,
  normalizeEmail,
  personalCode,
  sanitizeEmailHtml,
  shouldPause,
  usedMergeTags,
  wrapEmail,
} from "../lib/server/email/rules";
import { certUrlAllowed, stringToSign, subscribeUrlAllowed, type SnsMessage } from "../lib/server/email/sns";
import { audienceSql } from "../lib/server/email/contacts";

let n = 0;
function t(name: string, fn: () => void) {
  fn();
  n++;
  console.log(`ok  ${name}`);
}

t("normalizeEmail", () => {
  assert.equal(normalizeEmail("  Maria@Gmail.COM "), "maria@gmail.com");
  assert.equal(normalizeEmail("not an email"), null);
  assert.equal(normalizeEmail("a@b"), null);
});

t("exclusionReason: fake / staff / typo / real", () => {
  assert.equal(exclusionReason("david.brown9178@example.com"), "fake");
  assert.equal(exclusionReason("test123@gmail.com"), "fake");
  assert.equal(exclusionReason("none@gmail.com"), "fake");
  assert.equal(exclusionReason("orders@shopcarbon.com"), "staff");
  assert.equal(exclusionReason("info@carbonjeanscompany.com"), "staff");
  assert.equal(exclusionReason("ddjb316@gmial.com"), "typo");
  assert.equal(exclusionReason("someone@gmail.con"), "typo");
  // Real names that the first (too strict) filter wrongly dropped on 2026-11-07:
  assert.equal(exclusionReason("aalexiscolina@gmail.com"), null);
  assert.equal(exclusionReason("amburlena@gmail.com"), null);
  assert.equal(exclusionReason("cconde123@gmail.com"), null);
  assert.equal(exclusionReason("lclavijo1697@universidadean.edu.co"), null);
});

t("cleanFirstName", () => {
  assert.equal(cleanFirstName("  mARIA  jose"), "Maria");
  assert.equal(cleanFirstName("maria@gmail.com"), null);
  assert.equal(cleanFirstName(""), null);
  assert.equal(cleanFirstName(null), null);
});

t("personalCode + cleanPrefix", () => {
  const c = personalCode("CB20");
  assert.match(c, /^CB20-[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(cleanPrefix("cb-20!"), "CB20");
  assert.equal(cleanPrefix("x"), "CB");
});

t("fillMergeTags: escapes values, drops unknown tags, safe fallbacks", () => {
  const html = `<p>Hi {{ greeting_name }}, {{first_name}}</p><a href="{{code_url}}">{{code}}</a>{{evil}}`;
  assert.equal(
    fillMergeTags(html, { greeting_name: "<b>Ana</b>", first_name: "Ana", code: "CB20-ABC234", code_url: "https://shopcarbon.com/discount/CB20-ABC234?redirect=%2F" }),
    `<p>Hi &lt;b&gt;Ana&lt;/b&gt;, Ana</p><a href="https://shopcarbon.com/discount/CB20-ABC234?redirect=%2F">CB20-ABC234</a>`,
  );
  assert.equal(fillMergeTags("Hi {{greeting_name}}", {}), "Hi there");
  assert.equal(fillMergeTags(`<a href="{{code_url}}">x</a>`, {}), `<a href="https://shopcarbon.com">x</a>`);
  assert.deepEqual(usedMergeTags("{{code}} {{ code }} {{offer_ends}} {{nope}}").sort(), ["code", "offer_ends"]);
});

t("sanitizeEmailHtml removes active content, keeps email markup", () => {
  const dirty = `<table><tr><td onclick="x()" style="color:red">Hi<script>alert(1)</script>
    <iframe src="https://e.vil"></iframe><form action="/x"><input name="a"></form>
    <a href="javascript:alert(1)">bad</a><a href='data:text/html,hi'>bad2</a>
    <img src="https://wms.shopcarbon.com/a.jpg" onerror="x()"><!--[if mso]>ok<![endif]--><!-- secret --></td></tr></table>`;
  const s = sanitizeEmailHtml(dirty);
  assert.ok(!/script|iframe|<form|<input|onclick|onerror|javascript:|data:text/i.test(s), s);
  assert.ok(s.includes(`<img src="https://wms.shopcarbon.com/a.jpg">`));
  assert.ok(s.includes("[if mso]"));
  assert.ok(!s.includes("secret"));
});

t("wrapEmail always adds the unsubscribe footer + address, keeps media-query styles", () => {
  const design = `<html><head><style>@media (max-width:620px){.m-full{width:100%!important}}</style></head><body><table><tr><td>Hello {{greeting_name}}</td></tr></table></body></html>`;
  const out = wrapEmail({ designHtml: design, subject: "Hi & welcome", preheader: "Your $20", postalAddress: "Carbon · 6250 Edgewater Drive · Orlando, FL" });
  assert.ok(out.includes("{{unsubscribe_url}}"));
  assert.ok(out.includes("6250 Edgewater Drive"));
  assert.ok(out.includes("@media (max-width:620px)"));
  assert.ok(out.includes("<title>Hi &amp; welcome</title>"));
  assert.ok(out.includes("Your $20"));
  const filled = fillMergeTags(out, { greeting_name: "Ana", unsubscribe_url: "https://wms.shopcarbon.com/api/public/email/unsubscribe?t=abc" });
  assert.ok(filled.includes("Hello Ana"));
  assert.ok(filled.includes("unsubscribe?t=abc"));
  const text = htmlToText(filled);
  assert.ok(text.includes("Hello Ana"));
  assert.ok(text.includes("Unsubscribe (https://wms.shopcarbon.com/api/public/email/unsubscribe?t=abc)"));
  assert.ok(!text.includes("@media"));
});

t("shouldPause", () => {
  assert.equal(shouldPause({ sent: 100, bounced: 50, complained: 0, pausePct: 3 }), null); // too early to judge
  assert.equal(shouldPause({ sent: 200, bounced: 5, complained: 0, pausePct: 3 }), null);
  assert.match(shouldPause({ sent: 200, bounced: 6, complained: 0, pausePct: 3 }) ?? "", /3\.0% of emails bounced/);
  assert.match(shouldPause({ sent: 1000, bounced: 0, complained: 1, pausePct: 3 }) ?? "", /spam/);
});

t("audienceSql always excludes suppressed contacts", () => {
  const q = audienceSql({ who: "subscribed", sinceYear: 2023, notEmailedDays: 7 }, 2);
  for (const s of ["excluded_reason IS NULL", "unsubscribed_at IS NULL", "bounced_at IS NULL", "complained_at IS NULL", "SUBSCRIBED"]) assert.ok(q.where.includes(s));
  assert.deepEqual(q.params, [2023, 7]);
  assert.ok(q.where.includes("$2") && q.where.includes("$3"));
});

t("SNS: string to sign + signature check with a test key", () => {
  const m: SnsMessage = {
    Type: "Notification",
    MessageId: "m-1",
    TopicArn: "arn:aws:sns:us-east-1:123:carbon-email-events",
    Message: `{"eventType":"Delivery"}`,
    Timestamp: new Date().toISOString(),
    SignatureVersion: "2",
    Signature: "",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem",
  };
  const sts = stringToSign(m);
  assert.equal(sts, `Message\n${m.Message}\nMessageId\nm-1\nTimestamp\n${m.Timestamp}\nTopicArn\n${m.TopicArn}\nType\nNotification\n`);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sig = createSign("RSA-SHA256").update(sts, "utf8").sign(privateKey, "base64");
  assert.ok(createVerify("RSA-SHA256").update(sts, "utf8").verify(publicKey, sig, "base64"));
  assert.ok(certUrlAllowed(m.SigningCertURL));
  assert.ok(!certUrlAllowed("https://evil.com/sns.us-east-1.amazonaws.com.pem"));
  assert.ok(!certUrlAllowed("http://sns.us-east-1.amazonaws.com/x.pem"));
  assert.ok(subscribeUrlAllowed("https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=x"));
  assert.ok(!subscribeUrlAllowed("https://169.254.169.254/latest"));
});

console.log(`\n${n} groups passed`);
