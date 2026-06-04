/**
 * In-process SSE fan-out for transfers: a commit / receive anywhere (desktop or
 * handheld) notifies every connected client whose active location is the slip's
 * source OR destination, so the two sides mirror each other live.
 *
 * Same single-instance model as the edge-scan hub — fine for the one Coolify
 * container. Filtered by tenant + location so operators never see another
 * location's traffic.
 */

export type TransferEventPayload = {
  /** 'committed' (transfer out created) | 'received' (transfer in progressed). */
  kind: "committed" | "received";
  transferId: string;
  slipNumber: number | null;
  sourceLocationId: string;
  destinationLocationId: string;
  state: string;
  timestamp: string;
};

type Subscriber = {
  tenantKey: string;
  locationKey: string;
  send: (sseChunk: string) => void;
};

const subs = new Set<Subscriber>();

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export function subscribeTransferEvents(
  tenantId: string,
  locationId: string,
  send: (sseChunk: string) => void,
): () => void {
  const sub: Subscriber = {
    tenantKey: norm(tenantId),
    locationKey: norm(locationId),
    send,
  };
  subs.add(sub);
  return () => {
    subs.delete(sub);
  };
}

/**
 * Notify both ends of a transfer. Callers pass the source + destination
 * location ids; any subscriber whose active location matches either one is
 * told to refresh.
 */
export function publishTransferEvent(
  tenantId: string,
  payload: TransferEventPayload,
): void {
  const tk = norm(tenantId);
  const targets = new Set([
    norm(payload.sourceLocationId),
    norm(payload.destinationLocationId),
  ]);
  const chunk = `data: ${JSON.stringify(payload)}\n\n`;
  for (const s of subs) {
    if (s.tenantKey !== tk) continue;
    if (!targets.has(s.locationKey)) continue;
    try {
      s.send(chunk);
    } catch {
      /* broken HTTP stream */
    }
  }
}
