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
  /** dBm × 10, matches MonsoonReader's `--power` arg. Range 0..330
   *  (the standard antenna-test page enforces 100..330; the admin
   *  reader-raw-test page relaxes the floor to 0 for diagnosing
   *  silent radios at low power). */
  powerArg: number;
  /** Inventory cycle time per pass; binary's `--read_time_ms`. */
  readTimeMs: number;
  /** "infinite" or "oscillating". */
  cycleMode: "infinite" | "oscillating";
  /** Strong-tag filter; binary's `--tagfocus`. */
  tagFocus: boolean;
};

/**
 * Optional sweep configuration. When non-null, the agent walks `powerArg`
 * from `startPowerArg` to `endPowerArg` in `stepPowerArg` increments,
 * pausing `dwellMs` at each step. Each read carries the powerArg it was
 * captured at, so the UI can build a "first-read-power" column.
 *
 * powerArg values are dBm × 10 (matches the binary): 100..330.
 */
export type AntennaTestSweep = {
  startPowerArg: number;
  endPowerArg: number;
  stepPowerArg: number;
  dwellMs: number;
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
  /** Optional power-sweep program. Agent walks this autonomously. */
  sweep: AntennaTestSweep | null;
  /** Browser session cookie's user_id, for audit. */
  startedBy: string | null;
  /** ms-since-epoch of session creation. */
  startedAt: number;
  /** ms-since-epoch of the last heartbeat (SSE ping or /update). */
  lastSeenAt: number;
  /** Total reads ingested across the session lifetime. /api/antenna-test/stop
   *  reads this to decide whether the test passed (>0) or failed (=0) and
   *  persists last_test_passed to the antenna row, so a passing test sticks
   *  the antenna green permanently per the Hardware Config rule. */
  totalReadsCount: number;
  /** When true, every WMS-side write is suppressed: ingest skips the
   *  antenna last_read_at bump, stop skips last_test_passed. Used by the
   *  admin reader-raw-test page so a diagnostic run leaves zero trace in
   *  the DB and no false-green dots on hardware-config. */
  rawMode: boolean;
};

/**
 * Idle longer than this and the session is auto-dropped. The browser-side
 * SSE pings every 25 s, so 60 s allows two missed pings before pruning.
 *
 * Why 60 s and not 5 min: when a session is "active", the agent pins the
 * reader in TEST_MODE, where reads go to /api/antenna-test/ingest instead
 * of /api/cdm-agents/reads. If the operator closes the tab / loses
 * internet / their laptop sleeps mid-test, no more SSE pings arrive —
 * but the reader keeps reading into the (now-orphaned) test session.
 * From the dashboard's perspective the reader looks dead because no
 * reads land in cdm_reads. With the old 5-min idle, that "looks dead"
 * window was 5 minutes long. 60 s is short enough that an accidental
 * tab close releases the reader almost immediately.
 */
const SESSION_MAX_IDLE_MS = 60_000;

/**
 * Pinned to globalThis so the same Map survives webpack/Next.js dev-mode
 * double-evaluation across route bundles (start/stop/stream/ingest live
 * in separate bundles). See note in raw-test-direct.ts.
 */
const G = globalThis as unknown as {
  __antennaTestById?: Map<string, AntennaTestSession>;
  __antennaTestByReader?: Map<string, AntennaTestSession>;
};
const byReader: Map<string, AntennaTestSession> =
  G.__antennaTestByReader ?? (G.__antennaTestByReader = new Map());
const byId: Map<string, AntennaTestSession> =
  G.__antennaTestById ?? (G.__antennaTestById = new Map());

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
  sweep: AntennaTestSweep | null;
  startedBy: string | null;
  rawMode?: boolean;
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
    sweep: input.sweep,
    startedBy: input.startedBy,
    startedAt: now,
    lastSeenAt: now,
    totalReadsCount: 0,
    rawMode: input.rawMode === true,
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

/** Increment the reads-counted total. Called from /api/antenna-test/ingest
 *  on every batch. /stop reads the accumulated count to decide pass/fail. */
export function recordSessionReads(id: string, n: number): void {
  const s = byId.get(id);
  if (!s) return;
  s.totalReadsCount += n;
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
