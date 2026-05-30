/**
 * In-process SSE fan-out: edge ingest → dashboard EventSource.
 * Filters by tenant + **location** so Orlando operators do not see Sunrise scans.
 */

export type EdgeScanStreamPayload = {
  deviceId: string;
  locationId: string;
  scanContext: string;
  epcs: string[];
  /**
   * Optional map of EPC (uppercased hex) → antenna UUID, populated by the
   * fixed-reader ingest path so the dashboard can credit each EPC to the
   * specific antenna that detected it. Keyed by EPC (one entry per unique
   * EPC in this batch). Subscribers that don't care can ignore it.
   */
  epcAntennaMap?: Record<string, string>;
  /**
   * Optional map of EPC (uppercased hex) → strongest RSSI (dBm, negative) seen
   * for that EPC in this batch. Used by the Carbon-POS cart/scan UI to filter
   * the display by proximity (closer tag = higher RSSI) now that the POS reader
   * runs at a constant 33 dBm. Subscribers that don't care can ignore it.
   */
  epcRssiMap?: Record<string, number>;
  timestamp?: string;
  rowsAffected?: number;
};

type Subscriber = {
  tenantKey: string;
  locationKey: string;
  send: (sseChunk: string) => void;
};

const subs = new Set<Subscriber>();

function normTenant(tenantId: string): string {
  return tenantId.trim().toLowerCase();
}

function normLocation(locationId: string): string {
  return locationId.trim().toLowerCase();
}

export function subscribeEdgeScanStream(
  tenantId: string,
  locationId: string,
  send: (sseChunk: string) => void,
): () => void {
  const sub: Subscriber = {
    tenantKey: normTenant(tenantId),
    locationKey: normLocation(locationId),
    send,
  };
  subs.add(sub);
  return () => {
    subs.delete(sub);
  };
}

export function publishEdgeScanEvent(
  tenantId: string,
  locationId: string,
  payload: EdgeScanStreamPayload,
): void {
  const tk = normTenant(tenantId);
  const lk = normLocation(locationId);
  const chunk = `data: ${JSON.stringify(payload)}\n\n`;
  for (const s of subs) {
    if (s.tenantKey !== tk) continue;
    if (s.locationKey !== lk) continue;
    try {
      s.send(chunk);
    } catch {
      /* broken HTTP stream */
    }
  }
}
