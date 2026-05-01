import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { publishEdgeScanEvent } from "@/lib/server/edge-scan-hub";
import { ingestEpcs } from "@/lib/server/epc-ingress";

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
});

export type HeartbeatBody = z.infer<typeof heartbeatSchema>;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateAgentToken(): string {
  return `cdm_${randomBytes(24).toString("hex")}`;
}

export async function listCdmAgentsForTenant(
  pool: Pool,
  tenantId: string,
): Promise<CdmAgentRow[]> {
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
     ORDER BY l.code ASC, a.name ASC`,
    [tenantId],
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
): Promise<void> {
  await client.query(
    `UPDATE cdm_agents
       SET status = $2,
           agent_version = $3,
           hostname = COALESCE($4, hostname),
           last_heartbeat_at = now(),
           updated_at = now()
     WHERE id = $1::uuid`,
    [agentId, body.status, body.agentVersion, body.hostname ?? null],
  );
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
  zone_id: string | null;
  zone_name: string | null;
  antennas: AgentConfigAntenna[];
};

export type AgentConfigBundle = {
  agent: { id: string; name: string; location_id: string; location_code: string };
  readers: AgentConfigReader[];
  /** Server-side time, useful for the agent to detect clock skew. */
  server_time: string;
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
  }>(
    `SELECT a.id::text, a.name, a.location_id::text, l.code AS location_code
       FROM cdm_agents a
       JOIN locations l ON l.id = a.location_id
       WHERE a.id = $1::uuid`,
    [agentId],
  );
  if (ag.rowCount === 0) return null;

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
       d.test_pending_at
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
    };
    const arr = antennasByParent.get(d.parent_device_id) ?? [];
    arr.push({
      id: d.id,
      name: d.name,
      antenna_number: Number(cfg.antenna_number ?? 1),
      transmit_power_dbm: Number(cfg.transmit_power_dbm ?? 30),
      enabled: cfg.enabled !== false,
      test_pending_at: d.test_pending_at,
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
      zone_id: d.zone_id,
      zone_name: d.zone_name,
      antennas: list,
    });
  }

  return {
    agent: ag.rows[0],
    readers,
    server_time: new Date().toISOString(),
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
  const ownership = await client.query<{ id: string; location_id: string; name: string }>(
    `SELECT id::text, location_id::text, name FROM devices
       WHERE id = $1::uuid AND tenant_id = $2::uuid AND cdm_agent_id = $3::uuid
         AND device_type IN ('fixed_reader','transaction_reader','door_reader')`,
    [body.readerId, auth.tenantId, auth.agentId],
  );
  if (ownership.rowCount === 0) {
    throw new Error("BAD_REQUEST:Reader not found or not owned by this agent");
  }
  const readerLocationId = ownership.rows[0].location_id;
  const readerName = ownership.rows[0].name;

  // ── Unified EPC ingress ──
  // Every EPC goes through epc-ingress: decode against tenant_epc_config,
  // look up `ls_system_id` in custom_skus, and write items with status
  // 'in-stock' on match or 'tag_killed' on miss. Replaces the old
  // AUTO-PENDING placeholder bucket.
  const antennaIdMap = await getAntennaIdMap(client, body.readerId);
  const dedupedEpcs = Array.from(new Set(body.reads.map((r) => r.epcHex.toUpperCase())));
  // Map each unique EPC back to the antenna it was last seen on (best-effort
  // device label). If the same EPC came from multiple antennas in this batch,
  // the last one wins — fine for source attribution, doesn't affect status.
  const lastAntennaForEpc = new Map<string, number | undefined>();
  for (const r of body.reads) {
    lastAntennaForEpc.set(r.epcHex.toUpperCase(), r.antennaNumber);
  }
  if (dedupedEpcs.length > 0) {
    await ingestEpcs(client, dedupedEpcs.map((epc) => {
      const antNum = lastAntennaForEpc.get(epc);
      const antLabel = antNum !== undefined ? `${readerName} · A${antNum}` : readerName;
      return {
        tenantId: auth.tenantId,
        epc,
        source: "fixed_reader" as const,
        sourceDeviceLabel: antLabel,
        locationId: readerLocationId,
        receivedAt: new Date(),
      };
    }));
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
  }

  const result = await client.query(
    `INSERT INTO cdm_reads
        (tenant_id, cdm_agent_id, reader_id, antenna_id, epc_hex, rssi, read_at)
     SELECT
        unnest($1::uuid[]),
        unnest($2::uuid[]),
        unnest($3::uuid[]),
        NULLIF(unnest($4::text[]), '')::uuid,
        unnest($5::text[]),
        NULLIF(unnest($6::text[]), '')::int,
        unnest($7::timestamptz[])`,
    [
      tenantIds,
      agentIds,
      readerIds,
      antennaIds.map((x) => x ?? ""),
      epcs,
      rssis.map((x) => (x === null ? "" : String(x))),
      readAts,
    ],
  );

  // Mark the reader as online — its first read in this session.
  const readerInfo = await client.query<{ location_id: string }>(
    `UPDATE devices SET status_online = true, updated_at = now()
       WHERE id = $1::uuid
       RETURNING location_id::text`,
    [body.readerId],
  );

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
