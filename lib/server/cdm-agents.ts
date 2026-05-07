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
    `SELECT d.id::text, d.name, d.network_address,
            COALESCE(d.config->>'monsoon_driver', 'stream') AS monsoon_driver,
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
       d.scan_schedule
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

const ANTENNA_CACHE = new Map<string, Map<number, string>>();

async function getAntennaIdMap(
  client: PoolClient,
  readerId: string,
): Promise<Map<number, string>> {
  const cached = ANTENNA_CACHE.get(readerId);
  if (cached) return cached;
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
  ANTENNA_CACHE.set(readerId, map);
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
        unnest($8::boolean[])`,
    [
      tenantIds,
      agentIds,
      readerIds,
      antennaIds.map((x) => x ?? ""),
      epcs,
      rssis.map((x) => (x === null ? "" : String(x))),
      readAts,
      passesFormulas,
    ],
  );

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

  // Mark every antenna that produced a read in this batch as online too.
  // Hardware Config has separate online dots for the reader and each
  // antenna; without this update only the reader flips green even when
  // tags are streaming through specific antennas.
  const seenAntennaIds = new Set<string>();
  for (const r of body.reads) {
    if (r.antennaNumber === undefined) continue;
    const antId = antennaIdMap.get(r.antennaNumber);
    if (antId) seenAntennaIds.add(antId);
  }
  if (seenAntennaIds.size > 0) {
    await client.query(
      `UPDATE devices SET status_online = true, updated_at = now()
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
    publishEdgeScanEvent(auth.tenantId, locationId, {
      deviceId: body.readerId,
      locationId,
      scanContext: "TRANSFER",
      epcs,
      timestamp: new Date().toISOString(),
      rowsAffected: result.rowCount ?? body.reads.length,
    });
  }

  return { inserted: result.rowCount ?? body.reads.length };
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
