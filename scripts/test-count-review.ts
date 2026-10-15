/**
 * Count review CSV parsing (lib/server/count-review.ts) — no database.
 *   npx tsx scripts/test-count-review.ts
 * The push itself was verified end to end on a copy of the production schema
 * (add, override, super-admin revive, manual zero-out, refusals, once-only).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { epcsFromCsv, parseCsv } from "../lib/server/count-review";

test("quoted fields keep their commas and quotes", () => {
  const rows = parseCsv('epc,item_name\nF0A0B30E4F9C82A0000144A7,"Jeans, ""Slim"" Fit"\r\n');
  assert.deepEqual(rows, [["epc", "item_name"], ["F0A0B30E4F9C82A0000144A7", 'Jeans, "Slim" Fit']]);
});

test("epcsFromCsv: finds the EPC column anywhere, upper-cases, dedupes, drops junk", () => {
  const csv = [
    "system_id,custom_sku,epc,item_name",
    '123,C1,f0a0b30e4f9c82a0000144a7,"A, B"',
    "124,C2,F0A0B30E4F9C82A0000144A7,dup",
    "125,C3,NOT-AN-EPC,x",
    "126,C4,F0A0B30E4F9C82A0000144A8,y",
  ].join("\n");
  assert.deepEqual(epcsFromCsv(csv), ["F0A0B30E4F9C82A0000144A7", "F0A0B30E4F9C82A0000144A8"]);
});

test("epcsFromCsv: no EPC column → nothing", () => {
  assert.deepEqual(epcsFromCsv("sku,qty\nC1,2\n"), []);
});
