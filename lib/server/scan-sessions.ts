/**
 * In-memory store of active scan-sessions.
 *
 * Distinct from antenna-test-sessions: scan-sessions are operator-driven
 * "wake the reader for this workflow" signals from the three pages allowed
 * to add EPCs to inventory:
 *   - Transfer Out  (kind: "transfer-out")
 *   - Cycle Counts  (kind: "cycle-count")
 *   - Print/Commission  (kind: "print-commission")
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

/** The three pages that may wake a reader. */
export type ScanSessionKind = "transfer-out" | "cycle-count" | "print-commission";

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
};

const byReader = new Map<string, ScanSession>();
const byId = new Map<string, ScanSession>();

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
  if (existing) return { ok: false, reason: "reader_busy", existing };
  const session: ScanSession = {
    id: randomUUID(),
    tenantId: input.tenantId,
    locationId: input.locationId,
    readerId: input.readerId,
    kind: input.kind,
    context: input.context ?? {},
    startedBy: input.startedBy,
    startedAt: Date.now(),
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

/** List active sessions for a given location (agent filter). */
export function listActiveSessionsForLocation(locationId: string): ScanSession[] {
  return Array.from(byId.values()).filter((s) => s.locationId === locationId);
}

/** Is a reader currently woken by any scan-session? */
export function isReaderActivelyScanning(readerId: string): boolean {
  return byReader.has(readerId);
}
