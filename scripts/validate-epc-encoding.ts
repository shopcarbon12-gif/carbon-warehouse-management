/**
 * Sanity-check Carbon WMS 96-bit EPC packing (20 + 40 + 36) against generateSGTIN96.
 *
 *   npx tsx scripts/validate-epc-encoding.ts
 */
import { generateSGTIN96 } from "../lib/epc";

const CONFIG = {
  prefix: 1_044_991, // 20 bits
  itemRef: 123_456_789, // 40 bits sample
  serial: 987_654_321, // 36 bits sample
};

function validateEPC(epcHex: string): boolean {
  console.log(`Testing EPC: ${epcHex}`);

  const epcBin = BigInt("0x" + epcHex);

  // Matches lib/utils/epc.ts: packed = (cp << 76) | (ir << 36) | sn
  const extractedPrefix =
    (epcBin >> BigInt(76)) & ((BigInt(1) << BigInt(20)) - BigInt(1));
  const extractedItem =
    (epcBin >> BigInt(36)) & ((BigInt(1) << BigInt(40)) - BigInt(1));
  const extractedSerial = epcBin & ((BigInt(1) << BigInt(36)) - BigInt(1));

  console.log("--- Validation results ---");
  const okP = extractedPrefix === BigInt(CONFIG.prefix);
  const okI = extractedItem === BigInt(CONFIG.itemRef);
  const okS = extractedSerial === BigInt(CONFIG.serial);
  console.log(
    `Prefix: ${extractedPrefix} ${okP ? "OK" : "MISMATCH"}`,
  );
  console.log(
    `Item:   ${extractedItem} ${okI ? "OK" : "MISMATCH"}`,
  );
  console.log(
    `Serial: ${extractedSerial} ${okS ? "OK" : "MISMATCH"}`,
  );

  let ok = okP && okI && okS;
  if (epcHex.length !== 24) {
    console.error(`Length error: expected 24 hex chars, got ${epcHex.length}`);
    ok = false;
  }

  return ok;
}

try {
  const testEpc = generateSGTIN96(CONFIG.prefix, CONFIG.itemRef, CONFIG.serial);
  const pass = validateEPC(testEpc);
  console.log(pass ? "\nAll checks passed." : "\nValidation failed.");
  process.exit(pass ? 0 : 1);
} catch (error) {
  console.error("Execution failed:", error);
  process.exit(1);
}
