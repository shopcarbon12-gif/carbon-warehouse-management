/**
 * EPC decoder — implements the SENITRON-format EPC formula:
 *
 *   [N-bit prefix] + [M-bit asset/item#] + [K-bit serial#] = 96 bits total
 *
 * Bit allocations are tenant-configurable (loaded from `tenant_epc_config`).
 * For Carbon Jeans the values are 20/40/36 with prefix `F0A0B`.
 *
 * This file is deliberately kept pure — no DB calls, no IO. The caller passes
 * a config object loaded from `tenant_epc_config`; this module just does the
 * bit math. That makes it cheap to call thousands of times per ingress batch
 * and trivial to unit-test in isolation.
 *
 * NB: tsconfig targets ES2017, so we can't use BigInt literal syntax (`1n`).
 * Use `BigInt(...)` constructors throughout.
 */

export type EpcConfig = {
  /** Hex string for the company prefix, e.g. "F0A0B". Case-insensitive. */
  prefixHex: string;
  /** Width of the prefix in bits. Must equal the bit-length of `prefixHex`. */
  prefixBits: number;
  /** Width of the asset/item# field in bits. */
  assetBits: number;
  /** Width of the serial# field in bits. */
  serialBits: number;
  /** Padding (digit count) when displaying `systemId` in the UI. */
  assetPaddingDigits: number;
};

export type DecodedEpc = {
  /** True iff the EPC is exactly 24 hex chars AND its prefix bits match config. */
  valid: boolean;
  /** Reason the EPC was rejected, populated when `valid === false`. */
  reason?: "bad_length" | "bad_hex" | "wrong_prefix" | "bad_config";
  /** Hex form of the prefix bits we read out of the EPC (uppercased). */
  prefixHex: string;
  /** Decoded asset/item# (the catalog `ls_system_id`). null if !valid. */
  systemId: bigint | null;
  /** Decoded 36-bit serial. null if !valid. */
  serial: bigint | null;
};

const HEX_RE = /^[0-9A-F]+$/;
const ZERO = BigInt(0);
const ONE = BigInt(1);

function bigShiftLeft(n: bigint, bits: number): bigint {
  return n * (ONE << BigInt(bits));
}

function bigPow2(bits: number): bigint {
  return ONE << BigInt(bits);
}

/**
 * Decode a 24-char hex EPC against the tenant's bit layout.
 *
 * We use BigInt throughout because a 40-bit asset# + 36-bit serial both exceed
 * Number.MAX_SAFE_INTEGER's safe range when combined with arithmetic, and
 * Postgres BIGINT can hold the full range. Caller is responsible for
 * stringifying when JSON-serializing.
 */
export function decodeEpc(epcHexInput: string, config: EpcConfig): DecodedEpc {
  const epcHex = (epcHexInput ?? "").trim().toUpperCase();
  if (epcHex.length !== 24) {
    return { valid: false, reason: "bad_length", prefixHex: "", systemId: null, serial: null };
  }
  if (!HEX_RE.test(epcHex)) {
    return { valid: false, reason: "bad_hex", prefixHex: "", systemId: null, serial: null };
  }

  const totalBits = config.prefixBits + config.assetBits + config.serialBits;
  if (totalBits !== 96) {
    // tenant_epc_config has a CHECK constraint forbidding this — if we got here
    // someone bypassed the DB. Treat as invalid rather than crash.
    return { valid: false, reason: "bad_config", prefixHex: "", systemId: null, serial: null };
  }

  // 24 hex chars → 96 bits. Convert to a single BigInt for cheap bit slicing.
  const bits96 = BigInt("0x" + epcHex);

  // Prefix = top `prefixBits` bits.
  const prefixShift = config.assetBits + config.serialBits;
  const prefixMask = bigPow2(config.prefixBits) - ONE;
  const prefixVal = (bits96 >> BigInt(prefixShift)) & prefixMask;

  const expectedPrefixVal = BigInt("0x" + config.prefixHex);
  if (prefixVal !== expectedPrefixVal) {
    const prefixHexRead = prefixVal
      .toString(16)
      .toUpperCase()
      .padStart(Math.ceil(config.prefixBits / 4), "0");
    return { valid: false, reason: "wrong_prefix", prefixHex: prefixHexRead, systemId: null, serial: null };
  }

  // Asset = next `assetBits` bits.
  const assetShift = BigInt(config.serialBits);
  const assetMask = bigPow2(config.assetBits) - ONE;
  const assetVal = (bits96 >> assetShift) & assetMask;

  // Serial = bottom `serialBits` bits.
  const serialMask = bigPow2(config.serialBits) - ONE;
  const serialVal = bits96 & serialMask;

  // Suppress unused-helper warning until we need it elsewhere.
  void bigShiftLeft;

  return {
    valid: true,
    prefixHex: config.prefixHex.toUpperCase(),
    systemId: assetVal,
    serial: serialVal,
  };
}

/**
 * Format a decoded systemId as a zero-padded decimal string for display.
 * Senitron's UI calls this "Asset ID Catalog Digits Padding".
 */
export function formatSystemId(systemId: bigint | null, config: EpcConfig): string {
  if (systemId === null) return "—";
  return systemId.toString().padStart(config.assetPaddingDigits, "0");
}

void ZERO; // silence unused; reserved for future helpers
