import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { authenticateAgentToken } from "@/lib/server/cdm-agents";
import { listActiveSessionsForLocation } from "@/lib/server/antenna-test-sessions";
import { listActiveSessionsForLocation as listScanSessionsForLocation } from "@/lib/server/scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-reader live POS power override.
 *
 * Cashier-driven slider in Carbon-POS writes pos_register_sessions.live_power_dbm
 * on every drag. The is_pos_dedicated reader bound to that register's agent
 * gets its spawn power overridden to this value while the register session
 * is open. NULL = use WMS-configured power.
 */
type PosPowerOverride = {
  readerId: string;
  livePowerDbm: number;
};

/**
 * Agent fast-poll for active sessions at its location.
 * Bearer-authenticated by the agent's API token. Returns only sessions for
 * the agent's own location (by joining via cdm_agents row).
 *
 * Two session families:
 *   - sessions     — antenna-test sessions (TEST_MODE: preempts the reader,
 *                    reads go to /api/antenna-test/ingest, no DB writes)
 *   - scanSessions — workflow wakes from Transfer Out / Cycle Counts /
 *                    Print-Commission. Supervisor treats the reader as
 *                    un-paused while a session is active, overriding any
 *                    persisted scan_paused_at. Reads flow through the normal
 *                    /api/cdm-agents/reads pipeline.
 *
 * Empty arrays = no workflow active; supervisor reverts to baseline (which
 * is "paused" by default in the new model).
 */

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return NextResponse.json({ error: "Missing Bearer token" }, { status: 401 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const a = await authenticateAgentToken(pool, m[1].trim());
  if (!a) return NextResponse.json({ error: "Invalid token" }, { status: 401 });

  const sessions = listActiveSessionsForLocation(a.locationId).map((s) => ({
    id: s.id,
    readerId: s.readerId,
    antennaId: s.antennaId,
    antennaNumber: s.antennaNumber,
    flags: s.flags,
    sweep: s.sweep,
    startedAt: new Date(s.startedAt).toISOString(),
  }));

  const scanSessions = listScanSessionsForLocation(a.locationId).map((s) => ({
    id: s.id,
    readerId: s.readerId,
    kind: s.kind,
    startedAt: new Date(s.startedAt).toISOString(),
  }));

  // POS register live-power overrides. Joins open register sessions to the
  // agent's is_pos_dedicated reader (one POS reader per agent, at most one
  // open session per register). NULL live_power_dbm means "no override —
  // use WMS-configured power"; we omit those rows from the response.
  const posOverridesRows = await pool.query<PosPowerOverride>(
    `SELECT d.id::text AS "readerId",
            s.live_power_dbm::int AS "livePowerDbm"
       FROM pos_register_sessions s
       JOIN pos_registers reg ON reg.id = s.register_id
       JOIN devices d ON d.cdm_agent_id = reg.cdm_agent_id
                     AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
                     AND d.is_pos_dedicated = TRUE
      WHERE s.status = 'open'
        AND s.live_power_dbm IS NOT NULL
        AND reg.cdm_agent_id = $1::uuid`,
    [a.agentId],
  );

  // POS reader recovery-arming state. The cashier's presence on a scan surface
  // (cart page / Update Item Status) refreshes monitor_armed_at; an open scan
  // modal refreshes scanning_active_at. Fresh (within 30 s — the POS heartbeat
  // is 15 s, so one missed beat still counts) means the cashier is actively
  // present, so the agent runs its
  // aggressive armed-only recovery on the POS reader; stale/absent means the
  // reader is idle and must be left alone (no resets when nobody's there).
  const posReaderStateRows = await pool.query<{
    readerId: string;
    armed: boolean;
    scanning: boolean;
  }>(
    // One row per reader: a reader is armed/scanning if ANY open register
    // session on its agent is (bool_or). Multiple open sessions can share the
    // single is_pos_dedicated reader — without the aggregate, the agent's
    // per-reader map would let a stale session's `false` clobber the active
    // session's `true`.
    `SELECT d.id::text AS "readerId",
            bool_or(s.monitor_armed_at   IS NOT NULL AND s.monitor_armed_at   > now() - interval '30 seconds') AS armed,
            bool_or(s.scanning_active_at IS NOT NULL AND s.scanning_active_at > now() - interval '30 seconds') AS scanning
       FROM pos_register_sessions s
       JOIN pos_registers reg ON reg.id = s.register_id
       JOIN devices d ON d.cdm_agent_id = reg.cdm_agent_id
                     AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
                     AND d.is_pos_dedicated = TRUE
      WHERE s.status = 'open'
        AND reg.cdm_agent_id = $1::uuid
      GROUP BY d.id`,
    [a.agentId],
  );

  return NextResponse.json(
    {
      sessions,
      scanSessions,
      posOverrides: posOverridesRows.rows,
      posReaderState: posReaderStateRows.rows,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
