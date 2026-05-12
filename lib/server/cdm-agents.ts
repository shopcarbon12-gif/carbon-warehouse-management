import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { publishEdgeScanEvent } from "@/lib/server/edge-scan-hub";
import { decodeEpc } from "@/lib/server/epc-decode";
import { loadEpcConfig } from "@/lib/server/epc-ingress";
import { isLiveScanActive } from "@/lib/server/live-scan-sessions";
import {
  isReaderEffectivelyPaused,
  type ScanSchedule,
} from "@/lib/server/scan-schedule";

export type CdmAgentRow = {
  id: string;
  tenant_id: string;
  location_id: string;
  location_code: string;
  location_name: string;
  name: string;
  hostname: string | null;
  status: "online" | "offline" | "degraded";
  agent_version: string | null;
  last_heartbeat_at: string | null;
  device_count: number;
  created_at: string;
  updated_at: string;
};

export const upsertCdmAgentSchema = z.object({
  id: z.string().uuid().optional(),
  locationId: z.string().uuid(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers, and hyphens only"),
  hostname: z.string().trim().max(256).nullable().optional(),
});

export type UpsertCdmAgentBody = z.infer<typeof upsertCdmAgentSchema>;

export const heartbeatSchema = z.object({
  agentVersion: z.string().trim().max(32),
  hostname: z.string().trim().max(256).optional(),
  status: z.enum(["online", "degraded"]).default("online"),
  /** Agent's process boot time (ISO). Server compares this against
   *  `recover_requested_at` to decide whether to ask the agent to exit. */
  bootTimeIso: z.string().datetime().optional(),
  /** Readers the supervisor flagged as Level-3 hardware-wedged. Each entry
   *  stamps `devices.chassis_wedged_at`. Readers in the agent's bundle but
   *  absent from this list get the column cleared (self-healed). */
  wedgedReaders: z
    .array(
      z.object({
        readerId: z.string().uuid(),
        wedgedSinceMs: z.number().int().nonnegative(),
      }),
    )
    .max(64)
    .optional(),
  /** Auto-sweep diagnosed a sub-configured working power for these readers.
   *  Stamped on each enabled antenna of the reader as `suggested_power_dbm`.
   *  Hardware Config surfaces a one-click apply banner. Operator approves
   *  the actual config change — supervisor never silently downgrades. */
  powerSuggestions: z
    .array(
      z.object({
        readerId: z.string().uuid(),
        suggestedDbm: z.number().int().min(0).max(33),
      }),
    )
    .max(64)
    .optional(),
});

export type HeartbeatBody = z.infer<typeof heartbeatSchema>;

export type HeartbeatResult = {
  /** True iff `recover_requested_at` is newer than the agent's boot_time.
   *  Agent should exit cleanly; systemd will respawn within RestartSec. */
  restart_requested: boolean;
};

export type AgentDiagnosis = {
  agent_id: string;
  agent_name: string;
  status: string;
  last_heartbeat_at: string | null;
  last_heartbeat_age_seconds: number | null;
  recover_requested_at: string | null;
  readers: {
    id: string;
    name: string;
    network_address: string | null;
    monsoon_driver: string;
    is_authorized: boolean;
  }[];
  recent_reads: {
    last_read_at: string | null;
    reads_last_5_min: number;
    reads_last_hour: number;
  };
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateAgentToken(): string {
  return `cdm_${randomBytes(24).toString("hex")}`;
}

export async function listCdmAgentsForTenant(
  pool: Pool,
  tenantId: string,
  /** Active location to scope the result to. Pass null/undefined for all. */
  locationId?: string | null,
): Promise<CdmAgentRow[]> {
  const scoped = !!locationId;
  const r = await pool.query<CdmAgentRow>(
    `SELECT
       a.id::text,
       a.tenant_id::text,
       a.location_id::text,
       l.code AS location_code,
       l.name AS location_name,
       a.name,
       a.hostname,
       a.status,
       a.agent_version,
       a.last_heartbeat_at::text,
       COALESCE(d_count.total, 0)::int AS device_count,
       a.created_at::text,
       a.updated_at::text
     FROM cdm_agents a
     INNER JOIN locations l ON l.id = a.location_id AND l.tenant_id = a.tenant_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS total FROM devices d WHERE d.cdm_agent_id = a.id
     ) d_count ON TRUE
     WHERE a.tenant_id = $1::uuid
       ${scoped ? "AND a.location_id = $2::uuid" : ""}
     ORDER BY l.code ASC, a.name ASC`,
    scoped ? [tenantId, locationId] : [tenantId],
  );
  return r.rows;
}

export async function getCdmAgentById(
  pool: Pool,
  tenantId: string,
  id: string,
): Promise<CdmAgentRow | null> {
  const r = await pool.query<CdmAgentRow>(
    `SELECT
       a.id::text,
       a.tenant_id::text,
       a.location_id::text,
       l.code AS location_code,
       l.name AS location_name,
       a.name,
       a.hostname,
       a.status,
       a.agent_version,
       a.last_heartbeat_at::text,
       0::int AS device_count,
       a.created_at::text,
       a.updated_at::text
     FROM cdm_agents a
     INNER JOIN locations l ON l.id = a.location_id AND l.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1::uuid AND a.id = $2::uuid`,
    [tenantId, id],
  );
  return r.rows[0] ?? null;
}

export async function upsertCdmAgent(
  client: PoolClient,
  tenantId: string,
  body: UpsertCdmAgentBody,
): Promise<{ id: string; token?: string }> {
  const locCheck = await client.query<{ id: string }>(
    `SELECT id::text FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [body.locationId, tenantId],
  );
  if (locCheck.rowCount === 0) {
    throw new Error("BAD_REQUEST:Location not found for this tenant");
  }

  if (body.id) {
    const r = await client.query<{ id: string }>(
      `UPDATE cdm_agents
         SET name = $3,
             hostname = $4,
             updated_at = now()
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       RETURNING id::text`,
      [body.id, tenantId, body.name, body.hostname ?? null],
    );
    if (r.rowCount === 0) {
      throw new Error("BAD_REQUEST:Agent not found");
    }
    return { id: r.rows[0].id };
  }

  const token = generateAgentToken();
  const r = await client.query<{ id: string }>(
    `INSERT INTO cdm_agents (tenant_id, location_id, name, hostname, api_token_hash, status)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'offline')
     ON CONFLICT (location_id, lower(name)) DO UPDATE
       SET hostname = EXCLUDED.hostname,
           updated_at = now()
     RETURNING id::text`,
    [tenantId, body.locationId, body.name, body.hostname ?? null, hashToken(token)],
  );
  return { id: r.rows[0].id, token };
}

export async function regenerateAgentToken(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<{ token: string }> {
  const token = generateAgentToken();
  const r = await client.query(
    `UPDATE cdm_agents
       SET api_token_hash = $3,
           updated_at = now()
     WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, tenantId, hashToken(token)],
  );
  if ((r.rowCount ?? 0) === 0) {
    throw new Error("BAD_REQUEST:Agent not found");
  }
  return { token };
}

/**
 * Bounded TTL sweep over `cdm_reads`. Piggybacks on agent heartbeats
 * (~30 s cadence per agent) — each call deletes at most LIMIT old rows so
 * a single sweep can never lock the table for long. Belt-and-suspenders
 * for the passes_formula filter shipped in `ingestAgentReads`: even if a
 * future code path bypasses the filter, this caps the table's lifetime.
 *
 * Lifetime: 48 h. Live-scan dashboards only query the last 15 min; the
 * EPC tracker's "recently seen" panel queries the last 24 h. 48 h gives
 * a comfortable margin without ever hitting the disk-pressure failure
 * mode that took prod down on 2026-05-10.
 *
 * Caller should swallow errors — a failed sweep must not break heartbeat.
 */
export async function pruneOldCdmReads(
  client: PoolClient,
  retentionHours = 48,
  batchLimit = 5000,
): Promise<number> {
  const r = await client.query(
    `DELETE FROM cdm_reads
       WHERE ctid IN (
         SELECT ctid FROM cdm_reads
           WHERE read_at < now() - ($1::int || ' hours')::interval
           LIMIT $2
       )`,
    [retentionHours, batchLimit],
  );
  return r.rowCount ?? 0;
}

export async function recordAgentHeartbeat(
  client: PoolClient,
  agentId: string,
  body: HeartbeatBody,
  publicIp: string | null = null,
): Promise<HeartbeatResult> {
  const r = await client.query<{ recover_requested_at: string | null }>(
    `UPDATE cdm_agents
       SET status = $2,
           agent_version = $3,
           hostname = COALESCE($4, hostname),
           last_heartbeat_at = now(),
           last_known_public_ip = COALESCE($5, last_known_public_ip),
           last_known_public_ip_at = CASE WHEN $5 IS NOT NULL THEN now() ELSE last_known_public_ip_at END,
           updated_at = now()
     WHERE id = $1::uuid
     RETURNING recover_requested_at::text`,
    [agentId, body.status, body.agentVersion, body.hostname ?? null, publicIp],
  );
  const recoverRequestedAt = r.rows[0]?.recover_requested_at ?? null;
  let restartRequested = false;
  if (recoverRequestedAt && body.bootTimeIso) {
    const recoverMs = Date.parse(recoverRequestedAt);
    const bootMs = Date.parse(body.bootTimeIso);
    if (Number.isFinite(recoverMs) && Number.isFinite(bootMs) && recoverMs > bootMs) {
      restartRequested = true;
    }
  }

  // Sync `chassis_wedged_at` from the agent's wedge-Level-3 list. Readers
  // in the agent's bundle that aren't in the wedged list get their flag
  // cleared (self-healed). Readers owned by OTHER agents are untouched.
  const wedgedIds = (body.wedgedReaders ?? []).map((w) => w.readerId);
  if (wedgedIds.length > 0) {
    await client.query(
      `UPDATE devices
         SET chassis_wedged_at = now(), updated_at = now()
         WHERE cdm_agent_id = $1::uuid
           AND id = ANY($2::uuid[])
           AND chassis_wedged_at IS NULL`,
      [agentId, wedgedIds],
    );
  }
  await client.query(
    `UPDATE devices
       SET chassis_wedged_at = NULL, updated_at = now()
       WHERE cdm_agent_id = $1::uuid
         AND chassis_wedged_at IS NOT NULL
         AND NOT (id = ANY($2::uuid[]))`,
    [agentId, wedgedIds],
  );

  // Sync power suggestions onto antenna rows. The supervisor reports per-
  // reader; we propagate to every enabled antenna of that reader since the
  // sweep finding applies to the chassis radio shared by them all. Cleared
  // for any reader owned by this agent that isn't in the suggestion list.
  const suggestions = body.powerSuggestions ?? [];
  for (const s of suggestions) {
    await client.query(
      `UPDATE devices
         SET suggested_power_dbm = $3::int,
             suggested_power_dbm_at = now(),
             updated_at = now()
         WHERE parent_device_id = $2::uuid
           AND device_type = 'antenna'
           AND tenant_id IN (
             SELECT tenant_id FROM cdm_agents WHERE id = $1::uuid
           )`,
      [agentId, s.readerId, s.suggestedDbm],
    );
  }
  const suggestedReaderIds = suggestions.map((s) => s.readerId);
  await client.query(
    `UPDATE devices
       SET suggested_power_dbm = NULL,
           suggested_power_dbm_at = NULL,
           updated_at = now()
       WHERE device_type = 'antenna'
         AND suggested_power_dbm IS NOT NULL
         AND parent_device_id IN (
           SELECT id FROM devices
             WHERE cdm_agent_id = $1::uuid
               AND NOT (id = ANY($2::uuid[]))
         )`,
    [agentId, suggestedReaderIds],
  );

  return { restart_requested: restartRequested };
}

/**
 * Admin-driven "recover" — stamps the cdm_agents row so the agent's next
 * heartbeat sees a request newer than its boot_time and exits cleanly.
 * systemd respawns it (Restart=always, RestartSec=5), wiping every stuck
 * child binary and resetting all supervisor slot state.
 */
export async function requestAgentRecover(
  client: PoolClient,
  tenantId: string,
  agentId: string,
  userId: string,
): Promise<{ recover_requested_at: string }> {
  const r = await client.query<{ recover_requested_at: string }>(
    `UPDATE cdm_agents
       SET recover_requested_at = now(),
           recover_requested_by = $3::uuid,
           updated_at = now()
     WHERE id = $1::uuid AND tenant_id = $2::uuid
     RETURNING recover_requested_at::text`,
    [agentId, tenantId, userId],
  );
  if (r.rowCount === 0 || !r.rows[0]) {
    throw new Error("BAD_REQUEST:Agent not found for tenant");
  }
  return { recover_requested_at: r.rows[0].recover_requested_at };
}

/**
 * Snapshot for the recover-button modal — agent + reader + recent-read
 * health all in one query bundle. Read-only.
 */
export async function getAgentDiagnosis(
  pool: Pool,
  tenantId: string,
  agentId: string,
): Promise<AgentDiagnosis | null> {
  const ag = await pool.query<{
    id: string;
    name: string;
    status: string;
    last_heartbeat_at: string | null;
    recover_requested_at: string | null;
  }>(
    `SELECT id::text, name, status, last_heartbeat_at::text, recover_requested_at::text
       FROM cdm_agents WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [agentId, tenantId],
  );
  if (ag.rowCount === 0 || !ag.rows[0]) return null;
  const a = ag.rows[0];

  const readers = await pool.query<{
    id: string;
    name: string;
    network_address: string | null;
    monsoon_driver: string;
    is_authorized: boolean;
  }>(
    // Default null monsoon_driver to 'console', NOT 'stream'. The agent
    // bundle builder (line ~590, `cfg.monsoon_driver === "stream" ? "stream" :
    // "console"`) treats anything-not-stream as console at runtime, so the
    // diagnosis snapshot must mirror that or the Recover modal misleads
    // operators into thinking a reader is on stream when the supervisor is
    // actually running new_monsoonreader (console binary). The console driver
    // is the project-wide default — see project_console_driver_preferred memo.
    `SELECT d.id::text, d.name, d.network_address,
            COALESCE(d.config->>'monsoon_driver', 'console') AS monsoon_driver,
            d.is_authorized
       FROM devices d
      WHERE d.cdm_agent_id = $1::uuid
        AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
      ORDER BY d.name ASC`,
    [agentId],
  );

  const reads = await pool.query<{
    last_read_at: string | null;
    reads_5m: string;
    reads_1h: string;
  }>(
    `SELECT max(ingested_at)::text AS last_read_at,
            count(*) FILTER (WHERE ingested_at > now() - interval '5 minutes')::text AS reads_5m,
            count(*) FILTER (WHERE ingested_at > now() - interval '1 hour')::text   AS reads_1h
       FROM cdm_reads
      WHERE cdm_agent_id = $1::uuid`,
    [agentId],
  );
  const rs = reads.rows[0] ?? { last_read_at: null, reads_5m: "0", reads_1h: "0" };

  const lastHbMs = a.last_heartbeat_at ? Date.parse(a.last_heartbeat_at) : null;
  const ageSec =
    lastHbMs && Number.isFinite(lastHbMs) ? Math.round((Date.now() - lastHbMs) / 1000) : null;

  return {
    agent_id: a.id,
    agent_name: a.name,
    status: a.status,
    last_heartbeat_at: a.last_heartbeat_at,
    last_heartbeat_age_seconds: ageSec,
    recover_requested_at: a.recover_requested_at,
    readers: readers.rows,
    recent_reads: {
      last_read_at: rs.last_read_at,
      reads_last_5_min: Number(rs.reads_5m),
      reads_last_hour: Number(rs.reads_1h),
    },
  };
}

/**
 * Find an agent (any tenant) whose last_known_public_ip matches the given
 * IP and whose last heartbeat was recent (≤5 min). Used by the dashboard's
 * auto-eligible endpoint and the public network-prewarm endpoint to
 * decide whether the requester is on the same public network as a live
 * agent. Returns the matching agent's tenant_id (so prewarm can create
 * the live-scan session for the right tenant) or null.
 */
export async function findAgentByPublicIp(
  pool: Pool,
  publicIp: string,
): Promise<{ agentId: string; tenantId: string } | null> {
  if (!publicIp) return null;
  const r = await pool.query<{ id: string; tenant_id: string }>(
    `SELECT id::text, tenant_id::text
       FROM cdm_agents
      WHERE last_known_public_ip = $1
        AND last_known_public_ip_at > now() - interval '5 minutes'
      ORDER BY last_known_public_ip_at DESC
      LIMIT 1`,
    [publicIp],
  );
  if (r.rowCount === 0 || !r.rows[0]) return null;
  return { agentId: r.rows[0].id, tenantId: r.rows[0].tenant_id };
}

/** Verifies a Bearer token from the Carbon CDM agent. Returns agent if valid, null otherwise. */
export async function authenticateAgentToken(
  pool: Pool,
  token: string,
): Promise<{ agentId: string; tenantId: string; locationId: string } | null> {
  if (!token.startsWith("cdm_")) return null;
  const hash = hashToken(token);
  const r = await pool.query<{ id: string; tenant_id: string; location_id: string }>(
    `SELECT id::text, tenant_id::text, location_id::text
       FROM cdm_agents
       WHERE api_token_hash = $1
       LIMIT 1`,
    [hash],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return { agentId: row.id, tenantId: row.tenant_id, locationId: row.location_id };
}

export async function deleteCdmAgent(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<{ deleted: boolean }> {
  const r = await client.query(
    `DELETE FROM cdm_agents WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, tenantId],
  );
  return { deleted: (r.rowCount ?? 0) > 0 };
}

// ──────────────────────────────────────────────────────────────────────────
// Agent-side config bundle: what readers this agent should manage.
// Consumed by the Carbon CDM agent on startup and on every config-poll tick.
// ──────────────────────────────────────────────────────────────────────────

export type AgentConfigAntenna = {
  id: string;
  name: string;
  antenna_number: number;
  transmit_power_dbm: number;
  enabled: boolean;
  /**
   * Set when the operator clicks "TEST" in Hardware Config. The agent
   * runs a 30-second listen window on the parent reader's stream and
   * POSTs the result to /api/cdm-agents/antenna-test-result.
   * Null = no test pending.
   */
  test_pending_at: string | null;
  /** Operator-saved radio defaults from /antenna_test → "Save as default".
   *  Agent uses these for normal-scan spawns; transmit_power_dbm remains
   *  the canonical source for the power dimension. */
  behaviour?: {
    read_time_ms: number;
    cycle_mode: "infinite" | "oscillating";
    tag_focus: boolean;
  };
};

export type AgentConfigReader = {
  id: string;
  name: string;
  device_type: string;
  network_address: string | null;
  model: string;
  monsoon_serial_port: number;
  stream_port: number;
  control_port: number;
  antenna_count: number;
  epc_prefix: string;
  /** Which Mojix binary the agent's supervisor should drive for this reader.
   *  - "stream"  (default): legacy 2019 `MonsoonReader --stream` binary; binary
   *               TCP records, prone to alive-but-stuck stalls, needs watchdog.
   *  - "console": 2024 `new_monsoonreader --console` binary; text stdout, CRC
   *               filtered at the binary, streams continuously. Senitron's
   *               current production. Pilot enabled per-reader 2026-05-01.
   */
  monsoon_driver: "stream" | "console";
  zone_id: string | null;
  zone_name: string | null;
  antennas: AgentConfigAntenna[];
  /** Effective pause state (per-reader manual + per-reader schedule).
   *  Computed server-side on every bundle response so the agent doesn't
   *  redo schedule math. When true, the supervisor skips this reader
   *  entirely (kills any running child, doesn't spawn). */
  effective_paused: boolean;
  /** Admin Hard Reset stamp. Supervisor compares to slot.spawnedAt on each
   *  config-pull; if newer, force-recreates the slot (stopSlot + free
   *  index + drop from map → next reconcile re-spawns with fresh state).
   *  Null = no reset pending. */
  reader_recover_requested_at: string | null;
  /** WIZnet bridge MAC, pulled from devices.mac_address. Agent uses this
   *  for `wiznet-cli --reset` recovery calls. Older bundles may omit;
   *  agent falls back to `ip neigh` ARP lookup. */
  mac_address?: string | null;
  /** Per-reader forced respawn cadence (ms). When > 0, the supervisor
   *  kills+respawns the binary every N ms in normal scanning to refresh
   *  the chip's session state — used on chassis that exhibit Gen2
   *  inventory deadlock under long-running `--infinite` mode. Pulled
   *  from `devices.config.force_respawn_interval_ms`. NULL/missing =
   *  no forced respawn (default for healthy chassis). */
  force_respawn_interval_ms?: number | null;
};

export type AgentConfigBundle = {
  agent: { id: string; name: string; location_id: string; location_code: string };
  readers: AgentConfigReader[];
  /** Server-side time, useful for the agent to detect clock skew. */
  server_time: string;
  /** Master scan toggle, evaluated server-side from the tenant's
   *  live-scan session store. False = no readers should scan, regardless
   *  of any other config. The agent uses this as the outermost gate in
   *  its supervisor reconcile loop. */
  live_scan_active: boolean;
};

export async function getAgentConfigBundle(
  pool: Pool,
  agentId: string,
): Promise<AgentConfigBundle | null> {
  const ag = await pool.query<{
    id: string;
    name: string;
    location_id: string;
    location_code: string;
    tenant_id: string;
  }>(
    `SELECT a.id::text, a.name, a.location_id::text, l.code AS location_code,
            a.tenant_id::text
       FROM cdm_agents a
       JOIN locations l ON l.id = a.location_id
       WHERE a.id = $1::uuid`,
    [agentId],
  );
  if (ag.rowCount === 0) return null;
  const tenantId = ag.rows[0].tenant_id;

  const devices = await pool.query<{
    id: string;
    device_type: string;
    name: string;
    network_address: string | null;
    config: Record<string, unknown>;
    parent_device_id: string | null;
    zone_id: string | null;
    zone_name: string | null;
    test_pending_at: string | null;
    scan_paused_at: string | null;
    scan_schedule: ScanSchedule | null;
    reader_recover_requested_at: string | null;
    mac_address: string | null;
  }>(
    `SELECT
       d.id::text,
       d.device_type,
       d.name,
       d.network_address,
       COALESCE(d.config, '{}'::jsonb) AS config,
       d.parent_device_id::text,
       d.zone_id::text,
       z.name AS zone_name,
       d.test_pending_at,
       d.scan_paused_at::text AS scan_paused_at,
       d.scan_schedule,
       d.reader_recover_requested_at::text AS reader_recover_requested_at,
       d.mac_address
     FROM devices d
     LEFT JOIN zones z ON z.id = d.zone_id
     WHERE d.cdm_agent_id = $1::uuid
       AND d.device_type IN ('fixed_reader','transaction_reader','door_reader','antenna')
     -- Include reader's own antennas even when antenna.cdm_agent_id is NULL
     OR (d.device_type = 'antenna' AND d.parent_device_id IN (
          SELECT id FROM devices WHERE cdm_agent_id = $1::uuid
        ))
     ORDER BY d.name ASC`,
    [agentId],
  );

  const antennasByParent = new Map<string, AgentConfigAntenna[]>();
  for (const d of devices.rows) {
    if (d.device_type !== "antenna" || !d.parent_device_id) continue;
    const cfg = d.config as {
      antenna_number?: number;
      transmit_power_dbm?: number;
      enabled?: boolean;
      behaviour?: {
        read_time_ms?: number;
        cycle_mode?: "infinite" | "oscillating";
        tag_focus?: boolean;
      };
    };
    const arr = antennasByParent.get(d.parent_device_id) ?? [];
    const behaviour =
      cfg.behaviour && typeof cfg.behaviour === "object"
        ? {
            read_time_ms: Number(cfg.behaviour.read_time_ms ?? 1000),
            cycle_mode: (cfg.behaviour.cycle_mode === "oscillating"
              ? "oscillating"
              : "infinite") as "infinite" | "oscillating",
            tag_focus: cfg.behaviour.tag_focus === true,
          }
        : undefined;
    arr.push({
      id: d.id,
      name: d.name,
      antenna_number: Number(cfg.antenna_number ?? 1),
      transmit_power_dbm: Number(cfg.transmit_power_dbm ?? 30),
      enabled: cfg.enabled !== false,
      test_pending_at: d.test_pending_at,
      behaviour,
    });
    antennasByParent.set(d.parent_device_id, arr);
  }

  const readers: AgentConfigReader[] = [];
  for (const d of devices.rows) {
    if (d.device_type === "antenna") continue;
    const cfg = d.config as {
      model?: string;
      monsoon_serial_port?: number;
      stream_port?: number;
      control_port?: number;
      antenna_count?: number;
      epc_prefix?: string;
      monsoon_driver?: string;
      force_respawn_interval_ms?: number;
    };
    const list = antennasByParent.get(d.id) ?? [];
    list.sort((a, b) => a.antenna_number - b.antenna_number);
    readers.push({
      id: d.id,
      name: d.name,
      device_type: d.device_type,
      network_address: d.network_address,
      model: String(cfg.model ?? "SA-2000"),
      monsoon_serial_port: Number(cfg.monsoon_serial_port ?? 10002),
      stream_port: Number(cfg.stream_port ?? 30100),
      control_port: Number(cfg.control_port ?? 20100),
      antenna_count: Number(cfg.antenna_count ?? (list.length || 1)),
      epc_prefix: String(cfg.epc_prefix ?? ""),
      monsoon_driver: cfg.monsoon_driver === "stream" ? "stream" : "console",
      zone_id: d.zone_id,
      zone_name: d.zone_name,
      antennas: list,
      effective_paused: isReaderEffectivelyPaused(
        d.scan_paused_at,
        d.scan_schedule,
      ),
      reader_recover_requested_at: d.reader_recover_requested_at,
      force_respawn_interval_ms:
        cfg.force_respawn_interval_ms && cfg.force_respawn_interval_ms > 0
          ? Number(cfg.force_respawn_interval_ms)
          : null,
      mac_address: d.mac_address,
    });
  }

  return {
    agent: {
      id: ag.rows[0].id,
      name: ag.rows[0].name,
      location_id: ag.rows[0].location_id,
      location_code: ag.rows[0].location_code,
    },
    readers,
    server_time: new Date().toISOString(),
    live_scan_active: isLiveScanActive(tenantId),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Agent-side tag-read ingest. The Carbon CDM agent batches reads off the
// MonsoonReader stream and POSTs them here.
// ──────────────────────────────────────────────────────────────────────────

const tagReadSchema = z.object({
  epcHex: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(48)
    .regex(/^[0-9a-f]+$/),
  antennaNumber: z.coerce.number().int().min(1).max(32).optional(),
  rssi: z.coerce.number().int().min(-200).max(0).optional(),
  readAt: z.string().optional(),
});

export const ingestReadsSchema = z.object({
  readerId: z.string().uuid(),
  reads: z.array(tagReadSchema).min(1).max(2000),
});

export type IngestReadsBody = z.infer<typeof ingestReadsSchema>;

// Per-reader antenna_number → antenna UUID lookup. The previous version of
// this cache had no expiry, which meant a reader whose first read landed
// before its antenna devices were configured would cache an empty map
// forever — every subsequent read got antenna_id=NULL, the per-antenna
// panel showed 0 across the board even while the headline counter climbed.
// A 60-s TTL self-heals out-of-order commissioning at the cost of one
// indexed lookup per reader per minute.
const ANTENNA_CACHE_TTL_MS = 60_000;
const ANTENNA_CACHE = new Map<string, { map: Map<number, string>; expiresAt: number }>();


async function getAntennaIdMap(
  client: PoolClient,
  readerId: string,
): Promise<Map<number, string>> {
  const now = Date.now();
  const cached = ANTENNA_CACHE.get(readerId);
  if (cached && cached.expiresAt > now) return cached.map;
  const r = await client.query<{ id: string; antenna_number: string }>(
    `SELECT id::text, (config->>'antenna_number') AS antenna_number
       FROM devices
       WHERE parent_device_id = $1::uuid AND device_type = 'antenna'`,
    [readerId],
  );
  const map = new Map<number, string>();
  for (const row of r.rows) {
    const num = Number(row.antenna_number);
    if (!Number.isNaN(num)) map.set(num, row.id);
  }
  ANTENNA_CACHE.set(readerId, { map, expiresAt: now + ANTENNA_CACHE_TTL_MS });
  return map;
}

/** Allow the supervisor to drop the cache on config change. */
export function invalidateAntennaCache(): void {
  ANTENNA_CACHE.clear();
}

/**
 * Ingest a batch of reads. Validates the agent owns the reader, looks up
 * each antenna's UUID by its number, then bulk-inserts into cdm_reads.
 */
export async function ingestAgentReads(
  client: PoolClient,
  auth: { agentId: string; tenantId: string },
  body: IngestReadsBody,
): Promise<{ inserted: number }> {
  const ownership = await client.query<{
    id: string;
    location_id: string;
    name: string;
    network_address: string | null;
  }>(
    `SELECT id::text, location_id::text, name, network_address FROM devices
       WHERE id = $1::uuid AND tenant_id = $2::uuid AND cdm_agent_id = $3::uuid
         AND device_type IN ('fixed_reader','transaction_reader','door_reader')`,
    [body.readerId, auth.tenantId, auth.agentId],
  );
  if (ownership.rowCount === 0) {
    throw new Error("BAD_REQUEST:Reader not found or not owned by this agent");
  }
  const readerName = ownership.rows[0].name;

  // ── Live-scan formula evaluation (no items mutation) ──
  // Background reads from fixed readers must NEVER write to the items
  // table. The operator's expectation is that live scan is purely an
  // observation tool: see what your antennas are picking up right now,
  // don't silently grow inventory or the defective bin. The actual
  // status-flipping ("this EPC is now `in-stock`" / "this EPC is now
  // `tag_killed`") happens only when an operator explicitly resumes a
  // cycle count or scan-finalize flow on those dedicated pages — those
  // call `ingestEpcs` from their own ingestion paths and are unaffected
  // by what's removed here.
  //
  // Live scan's "real EPC" view still requires the decoder to run, so
  // garbage reads (non-Carbon, malformed) don't inflate the counter.
  // We run the decoder per unique EPC in this batch and stamp a
  // `passes_formula` boolean on each cdm_reads row. The /state and
  // /per-antenna queries then filter on `passes_formula = true` to show
  // only structurally-valid Carbon tags.
  //
  // Decoder is pure (no DB calls) so calling it per EPC is cheap; the
  // tenant config is loaded once per request and cached for the lifetime
  // of the cache TTL inside epc-ingress.
  const antennaIdMap = await getAntennaIdMap(client, body.readerId);
  const dedupedEpcs = Array.from(new Set(body.reads.map((r) => r.epcHex.toUpperCase())));
  const passesFormulaByEpc = new Map<string, boolean>();
  if (dedupedEpcs.length > 0) {
    const epcConfig = await loadEpcConfig(client, auth.tenantId);
    if (epcConfig) {
      for (const epc of dedupedEpcs) {
        passesFormulaByEpc.set(epc, decodeEpc(epc, epcConfig).valid);
      }
    } else {
      // Tenant has no epc-config row (should not happen post-migration
      // 032). Without a decoder we can't say which reads pass; mark all
      // as failing so live scan doesn't show garbage.
      for (const epc of dedupedEpcs) passesFormulaByEpc.set(epc, false);
    }
  }
  // Antenna lookup map is needed below for the cdm_reads insert too — already loaded above.
  if (body.reads.length === 0) return { inserted: 0 };

  const tenantIds: string[] = [];
  const agentIds: string[] = [];
  const readerIds: string[] = [];
  const antennaIds: (string | null)[] = [];
  const epcs: string[] = [];
  const rssis: (number | null)[] = [];
  const readAts: string[] = [];
  const passesFormulas: boolean[] = [];
  const now = new Date().toISOString();

  for (const r of body.reads) {
    tenantIds.push(auth.tenantId);
    agentIds.push(auth.agentId);
    readerIds.push(body.readerId);
    antennaIds.push(
      r.antennaNumber !== undefined ? antennaIdMap.get(r.antennaNumber) ?? null : null,
    );
    epcs.push(r.epcHex);
    rssis.push(r.rssi ?? null);
    readAts.push(r.readAt ?? now);
    // Stamp per-row whether the EPC passed the tenant's decoder. Live
    // scan filters by this so non-Carbon / malformed reads don't inflate
    // the operator's "real EPCs in this session" count. Lookup is by
    // uppercase EPC because the dedupe set above was uppercased.
    passesFormulas.push(passesFormulaByEpc.get(r.epcHex.toUpperCase()) ?? false);
  }

  // Persist only reads that passed the tenant's decoder. Live scan + every
  // downstream query against `cdm_reads` already filter on
  // `passes_formula = true`, so storing the rejected rows was pure DB
  // bloat — at field rates we measured ~10 noise reads/sec per stuck
  // antenna, ~99.98% of all writes. That filled the prod disk to 100% on
  // 2026-05-10 and took Coolify down with it. Filter at write time so the
  // table stays bounded under any reader misconfig.
  //
  // Side effects below (status_online flip, zone-change tracker, antenna
  // last_read_at bump, SSE fan-out) intentionally still see ALL reads —
  // the antenna IS receiving signal even if the EPCs don't decode, and
  // the operator wants the antenna dot to stay green in that case.
  const keepIdx: number[] = [];
  for (let i = 0; i < passesFormulas.length; i++) {
    if (passesFormulas[i]) keepIdx.push(i);
  }

  // Per-batch dedup (cheap; reduces work for the upsert below).
  // The UNIQUE index from migration 0069 enforces the actual one-row-per-key
  // invariant across batches — this just trims duplicates we already know
  // about within this single batch before hitting the DB.
  if (keepIdx.length > 1) {
    const seenInBatch = new Set<string>();
    const dedupedKeepIdx: number[] = [];
    // Walk newest-to-oldest so the row we keep has the most recent read_at.
    const sorted = [...keepIdx].sort((a, b) => {
      const ta = new Date(readAts[a]!).getTime();
      const tb = new Date(readAts[b]!).getTime();
      return tb - ta;
    });
    for (const i of sorted) {
      const key = `${readerIds[i]}|${antennaIds[i] ?? ""}|${epcs[i]}`;
      if (seenInBatch.has(key)) continue;
      seenInBatch.add(key);
      dedupedKeepIdx.push(i);
    }
    keepIdx.length = 0;
    keepIdx.push(...dedupedKeepIdx);
  }
  let insertedCount = 0;
  if (keepIdx.length > 0) {
    // UPSERT: one row per (reader_id, antenna_id, epc_hex). On conflict,
    // refresh read_at + rssi so the row reflects the MOST RECENT observation
    // of this tag on this antenna. Driven by the unique index from
    // migration 0069 (NULLS NOT DISTINCT so NULL antenna_id still dedups).
    // RETURNING the inserted/updated rows so insertedCount reflects writes
    // not raw rowCount which would be 0 on pure conflicts.
    const result = await client.query(
      `INSERT INTO cdm_reads
          (tenant_id, cdm_agent_id, reader_id, antenna_id, epc_hex, rssi, read_at, passes_formula)
       SELECT
          unnest($1::uuid[]),
          unnest($2::uuid[]),
          unnest($3::uuid[]),
          NULLIF(unnest($4::text[]), '')::uuid,
          unnest($5::text[]),
          NULLIF(unnest($6::text[]), '')::int,
          unnest($7::timestamptz[]),
          unnest($8::boolean[])
       ON CONFLICT (reader_id, antenna_id, epc_hex)
       DO UPDATE SET
         read_at        = EXCLUDED.read_at,
         rssi           = EXCLUDED.rssi,
         passes_formula = EXCLUDED.passes_formula,
         cdm_agent_id   = EXCLUDED.cdm_agent_id`,
      [
        keepIdx.map((i) => tenantIds[i]),
        keepIdx.map((i) => agentIds[i]),
        keepIdx.map((i) => readerIds[i]),
        keepIdx.map((i) => antennaIds[i] ?? ""),
        keepIdx.map((i) => epcs[i]),
        keepIdx.map((i) => (rssis[i] === null ? "" : String(rssis[i]))),
        keepIdx.map((i) => readAts[i]),
        keepIdx.map((i) => passesFormulas[i]),
      ],
    );
    insertedCount = result.rowCount ?? keepIdx.length;
  }

  // Mark the reader as online — its first read in this session.
  const readerInfo = await client.query<{ location_id: string; zone_id: string | null }>(
    `UPDATE devices SET status_online = true, updated_at = now()
       WHERE id = $1::uuid
       RETURNING location_id::text, zone_id::text AS zone_id`,
    [body.readerId],
  );

  // Zone-change tracker: every read carries an implicit "EPC was here at
  // time T" sighting. When the reader's zone differs from the EPC's
  // last_seen_zone_id we emit an audit_log row so the EPC tracker timeline
  // shows zone transitions inside the location. Reader-to-reader within the
  // same zone stays silent. First sighting (NULL → new zone) doesn't emit —
  // that's a backfill, not a movement.
  //
  // Wrapped in try/catch on a SAVEPOINT so any failure here (missing column
  // on a partially-migrated DB, malformed payload, audit_log schema drift)
  // can't take down the read-ingest pipeline. Worst case: zone-change events
  // stop emitting until the underlying issue is fixed; reads keep flowing.
  const newZoneId = readerInfo.rows[0]?.zone_id ?? null;
  if (newZoneId && dedupedEpcs.length > 0) {
    try {
      await client.query("SAVEPOINT zone_change_tracker");
      const changed = await client.query<{ epc: string; old_zone_id: string }>(
        `SELECT i.epc, i.last_seen_zone_id::text AS old_zone_id
           FROM items i
           INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
          WHERE i.epc = ANY($2::text[])
            AND i.last_seen_zone_id IS NOT NULL
            AND i.last_seen_zone_id IS DISTINCT FROM $3::uuid`,
        [auth.tenantId, dedupedEpcs, newZoneId],
      );
      await client.query(
        `UPDATE items
            SET last_seen_zone_id = $3::uuid
          FROM locations l
          WHERE items.epc = ANY($2::text[])
            AND l.id = items.location_id AND l.tenant_id = $1::uuid
            AND items.last_seen_zone_id IS DISTINCT FROM $3::uuid`,
        [auth.tenantId, dedupedEpcs, newZoneId],
      );
      if (changed.rowCount && changed.rowCount > 0) {
        const auditValues = changed.rows.map((_r, i) => {
          const baseIdx = 2 + i * 2; // $1=tenantId, then pairs of (entity, metadata)
          return `($1::uuid, NULL, 'rfid_zone_change', $${baseIdx}::text, $${baseIdx + 1}::jsonb, now())`;
        });
        const auditParams: unknown[] = [auth.tenantId];
        for (const r of changed.rows) {
          auditParams.push(`epc:${r.epc}`);
          auditParams.push(
            JSON.stringify({
              epc: r.epc,
              from_zone_id: r.old_zone_id,
              to_zone_id: newZoneId,
              reader_id: body.readerId,
              reader_name: readerName,
            }),
          );
        }
        await client.query(
          `INSERT INTO audit_log
             (tenant_id, user_id, action, entity, metadata, created_at)
           VALUES ${auditValues.join(", ")}`,
          auditParams,
        );
      }
      await client.query("RELEASE SAVEPOINT zone_change_tracker");
    } catch (e) {
      try {
        await client.query("ROLLBACK TO SAVEPOINT zone_change_tracker");
      } catch {
        /* savepoint may already be invalidated */
      }
      console.warn("[ingestAgentReads] zone-change tracker error (continuing)", e);
    }
  }

  // Bump `last_read_at` on every antenna that produced a read in this batch.
  // Hardware Config derives the antenna online dot from `last_read_at` (with
  // a 60s freshness threshold) joined with the parent reader's pause state,
  // so an antenna whose coax goes loose stops showing green within a minute
  // of the last read — instead of the legacy sticky-true behavior where one
  // historic tag kept it green forever. We do NOT touch `status_online` here
  // anymore for antennas; that column is now ignored for antenna rows.
  const seenAntennaIds = new Set<string>();
  for (const r of body.reads) {
    if (r.antennaNumber === undefined) continue;
    const antId = antennaIdMap.get(r.antennaNumber);
    if (antId) seenAntennaIds.add(antId);
  }
  if (seenAntennaIds.size > 0) {
    await client.query(
      `UPDATE devices SET last_read_at = now(), updated_at = now()
         WHERE id = ANY($1::uuid[])`,
      [Array.from(seenAntennaIds)],
    );
  }

  // Fan out to the live SSE hub so the Transfers page (and any other
  // subscriber) sees these EPCs in real time. We publish with
  // scanContext "TRANSFER" so the existing Transfers workspace filter
  // accepts them — same channel handhelds already use.
  if (readerInfo.rowCount && readerInfo.rows[0]) {
    const locationId = readerInfo.rows[0].location_id;
    // Dedup within this batch to keep the SSE payload tight.
    const epcs = Array.from(new Set(body.reads.map((r) => r.epcHex)));
    // Per-EPC antenna attribution so the dashboard can credit each tag to
    // the antenna that detected it without re-querying. Last-write-wins
    // when an EPC was seen on multiple antennas in the same batch (rare).
    const epcAntennaMap: Record<string, string> = {};
    for (let i = 0; i < body.reads.length; i++) {
      const aId = antennaIds[i];
      if (aId) epcAntennaMap[body.reads[i].epcHex.toUpperCase()] = aId;
    }
    publishEdgeScanEvent(auth.tenantId, locationId, {
      deviceId: body.readerId,
      locationId,
      scanContext: "TRANSFER",
      epcs,
      epcAntennaMap,
      timestamp: new Date().toISOString(),
      rowsAffected: insertedCount,
    });
  }

  return { inserted: insertedCount };
}

// ──────────────────────────────────────────────────────────────────────────
// Recent-reads view for the UI (Hardware Config / debug panels)
// ──────────────────────────────────────────────────────────────────────────

export type RecentReadRow = {
  id: string;
  reader_id: string;
  reader_name: string;
  antenna_id: string | null;
  antenna_number: number | null;
  epc_hex: string;
  rssi: number | null;
  read_at: string;
};

export async function listRecentReadsForTenant(
  pool: Pool,
  tenantId: string,
  limit = 50,
): Promise<RecentReadRow[]> {
  const r = await pool.query<{
    id: string;
    reader_id: string;
    reader_name: string;
    antenna_id: string | null;
    antenna_number: number | null;
    epc_hex: string;
    rssi: number | null;
    read_at: string;
  }>(
    `SELECT
       cr.id::text,
       cr.reader_id::text,
       d.name AS reader_name,
       cr.antenna_id::text,
       (a.config->>'antenna_number')::int AS antenna_number,
       cr.epc_hex,
       cr.rssi,
       cr.read_at::text
     FROM cdm_reads cr
     JOIN devices d ON d.id = cr.reader_id
     LEFT JOIN devices a ON a.id = cr.antenna_id
     WHERE cr.tenant_id = $1::uuid
     ORDER BY cr.read_at DESC
     LIMIT $2`,
    [tenantId, limit],
  );
  return r.rows;
}
