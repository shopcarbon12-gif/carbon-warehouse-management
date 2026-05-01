/**
 * In-process SSE fan-out for antenna-test sessions: agent ingest → browser
 * EventSource. Mirrors lib/server/edge-scan-hub.ts but keyed by sessionId
 * (one operator + one reader = one session = one channel) instead of by
 * tenant+location, because every test session is its own private workspace
 * and we don't want broadcast to other browsers.
 *
 * Lifecycle:
 *   - Browser opens GET /api/antenna-test/stream?sessionId=…  →
 *     subscribeAntennaTestStream(sessionId, send) → returns an unsubscribe.
 *   - Agent POSTs reads to /api/antenna-test/ingest →
 *     publishAntennaTestRead(sessionId, payload) → fans out.
 *   - Browser closes / sessions ends → unsubscribe runs.
 *
 * No per-tenant filter needed at this layer — the route handlers already
 * verify the session belongs to the calling user's tenant before
 * subscribing or publishing.
 */

export type AntennaTestReadPayload = {
  /** EPC hex, uppercase, 24 chars when valid. */
  epcHex: string;
  /** Reader-reported RSSI in dBm. May be a 0.1-precision float on console
   *  driver, integer on stream driver. */
  rssiDbm: number;
  /** Antenna number stamped at spawn time. */
  antennaNumber: number;
  /** ISO timestamp the agent saw the read. */
  observedAt: string;
  /** Optional power level the read was at — populated during sweep mode. */
  powerArg?: number;
};

export type AntennaTestStreamMessage =
  | { kind: "read"; read: AntennaTestReadPayload }
  | { kind: "lifecycle"; status: "armed" | "live" | "ended"; reason?: string }
  | { kind: "stats"; uniqueEpcs: number; totalReads: number; droppedBadCrc: number };

type Subscriber = {
  sessionId: string;
  send: (sseChunk: string) => void;
};

const subs = new Set<Subscriber>();

export function subscribeAntennaTestStream(
  sessionId: string,
  send: (sseChunk: string) => void,
): () => void {
  const sub: Subscriber = { sessionId, send };
  subs.add(sub);
  return () => {
    subs.delete(sub);
  };
}

export function publishAntennaTestRead(
  sessionId: string,
  read: AntennaTestReadPayload,
): void {
  const msg: AntennaTestStreamMessage = { kind: "read", read };
  const chunk = `data: ${JSON.stringify(msg)}\n\n`;
  for (const s of subs) {
    if (s.sessionId !== sessionId) continue;
    try {
      s.send(chunk);
    } catch {
      /* broken HTTP stream */
    }
  }
}

export function publishAntennaTestLifecycle(
  sessionId: string,
  status: "armed" | "live" | "ended",
  reason?: string,
): void {
  const msg: AntennaTestStreamMessage = { kind: "lifecycle", status, reason };
  const chunk = `data: ${JSON.stringify(msg)}\n\n`;
  for (const s of subs) {
    if (s.sessionId !== sessionId) continue;
    try {
      s.send(chunk);
    } catch {
      /* broken HTTP stream */
    }
  }
}

export function publishAntennaTestStats(
  sessionId: string,
  stats: { uniqueEpcs: number; totalReads: number; droppedBadCrc: number },
): void {
  const msg: AntennaTestStreamMessage = { kind: "stats", ...stats };
  const chunk = `data: ${JSON.stringify(msg)}\n\n`;
  for (const s of subs) {
    if (s.sessionId !== sessionId) continue;
    try {
      s.send(chunk);
    } catch {
      /* broken HTTP stream */
    }
  }
}
