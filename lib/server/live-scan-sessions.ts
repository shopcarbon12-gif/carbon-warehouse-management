/**
 * In-memory store of live-scan sessions — the dashboard's master ON/OFF
 * toggle for fixed-reader scanning.
 *
 * Default state across the system is "no readers scanning." A reader
 * only scans when ALL of these are true:
 *   1. There is an active live-scan session for the tenant (this module).
 *   2. The reader's manual `scan_paused_at` is NULL (per-reader pause —
 *      see lib/server/cdm-devices.ts and devices.scan_paused_at).
 *   3. The reader's schedule (devices.scan_schedule) does not put it in
 *      a paused window right now.
 *
 * Lifecycle:
 *   - POST /api/dashboard/live-scan/start  → upsertSession(tenantId)
 *   - GET  /api/dashboard/live-scan/state  → getSession(tenantId) AND
 *     touchSession(tenantId). The dashboard polls this every 2 s for
 *     counter updates; that GET doubles as the heartbeat.
 *   - POST /api/dashboard/live-scan/stop   → endSession(tenantId)
 *   - Auto-expire: if `lastSeenAt` is older than SESSION_MAX_IDLE_MS,
 *     `getActiveSession()` returns null. This handles tab close /
 *     internet drop / laptop sleep — the agent's next config poll (≤3 s)
 *     sees `live_scan_active: false` and pauses every reader.
 *
 * NOT persisted across WMS restarts. That's deliberate: a server restart
 * means scanning stops, which is the safe default. Operator clicks the
 * Live Scans tile to resume.
 */

import { randomUUID } from "node:crypto";

export type LiveScanSession = {
  /** Stable opaque id; useful for client-side correlation. */
  id: string;
  /** Tenant the session belongs to. One session at most per tenant. */
  tenantId: string;
  /** Browser-session user_id of who clicked Start. Audit only. */
  startedBy: string | null;
  /** ms-since-epoch of session creation. Used to compute counter from
   *  cdm_reads.ingested_at. Each new session has a fresh value, which is
   *  why the dashboard counter resets on every Start click. */
  startedAt: number;
  /** ms-since-epoch of the last GET /state hit. Sessions auto-expire
   *  when this gets older than SESSION_MAX_IDLE_MS. */
  lastSeenAt: number;
};

/**
 * Idle longer than this and the session is auto-dropped. The dashboard
 * polls /state every 2 s to refresh the counter, so 60 s allows ~30
 * missed polls before pruning — enough to ride out a wifi blip but
 * tight enough that a closed tab releases readers within a minute.
 */
const SESSION_MAX_IDLE_MS = 60_000;

const byTenant = new Map<string, LiveScanSession>();

function pruneStale(now: number): void {
  for (const [tid, s] of byTenant) {
    if (now - s.lastSeenAt > SESSION_MAX_IDLE_MS) byTenant.delete(tid);
  }
}

/**
 * Idempotent: if a session already exists for this tenant, return it
 * (with `lastSeenAt` refreshed). Otherwise create one. This means
 * clicking "Start" twice in different tabs doesn't create two sessions.
 */
export function upsertSession(input: {
  tenantId: string;
  startedBy: string | null;
}): LiveScanSession {
  const now = Date.now();
  pruneStale(now);
  const existing = byTenant.get(input.tenantId);
  if (existing) {
    existing.lastSeenAt = now;
    return existing;
  }
  const session: LiveScanSession = {
    id: randomUUID(),
    tenantId: input.tenantId,
    startedBy: input.startedBy,
    startedAt: now,
    lastSeenAt: now,
  };
  byTenant.set(input.tenantId, session);
  return session;
}

/**
 * Returns the tenant's session iff it exists AND hasn't gone stale.
 * Side-effect: refreshes `lastSeenAt` if found. The agent's config-poll
 * code path on the server uses this for `live_scan_active` evaluation.
 */
export function touchSession(tenantId: string): LiveScanSession | null {
  const now = Date.now();
  pruneStale(now);
  const s = byTenant.get(tenantId);
  if (!s) return null;
  s.lastSeenAt = now;
  return s;
}

/**
 * Read-only check used by the agent's bundle endpoint — does NOT touch
 * lastSeenAt, because the agent polling shouldn't keep an abandoned
 * dashboard session alive.
 */
export function isLiveScanActive(tenantId: string): boolean {
  const now = Date.now();
  pruneStale(now);
  const s = byTenant.get(tenantId);
  return s !== undefined;
}

export function endSession(tenantId: string): boolean {
  const existed = byTenant.delete(tenantId);
  return existed;
}

/** When the session started (ms epoch) — needed to compute the counter. */
export function getSessionStartedAt(tenantId: string): number | null {
  pruneStale(Date.now());
  return byTenant.get(tenantId)?.startedAt ?? null;
}
