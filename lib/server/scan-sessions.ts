/**
 * In-memory store of active scan-sessions.
 *
 * Distinct from antenna-test-sessions: scan-sessions are operator-driven
 * "wake the reader for this workflow" signals from the three pages allowed
 * to add EPCs to inventory:
 *   - Transfer Out  (kind: "transfer-out")
 *   - Cycle Counts  (kind: "cycle-count")
 *   - Print/Commission  (kind: "print-commission")
 *   - Encode Items   (kind: "encode-items") — RFID & Hardware → Encode
 *     Items re-encode workflow. Wakes a fixed reader so the page can
 *     stream EPCs into its table; operator picks a target custom SKU
 *     and clicks Encode to rotate each checked tag's identity via
 *     /api/rfid/encode-claim. Same single-client constraint as the
 *     other kinds.
 *
 * When a session is active for a reader, the agent's supervisor TREATS the
 * reader as un-paused (overriding any persisted scan_paused_at). The reader
 * spawns a child, scans, ingests reads through the normal /api/cdm-agents/reads
 * pipeline. When the operator commits / pauses / closes the page, the reader
 * returns to its default-paused state.
 *
 * NOT persisted — sessions evaporate on WMS restart. That's deliberate
 * (operator-driven workflow, fire-and-forget; if WMS restarts mid-flow,
 * the operator clicks Start again). No history needed at this layer.
 *
 * Thermal/safety contract: this is the ONLY mechanism that can wake a
 * default-paused reader. No background polling, no auto-resume. Without
 * an active scan-session OR a manual scan_paused_at = NULL set in the
 * Hardware Config UI, readers stay off.
 *
 * Lifecycle (operator-driven, no idle expiry):
 *   - POST /api/scan-sessions/start → createSession() → returns sessionId.
 *     Session is keyed by readerId — only ONE workflow can wake a reader
 *     at a time (single-client WIZnet bridge constraint).
 *   - Agent fast-polls /api/cdm-agents/active-sessions every 250ms; the
 *     bundle includes scan-sessions for the agent's location.
 *   - POST /api/scan-sessions/end → endSession(); agent observes empty list
 *     on next poll and the supervisor stops spawning the reader's child.
 *
 * Sessions ONLY end via:
 *   1. Explicit operator click (Stop scan / Pause / Commit)
 *   2. Page-unmount keepalive POST from the workspace (navigation away)
 *   3. Hardware Config Pause (force-end via endSessionForReader)
 *
 * There is NO idle timeout. If the browser tab is killed (crash, force-quit)
 * before unmount fires, the reader stays woken until an operator returns
 * and clicks Stop, OR an admin pauses the reader from Hardware Config. This
 * is deliberate per operator preference: "antennas off when *I* decide,
 * not when an agent thinks I went idle."
 */

import { randomUUID } from "node:crypto";

/** The pages that may wake a reader. */
export type ScanSessionKind =
  | "transfer-out"
  | "cycle-count"
  | "print-commission"
  | "encode-items"
  | "bulk-import"
  | "bulk-status"
  | "bulk-geiger"
  | "geiger"
  | "scan-epc";

export type ScanSession = {
  /** Stable opaque id; used as the lifecycle handle. */
  id: string;
  /** Session-cookie tenant_id from getSessionFromRequest(). */
  tenantId: string;
  /** Where the reader physically lives. Agent filters its poll by this. */
  locationId: string;
  /** Reader UUID being woken. */
  readerId: string;
  /** Workflow kind — used by the agent for telemetry; supervisor behavior
   *  is identical across kinds (just spawn the child like a normal reader). */
  kind: ScanSessionKind;
  /** Optional context bag — slip number for transfer-out, count session
   *  id for cycle-count, etc. Read-only after createSession. */
  context: Record<string, unknown>;
  /** Browser session cookie's user_id, for audit. */
  startedBy: string | null;
  /** ms-since-epoch of session creation. */
  startedAt: number;
  /** ms-since-epoch of the last page heartbeat (/touch or idempotent start).
   *  When a page is closed/navigated-away the heartbeat stops; the janitor
   *  ends the session GRACE_MS later → reader goes cold ~30s after you leave. */
  lastSeenAt: number;
  /** ms-since-epoch of the last tag read on this reader (bumped from the
   *  read-ingest path). Drives the 10-min no-movement auto-stop for
   *  non-cycle-count pages. Starts equal to startedAt. */
  lastReadAt: number;
};

/** Reader goes cold this long after the page stops heart-beating (left/closed). */
export const SCAN_SESSION_GRACE_MS = 30_000;
/** Non-cycle-count sessions auto-end after this long with no tag movement. */
export const SCAN_SESSION_IDLE_MS = 10 * 60_000;

const byReader = new Map<string, ScanSession>();
const byId = new Map<string, ScanSession>();

/**
 * Prune sessions that have gone stale. Called on every read of the active set
 * (the agent polls /api/cdm-agents/active-sessions constantly, so this runs
 * far more often than any setInterval would survive in serverless):
 *   - left/closed page: now − lastSeenAt > GRACE_MS  → end (~30s after leave)
 *   - idle, non-cycle-count: now − lastReadAt > IDLE_MS → end (10-min no reads)
 * Cycle counts are EXEMPT from the idle rule (a 2-hour count can sit with no
 * movement between bins) — they end only via the leave-grace or explicit stop.
 * POS readers never have scan-sessions, so they're untouched here.
 */
function pruneStaleSessions(now = Date.now()): void {
  for (const s of Array.from(byId.values())) {
    const left = now - s.lastSeenAt > SCAN_SESSION_GRACE_MS;
    const idle =
      s.kind !== "cycle-count" && now - s.lastReadAt > SCAN_SESSION_IDLE_MS;
    if (left || idle) {
      byId.delete(s.id);
      byReader.delete(s.readerId);
    }
  }
}

export function createSession(input: {
  tenantId: string;
  locationId: string;
  readerId: string;
  kind: ScanSessionKind;
  context?: Record<string, unknown>;
  startedBy: string | null;
}):
  | { ok: true; session: ScanSession }
  | { ok: false; reason: "reader_busy"; existing: ScanSession } {
  const existing = byReader.get(input.readerId);
  if (existing) {
    // Idempotency: same operator (startedBy) running the same workflow
    // kind on the same reader gets the EXISTING session back, not a
    // "reader_busy" conflict. Without this, two tabs of the same cycle
    // count (or a tab + an SWR-refresh-triggered re-claim) would fight
    // each other in a "take all" loop — observed 2026-05-12 with three
    // simultaneous cycle-count sessions accumulating 30s apart on three
    // different readers from the same user.
    //
    // True conflicts (different kind, or a different user grabbing a
    // reader you're scanning with) still surface as "reader_busy" so the
    // operator can decide whether to take over.
    if (
      existing.kind === input.kind &&
      existing.startedBy !== null &&
      existing.startedBy === input.startedBy
    ) {
      // Idempotent re-claim doubles as a heartbeat — keep it alive.
      existing.lastSeenAt = Date.now();
      return { ok: true, session: existing };
    }
    return { ok: false, reason: "reader_busy", existing };
  }
  const now = Date.now();
  const session: ScanSession = {
    id: randomUUID(),
    tenantId: input.tenantId,
    locationId: input.locationId,
    readerId: input.readerId,
    kind: input.kind,
    context: input.context ?? {},
    startedBy: input.startedBy,
    startedAt: now,
    lastSeenAt: now,
    lastReadAt: now,
  };
  byId.set(session.id, session);
  byReader.set(session.readerId, session);
  return { ok: true, session };
}

export function getSession(id: string): ScanSession | null {
  return byId.get(id) ?? null;
}

export function endSession(id: string): boolean {
  const s = byId.get(id);
  if (!s) return false;
  byId.delete(id);
  byReader.delete(s.readerId);
  return true;
}

/** Force-end any session for a reader. Used on Hardware Config Pause. */
export function endSessionForReader(readerId: string): boolean {
  const s = byReader.get(readerId);
  if (!s) return false;
  return endSession(s.id);
}

/** Heartbeat one or more sessions (page is still open). Unknown ids ignored.
 *  Returns the count that were refreshed. */
export function touchSessions(ids: readonly string[]): number {
  const now = Date.now();
  let n = 0;
  for (const id of ids) {
    const s = byId.get(id);
    if (s) {
      s.lastSeenAt = now;
      n += 1;
    }
  }
  return n;
}

/** Record tag-read activity for a reader (bumps its session's lastReadAt).
 *  Called from the read-ingest path so the 10-min idle rule reflects real
 *  tag movement. No-op if the reader has no active session. */
export function recordReadActivity(readerIds: Iterable<string>): void {
  const now = Date.now();
  for (const rid of readerIds) {
    const s = byReader.get(rid);
    if (s) s.lastReadAt = now;
  }
}

/** List active sessions for a given location (agent filter). Prunes stale
 *  sessions first — the agent polls this constantly, so it's the reliable
 *  place to enforce the leave-grace + idle rules. */
export function listActiveSessionsForLocation(locationId: string): ScanSession[] {
  pruneStaleSessions();
  return Array.from(byId.values()).filter((s) => s.locationId === locationId);
}

/** Is a reader currently woken by any scan-session? */
export function isReaderActivelyScanning(readerId: string): boolean {
  pruneStaleSessions();
  return byReader.has(readerId);
}
