/**
 * LEGACY EPC → system_id / serial — CATALOG ENTRANCE ONLY.
 *
 * Mirrors the operator's legacy formula:
 *   system_id = int(epc[5:15], 16)
 *   serial    = int(epc[15:24], 16)   (the Carbon 20/40/36-bit layout tail)
 *
 * This runs ALONGSIDE the tenant's primary EPC formula, but it is used in
 * exactly one place conceptually: bringing already-encoded tags INTO the
 * catalog as LIVE (and clearing them from Defective) when the primary formula
 * can't place them — i.e. the ingest / scan-recognition paths only.
 *
 * It is deliberately NOT used to ENCODE, RE-ENCODE, or PRINT labels. Those
 * paths must keep using the primary formula (lib/server/epc-decode.ts) so a
 * legacy/foreign tag can never drive a chip write or a printed label.
 */
export function legacyEpcSystemId(epc: string): bigint | null {
  const e = (epc ?? "").trim().toUpperCase();
  if (e.length < 15) return null;
  const slice = e.slice(5, 15);
  if (!/^[0-9A-F]{10}$/.test(slice)) return null;
  return BigInt("0x" + slice);
}

export function legacyEpcSerial(epc: string): bigint {
  const e = (epc ?? "").trim().toUpperCase();
  const slice = e.slice(15, 24);
  if (slice.length === 0 || !/^[0-9A-F]+$/.test(slice)) return BigInt(0);
  return BigInt("0x" + slice);
}
