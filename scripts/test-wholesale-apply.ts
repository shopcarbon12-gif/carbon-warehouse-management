/** Checks for the detailed wholesale application validators (no database). */
import assert from "node:assert/strict";
import { normalizeEin, parseSocialLinks, sniffCertificate } from "@/lib/server/wholesale/applications";

assert.deepEqual(parseSocialLinks("instagram.com/teststore\nhttps://www.facebook.com/teststore/"), [
  "https://instagram.com/teststore",
  "https://facebook.com/teststore",
]);
assert.deepEqual(parseSocialLinks("tiktok.com/@shop, https://m.facebook.com/shop"), ["https://tiktok.com/@shop", "https://facebook.com/shop"]);
assert.equal(parseSocialLinks("https://example.com/me"), null, "non-social site refused");
assert.equal(parseSocialLinks("instagram.com"), null, "home page without a profile refused");
assert.equal(parseSocialLinks("not a url at all"), null);
assert.deepEqual(parseSocialLinks(""), []);
assert.equal(normalizeEin("12 3456789"), "12-3456789");
assert.equal(normalizeEin("12-3456789"), "12-3456789");
assert.equal(normalizeEin("123"), null);
const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\n");
assert.equal(sniffCertificate(pdf), "application/pdf");
assert.equal(sniffCertificate(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), "image/jpeg");
assert.equal(sniffCertificate(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), "image/png");
assert.equal(sniffCertificate(new TextEncoder().encode("<html><script>alert(1)</script>")), null, "HTML disguised as a file refused");
console.log("wholesale apply validators: all checks passed");
