const CP_BITS = 20;
const IR_BITS = 40;
const SN_BITS = 36;

const CP_MAX = (BigInt(1) << BigInt(CP_BITS)) - BigInt(1);
const IR_MAX = (BigInt(1) << BigInt(IR_BITS)) - BigInt(1);
const SN_MAX = (BigInt(1) << BigInt(SN_BITS)) - BigInt(1);

function assertUIntField(
  name: string,
  value: number,
  bits: number,
  max: bigint,
): bigint {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
  if (value < 0) {
    throw new RangeError(`${name} must be non-negative`);
  }
  const n = BigInt(value);
  if (n > max) {
    throw new RangeError(
      `${name} exceeds ${bits}-bit limit (max inclusive ${max})`,
    );
  }
  return n;
}

/**
 * Packs a fixed 96-bit value (24 hex characters) for internal EPC storage.
 *
 * Layout (MSB → LSB): `companyPrefix` (20) | `itemReference` (40) | `serialNumber` (36).
 * This matches the Carbon WMS encoding where `itemReference` is the Lightspeed `ls_system_id`.
 *
 * Note: GS1’s on-tag **SGTIN-96** uses an 8-bit header, filter, partition, and variable-length
 * company prefix / indicator + item reference; this function implements the project’s **96-bit
 * fixed-width** packing for hex `items.epc`, not a full Tag URI binary SGTIN-96 record.
 */
export function generateSGTIN96(
  companyPrefix: number,
  itemReference: number,
  serialNumber: number,
): string {
  const cp = assertUIntField("companyPrefix", companyPrefix, CP_BITS, CP_MAX);
  const ir = assertUIntField("itemReference", itemReference, IR_BITS, IR_MAX);
  const sn = assertUIntField("serialNumber", serialNumber, SN_BITS, SN_MAX);

  const packed = (cp << BigInt(76)) | (ir << BigInt(36)) | sn;

  return packed.toString(16).toUpperCase().padStart(24, "0");
}

export type DecodedSgtin96 = {
  companyPrefix: number;
  itemReference: number;
  serialNumber: number;
};

/** Inverse of `generateSGTIN96` for diagnostics (20 + 40 + 36 bit layout). */
export function decodeSGTIN96(epcHex: string): DecodedSgtin96 | null {
  const clean = epcHex.replace(/\s/g, "").toUpperCase();
  if (!/^[0-9A-F]{24}$/.test(clean)) return null;
  const packed = BigInt("0x" + clean);
  const sn = packed & SN_MAX;
  const ir = (packed >> BigInt(36)) & IR_MAX;
  const cp = (packed >> BigInt(76)) & CP_MAX;
  return {
    companyPrefix: Number(cp),
    itemReference: Number(ir),
    serialNumber: Number(sn),
  };
}
