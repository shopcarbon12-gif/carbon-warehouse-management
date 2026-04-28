import type { Pool, PoolClient } from "pg";
import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────────
// Reader (fixed_reader / transaction_reader / door_reader)
// ──────────────────────────────────────────────────────────────────────────

const readerTypeSchema = z.enum(["fixed_reader", "transaction_reader", "door_reader"]);
export type ReaderType = z.infer<typeof readerTypeSchema>;

export const upsertReaderSchema = z.object({
  id: z.string().uuid().optional(),
  zoneId: z.string().uuid(),
  cdmAgentId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(256),
  networkAddress: z.string().trim().min(1).max(256),
  deviceType: readerTypeSchema.default("fixed_reader"),
  model: z.string().trim().max(64).optional().default("SA-2000"),
  monsoonSerialPort: z.coerce.number().int().min(1).max(65535).default(10002),
  streamPort: z.coerce.number().int().min(1024).max(65535).optional(),
  controlPort: z.coerce.number().int().min(1024).max(65535).optional(),
  antennaCount: z.coerce.number().int().min(1).max(32).default(1),
  epcPrefix: z.string().trim().max(32).optional().default(""),
});

export type UpsertReaderBody = z.infer<typeof upsertReaderSchema>;

/**
 * Auto-assigns the next free stream_port (30100, 30200, ...) and control_port
 * (20100, 20200, ...) for an agent if not provided.
 */
async function nextFreePortsForAgent(
  client: PoolClient,
  cdmAgentId: string | null,
): Promise<{ stream: number; control: number }> {
  const r = await client.query<{ stream_port: number | null; control_port: number | null }>(
    `SELECT
       (config->>'stream_port')::int  AS stream_port,
       (config->>'control_port')::int AS control_port
     FROM devices
     WHERE cdm_agent_id = $1::uuid
       AND device_type IN ('fixed_reader','transaction_reader','door_reader')`,
    [cdmAgentId],
  );
  const usedStream = new Set(r.rows.map((x) => x.stream_port).filter(Boolean) as number[]);
  const usedControl = new Set(r.rows.map((x) => x.control_port).filter(Boolean) as number[]);
  let stream = 30100;
  while (usedStream.has(stream)) stream += 100;
  let control = 20100;
  while (usedControl.has(control)) control += 100;
  return { stream, control };
}

export async function upsertReader(
  client: PoolClient,
  tenantId: string,
  body: UpsertReaderBody,
): Promise<{ id: string }> {
  const zone = await client.query<{ location_id: string }>(
    `SELECT location_id::text FROM zones WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [body.zoneId, tenantId],
  );
  if (zone.rowCount === 0) {
    throw new Error("BAD_REQUEST:Zone not found for this tenant");
  }
  const locationId = zone.rows[0].location_id;

  if (body.cdmAgentId) {
    const a = await client.query(
      `SELECT 1 FROM cdm_agents WHERE id = $1::uuid AND tenant_id = $2::uuid AND location_id = $3::uuid`,
      [body.cdmAgentId, tenantId, locationId],
    );
    if (a.rowCount === 0) {
      throw new Error("BAD_REQUEST:CDM agent not found in the zone's location");
    }
  }

  const auto = body.streamPort && body.controlPort
    ? null
    : await nextFreePortsForAgent(client, body.cdmAgentId ?? null);

  const config = {
    model: body.model ?? "SA-2000",
    monsoon_serial_port: body.monsoonSerialPort,
    stream_port: body.streamPort ?? auto?.stream ?? 30100,
    control_port: body.controlPort ?? auto?.control ?? 20100,
    antenna_count: body.antennaCount,
    epc_prefix: body.epcPrefix ?? "",
  };

  if (body.id) {
    const r = await client.query<{ id: string }>(
      `UPDATE devices
         SET name = $3,
             network_address = $4,
             zone_id = $5::uuid,
             cdm_agent_id = $6::uuid,
             device_type = $7,
             config = $8::jsonb,
             updated_at = now()
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       RETURNING id::text`,
      [
        body.id,
        tenantId,
        body.name,
        body.networkAddress,
        body.zoneId,
        body.cdmAgentId ?? null,
        body.deviceType,
        JSON.stringify(config),
      ],
    );
    if (r.rowCount === 0) {
      throw new Error("BAD_REQUEST:Reader not found");
    }
    return { id: r.rows[0].id };
  }

  const r = await client.query<{ id: string }>(
    `INSERT INTO devices (
       tenant_id, location_id, zone_id, cdm_agent_id,
       device_type, name, network_address, status_online, config
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, false, $8::jsonb)
     RETURNING id::text`,
    [
      tenantId,
      locationId,
      body.zoneId,
      body.cdmAgentId ?? null,
      body.deviceType,
      body.name,
      body.networkAddress,
      JSON.stringify(config),
    ],
  );
  return { id: r.rows[0].id };
}

export async function deleteReader(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<{ deleted: boolean }> {
  // Antennas have ON DELETE CASCADE via parent_device_id, so they go with it.
  const r = await client.query(
    `DELETE FROM devices
       WHERE id = $1::uuid AND tenant_id = $2::uuid
         AND device_type IN ('fixed_reader','transaction_reader','door_reader')`,
    [id, tenantId],
  );
  return { deleted: (r.rowCount ?? 0) > 0 };
}

// ──────────────────────────────────────────────────────────────────────────
// Antenna
// ──────────────────────────────────────────────────────────────────────────

export const upsertAntennaSchema = z.object({
  id: z.string().uuid().optional(),
  parentDeviceId: z.string().uuid(),
  name: z.string().trim().min(1).max(256),
  antennaNumber: z.coerce.number().int().min(1).max(32),
  transmitPowerDbm: z.coerce.number().min(0).max(33),
  enabled: z.boolean().default(true),
  positionDescription: z.string().trim().max(2000).optional().default(""),
});

export type UpsertAntennaBody = z.infer<typeof upsertAntennaSchema>;

export async function upsertAntenna(
  client: PoolClient,
  tenantId: string,
  body: UpsertAntennaBody,
): Promise<{ id: string }> {
  const parent = await client.query<{
    id: string;
    location_id: string;
    zone_id: string | null;
    cdm_agent_id: string | null;
  }>(
    `SELECT id::text, location_id::text, zone_id::text, cdm_agent_id::text
       FROM devices
       WHERE id = $1::uuid AND tenant_id = $2::uuid
         AND device_type IN ('fixed_reader','transaction_reader','door_reader')`,
    [body.parentDeviceId, tenantId],
  );
  if (parent.rowCount === 0) {
    throw new Error("BAD_REQUEST:Parent reader not found");
  }
  const p = parent.rows[0];

  // Enforce uniqueness of antenna_number within a parent (excluding self).
  const dup = await client.query<{ id: string }>(
    `SELECT id::text FROM devices
       WHERE parent_device_id = $1::uuid
         AND device_type = 'antenna'
         AND (config->>'antenna_number')::int = $2
         AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [body.parentDeviceId, body.antennaNumber, body.id ?? null],
  );
  if ((dup.rowCount ?? 0) > 0) {
    throw new Error(
      `BAD_REQUEST:Antenna #${body.antennaNumber} already exists on this reader`,
    );
  }

  const config = {
    antenna_number: body.antennaNumber,
    transmit_power_dbm: body.transmitPowerDbm,
    enabled: body.enabled,
    position_description: body.positionDescription ?? "",
  };

  if (body.id) {
    const r = await client.query<{ id: string }>(
      `UPDATE devices
         SET name = $3,
             config = $4::jsonb,
             updated_at = now()
       WHERE id = $1::uuid AND tenant_id = $2::uuid AND device_type = 'antenna'
       RETURNING id::text`,
      [body.id, tenantId, body.name, JSON.stringify(config)],
    );
    if (r.rowCount === 0) {
      throw new Error("BAD_REQUEST:Antenna not found");
    }
    return { id: r.rows[0].id };
  }

  const r = await client.query<{ id: string }>(
    `INSERT INTO devices (
       tenant_id, location_id, zone_id, cdm_agent_id, parent_device_id,
       device_type, name, status_online, config
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
             'antenna', $6, false, $7::jsonb)
     RETURNING id::text`,
    [
      tenantId,
      p.location_id,
      p.zone_id,
      p.cdm_agent_id,
      p.id,
      body.name,
      JSON.stringify(config),
    ],
  );
  return { id: r.rows[0].id };
}

export async function deleteAntenna(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<{ deleted: boolean }> {
  const r = await client.query(
    `DELETE FROM devices
       WHERE id = $1::uuid AND tenant_id = $2::uuid AND device_type = 'antenna'`,
    [id, tenantId],
  );
  return { deleted: (r.rowCount ?? 0) > 0 };
}

// ──────────────────────────────────────────────────────────────────────────
// Reader / Antenna single-row fetch (for edit forms)
// ──────────────────────────────────────────────────────────────────────────

export type FullDeviceRow = {
  id: string;
  device_type: string;
  name: string;
  network_address: string | null;
  status_online: boolean;
  config: Record<string, unknown>;
  zone_id: string | null;
  parent_device_id: string | null;
  cdm_agent_id: string | null;
  location_id: string;
};

export async function getDeviceById(
  pool: Pool,
  tenantId: string,
  id: string,
): Promise<FullDeviceRow | null> {
  const r = await pool.query<FullDeviceRow>(
    `SELECT
       id::text,
       device_type,
       name,
       network_address,
       status_online,
       COALESCE(config, '{}'::jsonb) AS config,
       zone_id::text,
       parent_device_id::text,
       cdm_agent_id::text,
       location_id::text
     FROM devices
     WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, tenantId],
  );
  return r.rows[0] ?? null;
}
