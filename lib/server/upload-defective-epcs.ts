/**
 * Defective-EPC CSV builder for SAVE/UPLOAD finalisation.
 *
 * Q30 lock: full column set per row —
 *   epc, scanned_at, decode_reason, raw_decoded_bits, device_id, operator_user_id
 *
 * The CSV is stored inline on inventory_reports.defective_csv_blob
 * (migration 0055). The Defective EPCs modal also surfaces these via
 * items.status='tag_killed' which is set by the ingestEpc pipeline.
 */

export type DefectiveEpcRow = {
  epc: string;
  scannedAtIso: string;
  decodeReason: string;
  /** Optional 96-bit binary string — only populated when we attempted a decode. */
  rawDecodedBits?: string | null;
  deviceId?: string | null;
  operatorUserId?: string | null;
};

const HEADER =
  "epc,scanned_at,decode_reason,raw_decoded_bits,device_id,operator_user_id";

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildDefectiveCsv(rows: DefectiveEpcRow[]): string {
  if (rows.length === 0) return "";
  const lines = [HEADER];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.epc),
        csvCell(r.scannedAtIso),
        csvCell(r.decodeReason),
        csvCell(r.rawDecodedBits ?? ""),
        csvCell(r.deviceId ?? ""),
        csvCell(r.operatorUserId ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n");
}

/** 24-hex-char EPC → "0001 0010 ..." 96-bit binary string for the CSV column. */
export function epcHexToBits(epcHex: string): string | null {
  const clean = epcHex.replace(/\s/g, "").toUpperCase();
  if (!/^[0-9A-F]{24}$/.test(clean)) return null;
  const bits = BigInt("0x" + clean).toString(2).padStart(96, "0");
  // Group into 4-bit nibbles for readability.
  return bits.match(/.{1,4}/g)?.join(" ") ?? bits;
}
