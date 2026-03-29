/**
 * Deterministic 40-bit unsigned integer from an arbitrary string.
 * Used when Lightspeed X-Series returns UUID product ids but `custom_skus.ls_system_id`
 * must remain numeric for SGTIN-96 `itemReference` packing (see `generateSGTIN96`).
 */
export function stableLsSystemIdFromString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  /* 32-bit FNV output fits the 40-bit SGTIN item reference field. */
  return h >>> 0;
}
