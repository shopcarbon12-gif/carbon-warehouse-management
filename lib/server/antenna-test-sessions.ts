/**
 * In-memory store of active antenna-test sessions.
 *
 * NOT persisted — sessions evaporate on WMS restart. That's deliberate
 * (operator-driven diagnostic, fire-and-forget, no history). The only
 * failure mode is "operator clicked Start, WMS restarted, browser hangs"
 * — the SSE connection drops and the table freezes. Operator clicks
 * Start again. Acceptable.
 *
 * Session lifecycle:
 *   - POST /api/antenna-test/start → createSession() → returns sessionId.
 *     The session is keyed by readerId so two operators can't run a test
 *     on the same reader concurrently (single-client WIZnet bridge).
 *   - Agent fast-polls /api/cdm-agents/active-sessions every ~1 s; the
 *     bundle returned is filtered to the agent's own location.
 *   - POST /api/antenna-test/update → patches knobs on an existing session;
 *     agent picks up the changes on its next poll.
 *   - POST /api/antenna-test/stop → endSession(); agent observes empty list
 *     on next poll and reverts the reader to normal scan mode.
 *   - Auto-expire: any session whose `lastSeenAt` is older than
 *     SESSION_MAX_IDLE_MS gets dropped on the next read or sweep — covers
 *     "browser tab closed, operator forgot to stop." The browser side
 *     refreshes lastSeenAt on every SSE ping (every 25 s).
 */

import { randomUUID } from "node:crypto";

export type AntennaTestFlags = {
  /** dBm × 10, matches MonsoonReader's `--power` arg. Range 100..330. */
  powerArg: number;
  /** Inventory cycle time per pass; binary's `--read_time_ms`. */
  readTimeMs: number;
  /** "infinite" or "oscillating". */
  cycleMode: "infinite" | "oscillating";
  /** Strong-tag filter; binary's `--tagfocus`. */
  tagFocus: boolean;
};

export type AntennaTestSession = {
  /** Stable opaque id; used as SSE channel + agent-poll filter. */
  id: string;
  /** Session-cookie tenant_id from getSessionFromRequest(). */
  tenantId: string;
  /** Where the reader physically lives. Agent filters its poll by this. */
  locationId: string;
  /** Reader UUID under test. */
  readerId: string;
  /** Antenna UUID under test. */
  antennaId: string;
  /** Antenna number (1..N) — what the agent stamps on every read. */
  antennaNumber: number;
  /** Operator-tunable radio knobs. Mutable via /update. */
  flags: AntennaTestFlags;
  /** Browser session cookie's user_id, for audit. */
  startedBy: string | null;
  /** ms-since-epoch of session creation. */
  startedAt: number;
  /** ms-since-epoch of the last heartbeat (SSE ping or /update). */
  lastSeenAt: number;
};

/** Idle longer than this and the session is auto-dropped. */
const SESSION_MAX_IDLE_MS = 5 * 60_000; // 5 min — generous; SSE pings every 25 s

const byReader = new Map<string, AntennaTestSession>();
const byId = new Map<string, AntennaTestSession>();

function pruneStale(now: number): void {
  const toDrop: string[] = [];
  for (const s of byId.values()) {
    if (now - s.lastSeenAt > SESSION_MAX_IDLE_MS) toDrop.push(s.id);
  }
  for (const id of toDrop) {
    const s = byId.get(id);
    if (!s) continue;
    byId.delete(id);
    byReader.delete(s.readerId);
  }
}

export function createSession(input: {
  tenantId: string;
  locationId: string;
  readerId: string;
  antennaId: string;
  antennaNumber: number;
  flags: AntennaTestFlags;
  startedBy: string | null;
}): { ok: true; session: AntennaTestSession } | { ok: false; reason: "reader_busy"; existing: AntennaTestSession } {
  const now = Date.now();
  pruneStale(now);
  const existing = byReader.get(input.readerId);
  if (existing) return { ok: false, reason: "reader_busy", existing };
  const session: AntennaTestSession = {
    id: randomUUID(),
    tenantId: input.tenantId,
    locationId: input.locationId,
    readerId: input.readerId,
    antennaId: input.antennaId,
    antennaNumber: input.antennaNumber,
    flags: input.flags,
    startedBy: input.startedBy,
    startedAt: now,
    lastSeenAt: now,
  };
  byId.set(session.id, session);
  byReader.set(session.readerId, session);
  return { ok: true, session };
}

export function getSession(id: string): AntennaTestSession | null {
  pruneStale(Date.now());
  return byId.get(id) ?? null;
}

export function updateSessionFlags(
  id: string,
  patch: Partial<AntennaTestFlags>,
): AntennaTestSession | null {
  const s = byId.get(id);
  if (!s) return null;
  s.flags = { ...s.flags, ...patch };
  s.lastSeenAt = Date.now();
  return s;
}

export function touchSession(id: string): boolean {
  const s = byId.get(id);
  if (!s) return false;
  s.lastSeenAt = Date.now();
  return true;
}

export function endSession(id: string): boolean {
  const s = byId.get(id);
  if (!s) return false;
  byId.delete(id);
  byReader.delete(s.readerId);
  return true;
}

/** All active sessions for ONE location (agent-side poll). */
export function listActiveSessionsForLocation(locationId: string): AntennaTestSession[] {
  pruneStale(Date.now());
  const out: AntennaTestSession[] = [];
  for (const s of byId.values()) {
    if (s.locationId === locationId) out.push(s);
  }
  return out;
}
