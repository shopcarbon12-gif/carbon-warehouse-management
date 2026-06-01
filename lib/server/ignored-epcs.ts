/**
 * System-wide EPC ignore-list — "phantom tags".
 *
 * Some chips read continuously on a fixed reader but can never be physically
 * located: a tag lost inside a wall/floor, embedded in fixturing, or a
 * dead-but-still-chirping chip in the antenna field. Such an EPC is pure
 * noise. The operator's instruction is that it must be erased from the entire
 * system — NOT recorded as `tag_killed`, NOT shown in Defective EPCs, NOT
 * streamed to any WMS page, NOT counted, NOT beeped on the handheld. As far as
 * the system is concerned, the tag does not exist.
 *
 * Enforcement is at the read-ingestion chokepoints (filterIgnoredReads /
 * filterIgnoredEpcs), the points where external EPCs first enter the system:
 *   - lib/server/cdm-agents.ts  ingestAgentReads()      (fixed readers → cdm_reads + edge SSE)
 *   - app/api/edge/ingest       POST                    (handheld uploads → reconciler)
 *   - lib/server/rfid-cycle-count-scan.ts ingestCycleCountEpcs()
 * Every deeper path (ingestEpc/ingestEpcs, scan-finalize, transfers) is fed by
 * one of those, so the phantom can never reach an `items` write.
 *
 * The list is also served to the handheld via /api/settings/mobile-sync
 * (`ignored_epcs`) so the app drops the EPC on-device before it can beep or
 * display. See mobile/carbon_wms RfidManager + the native vendor controllers.
 *
 * To ignore another phantom: add its uppercased, 24-char hex EPC below.
 */
export const IGNORED_EPCS: ReadonlySet<string> = new Set<string>([
  // .70 (192.168.1.70) phantom — reads non-stop, never physically found.
  // Operator instruction 2026-06-01: ignore completely, everywhere, forever.
  "30129CBFD880004000002699",
]);

/** Normalize an EPC the way the ingest paths do (trim + uppercase). */
function norm(epcHex: string): string {
  return (epcHex ?? "").replace(/\s/g, "").toUpperCase();
}

/** True when this EPC is on the system-wide ignore-list. */
export function isIgnoredEpc(epcHex: string): boolean {
  if (IGNORED_EPCS.size === 0) return false;
  return IGNORED_EPCS.has(norm(epcHex));
}

/**
 * Drop ignored EPCs from a reads batch (objects carrying an `epcHex`) before
 * any processing. Returns the same array reference when nothing is ignored.
 */
export function filterIgnoredReads<T extends { epcHex: string }>(reads: T[]): T[] {
  if (IGNORED_EPCS.size === 0) return reads;
  return reads.filter((r) => !isIgnoredEpc(r.epcHex));
}

/** Drop ignored EPCs from a plain string[] of EPC hexes. */
export function filterIgnoredEpcs(epcs: string[]): string[] {
  if (IGNORED_EPCS.size === 0) return epcs;
  return epcs.filter((e) => !isIgnoredEpc(e));
}

/** The ignore-list as a plain array, for serving to clients (e.g. mobile-sync). */
export function ignoredEpcList(): string[] {
  return Array.from(IGNORED_EPCS);
}
