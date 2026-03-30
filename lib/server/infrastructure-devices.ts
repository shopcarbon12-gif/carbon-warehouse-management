import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { DEVICE_TYPES, type DeviceType } from "@/lib/constants/device-registry";

export { DEVICE_TYPES, type DeviceType } from "@/lib/constants/device-registry";

export type DeviceGridRow = {
  id: string;
  device_type: DeviceType;
  name: string;
  network_address: string | null;
  status_online: boolean;
  android_id: string | null;
  is_authorized: boolean;
  location_id: string;
  location_code: string;
  location_name: string;
  bin_id: string | null;
  bin_code: string | null;
  config: Record<string, unknown>;
};

const deviceTypeSchema = z.enum(DEVICE_TYPES);

export const upsertDeviceSchema = z
  .object({
    id: z.string().uuid().optional(),
    locationId: z.string().uuid(),
    binId: z.string().uuid().nullable().optional(),
    deviceType: deviceTypeSchema,
    name: z.string().trim().min(1).max(256),
    networkAddress: z.string().max(256).nullable().optional(),
    statusOnline: z.boolean().optional(),
    config: z.any().optional(),
    /** Printer: port (default 80). Printer: uri (default PSTPRNT). */
    printerPort: z.coerce.number().int().min(1).max(65535).optional(),
    printerUri: z.string().max(128).optional(),
  })
  .superRefine((data, ctx) => {
    const addr = data.networkAddress?.trim() ?? "";
    if (!addr) {
      ctx.addIssue({
        code: "custom",
        message:
          data.deviceType === "printer"
            ? "Printer IP / host is required"
            : "Device MAC or reader ID is required",
        path: ["networkAddress"],
      });
    }
  });

export type UpsertDeviceBody = z.infer<typeof upsertDeviceSchema>;

function isPrinter(t: DeviceType): boolean {
  return t === "printer";
}

function buildConfig(body: UpsertDeviceBody): Record<string, unknown> {
  const base = { ...(body.config ?? {}) };
  if (isPrinter(body.deviceType)) {
    const port = body.printerPort ?? (typeof base.port === "number" ? base.port : 80);
    const uri =
      (body.printerUri?.trim() || (typeof base.uri === "string" ? base.uri : "")) || "PSTPRNT";
    return { ...base, port, uri };
  }
  return base;
}

export async function listDevicesForTenant(pool: Pool, tenantId: string): Promise<DeviceGridRow[]> {
  const r = await pool.query<{
    id: string;
    device_type: string;
    name: string;
    network_address: string | null;
    status_online: boolean;
    android_id: string | null;
    is_authorized: boolean;
    location_id: string;
    location_code: string;
    location_name: string;
    bin_id: string | null;
    bin_code: string | null;
    config: unknown;
  }>(
    `SELECT
       d.id::text,
       d.device_type,
       d.name,
       d.network_address,
       d.status_online,
       d.android_id,
       COALESCE(d.is_authorized, false) AS is_authorized,
       d.location_id::text,
       l.code AS location_code,
       l.name AS location_name,
       d.bin_id::text AS bin_id,
       b.code AS bin_code,
       COALESCE(d.config, '{}'::jsonb) AS config
     FROM devices d
     INNER JOIN locations l ON l.id = d.location_id AND l.tenant_id = d.tenant_id
     LEFT JOIN bins b ON b.id = d.bin_id AND b.archived_at IS NULL
     WHERE d.tenant_id = $1::uuid
     ORDER BY l.code ASC, d.device_type ASC, d.name ASC`,
    [tenantId],
  );

  return r.rows.map((row) => ({
    id: row.id,
    device_type: row.device_type as DeviceType,
    name: row.name,
    network_address: row.network_address,
    status_online: row.status_online,
    android_id: row.android_id,
    is_authorized: row.is_authorized,
    location_id: row.location_id,
    location_code: row.location_code,
    location_name: row.location_name,
    bin_id: row.bin_id,
    bin_code: row.bin_code,
    config:
      typeof row.config === "object" && row.config !== null && !Array.isArray(row.config)
        ? (row.config as Record<string, unknown>)
        : {},
  }));
}

async function assertLocationTenant(
  client: PoolClient,
  locationId: string,
  tenantId: string,
): Promise<void> {
  const r = await client.query(`SELECT 1 FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid`, [
    locationId,
    tenantId,
  ]);
  if (!r.rows[0]) throw new Error("BAD_REQUEST:Location not found");
}

async function assertBinForLocation(
  client: PoolClient,
  binId: string,
  locationId: string,
  tenantId: string,
): Promise<void> {
  const r = await client.query(
    `SELECT 1 FROM bins b
     INNER JOIN locations l ON l.id = b.location_id
     WHERE b.id = $1::uuid AND b.location_id = $2::uuid AND l.tenant_id = $3::uuid
       AND b.archived_at IS NULL
     LIMIT 1`,
    [binId, locationId, tenantId],
  );
  if (!r.rows[0]) throw new Error("BAD_REQUEST:Bin not valid for this location");
}

export async function upsertDevice(
  client: PoolClient,
  tenantId: string,
  body: UpsertDeviceBody,
): Promise<{ id: string }> {
  const parsed = upsertDeviceSchema.parse(body);
  await assertLocationTenant(client, parsed.locationId, tenantId);

  const binId = parsed.binId?.trim() ? parsed.binId : null;
  if (binId) {
    await assertBinForLocation(client, binId, parsed.locationId, tenantId);
  }

  const config = buildConfig(parsed);
  const net = parsed.networkAddress!.trim();
  const online = parsed.statusOnline ?? false;

  if (parsed.id) {
    const u = await client.query<{ id: string }>(
      `UPDATE devices
       SET
         location_id = $1::uuid,
         bin_id = $2::uuid,
         device_type = $3,
         name = $4,
         network_address = $5,
         config = $6::jsonb,
         status_online = $7,
         updated_at = now()
       WHERE id = $8::uuid AND tenant_id = $9::uuid
       RETURNING id::text`,
      [
        parsed.locationId,
        binId,
        parsed.deviceType,
        parsed.name,
        net,
        JSON.stringify(config),
        online,
        parsed.id,
        tenantId,
      ],
    );
    if (!u.rows[0]) throw new Error("BAD_REQUEST:Device not found");
    return { id: u.rows[0].id };
  }

  const ins = await client.query<{ id: string }>(
    `INSERT INTO devices (
       tenant_id, location_id, bin_id, device_type, name, network_address, config, status_online
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, $8)
     RETURNING id::text`,
    [
      tenantId,
      parsed.locationId,
      binId,
      parsed.deviceType,
      parsed.name,
      net,
      JSON.stringify(config),
      online,
    ],
  );
  const id = ins.rows[0]?.id;
  if (!id) throw new Error("SERVER:Insert failed");
  return { id };
}

export async function deleteDevice(
  client: PoolClient,
  tenantId: string,
  deviceId: string,
): Promise<void> {
  const d = await client.query(
    `DELETE FROM devices d
     USING locations l
     WHERE d.id = $1::uuid
       AND d.location_id = l.id
       AND l.tenant_id = $2::uuid`,
    [deviceId, tenantId],
  );
  if ((d.rowCount ?? 0) === 0) {
    throw new Error("BAD_REQUEST:Device not found");
  }
}
