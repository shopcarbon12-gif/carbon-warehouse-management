import type { Pool } from "pg";

export type HardwareAntennaRow = {
  id: string;
  name: string;
  status_online: boolean;
  config: Record<string, unknown>;
};

export type HardwareReaderRow = {
  id: string;
  name: string;
  network_address: string | null;
  /** WIZnet bridge MAC. When populated, the agent's discovery sweep matches
   *  this device by MAC and (a) auto-updates `network_address` on DHCP
   *  shuffles, (b) clears the row from the discovered-bridges panel. */
  mac_address: string | null;
  device_type: string;
  status_online: boolean;
  config: Record<string, unknown>;
  cdm_agent_id: string | null;
  cdm_agent_name: string | null;
  /** Surfaced so the reader-editor-modal can pre-fill the Zone field on
   *  edit. Without this the modal opened with an empty zone, the form
   *  omitted zoneId from the PATCH body, and the server's zod schema
   *  rejected the save with "expected string, received undefined". */
  zone_id: string | null;
  /** Surfaced so the hardware-config UI can render pause state + schedule. */
  scan_paused_at: string | null;
  scan_schedule: unknown | null;
  antennas: HardwareAntennaRow[];
};

export type HardwareZoneRow = {
  id: string;
  name: string;
  description: string | null;
  readers: HardwareReaderRow[];
};

export type HardwareLocationRow = {
  id: string;
  code: string;
  name: string;
  zones: HardwareZoneRow[];
  unzonedReaders: HardwareReaderRow[];
};

export type HardwareConfigTree = {
  locations: HardwareLocationRow[];
};

const READER_TYPES = new Set(["fixed_reader", "transaction_reader", "door_reader"]);

type RawDevice = {
  id: string;
  device_type: string;
  name: string;
  network_address: string | null;
  mac_address: string | null;
  status_online: boolean;
  config: Record<string, unknown> | null;
  zone_id: string | null;
  parent_device_id: string | null;
  cdm_agent_id: string | null;
  cdm_agent_name: string | null;
  location_id: string;
  scan_paused_at: string | null;
  scan_schedule: unknown | null;
};

export async function buildHardwareConfigTree(
  pool: Pool,
  tenantId: string,
  /**
   * Active location to scope the tree to. When provided, locations/zones/
   * devices are filtered so a user on FL Mall doesn't see Orlando's hardware.
   * Pass `null`/`undefined` to keep the legacy tenant-wide tree.
   */
  locationId?: string | null,
): Promise<HardwareConfigTree> {
  const scoped = !!locationId;
  const [locations, zones, devices] = await Promise.all([
    pool.query<{ id: string; code: string; name: string }>(
      scoped
        ? `SELECT id::text, code, name
             FROM locations
             WHERE tenant_id = $1::uuid AND id = $2::uuid
             ORDER BY code ASC`
        : `SELECT id::text, code, name
             FROM locations
             WHERE tenant_id = $1::uuid
             ORDER BY code ASC`,
      scoped ? [tenantId, locationId] : [tenantId],
    ),
    pool.query<{
      id: string;
      location_id: string;
      name: string;
      description: string | null;
    }>(
      scoped
        ? `SELECT id::text, location_id::text, name, description
             FROM zones
             WHERE tenant_id = $1::uuid AND location_id = $2::uuid
             ORDER BY name ASC`
        : `SELECT id::text, location_id::text, name, description
             FROM zones
             WHERE tenant_id = $1::uuid
             ORDER BY name ASC`,
      scoped ? [tenantId, locationId] : [tenantId],
    ),
    pool.query<RawDevice>(
      `SELECT
         d.id::text,
         d.device_type,
         d.name,
         d.network_address,
         d.mac_address,
         d.status_online,
         COALESCE(d.config, '{}'::jsonb) AS config,
         d.zone_id::text   AS zone_id,
         d.parent_device_id::text AS parent_device_id,
         d.cdm_agent_id::text AS cdm_agent_id,
         a.name AS cdm_agent_name,
         d.location_id::text AS location_id,
         d.scan_paused_at::text AS scan_paused_at,
         d.scan_schedule
       FROM devices d
       LEFT JOIN cdm_agents a ON a.id = d.cdm_agent_id
       WHERE d.tenant_id = $1::uuid
         ${scoped ? "AND d.location_id = $2::uuid" : ""}
         AND d.device_type IN ('fixed_reader','transaction_reader','door_reader','antenna')
       ORDER BY d.name ASC`,
      scoped ? [tenantId, locationId] : [tenantId],
    ),
  ]);

  const antennasByParent = new Map<string, HardwareAntennaRow[]>();
  for (const d of devices.rows) {
    if (d.device_type !== "antenna" || !d.parent_device_id) continue;
    const arr = antennasByParent.get(d.parent_device_id) ?? [];
    arr.push({
      id: d.id,
      name: d.name,
      status_online: d.status_online,
      config: (d.config ?? {}) as Record<string, unknown>,
    });
    antennasByParent.set(d.parent_device_id, arr);
  }

  const readersByZone = new Map<string, HardwareReaderRow[]>();
  const readersByLocationUnzoned = new Map<string, HardwareReaderRow[]>();
  for (const d of devices.rows) {
    if (!READER_TYPES.has(d.device_type)) continue;
    const reader: HardwareReaderRow = {
      id: d.id,
      name: d.name,
      network_address: d.network_address,
      mac_address: d.mac_address,
      device_type: d.device_type,
      status_online: d.status_online,
      config: (d.config ?? {}) as Record<string, unknown>,
      cdm_agent_id: d.cdm_agent_id,
      cdm_agent_name: d.cdm_agent_name,
      zone_id: d.zone_id,
      scan_paused_at: d.scan_paused_at,
      scan_schedule: d.scan_schedule,
      antennas: antennasByParent.get(d.id) ?? [],
    };
    if (d.zone_id) {
      const arr = readersByZone.get(d.zone_id) ?? [];
      arr.push(reader);
      readersByZone.set(d.zone_id, arr);
    } else {
      const arr = readersByLocationUnzoned.get(d.location_id) ?? [];
      arr.push(reader);
      readersByLocationUnzoned.set(d.location_id, arr);
    }
  }

  const zonesByLocation = new Map<string, HardwareZoneRow[]>();
  for (const z of zones.rows) {
    const arr = zonesByLocation.get(z.location_id) ?? [];
    arr.push({
      id: z.id,
      name: z.name,
      description: z.description,
      readers: readersByZone.get(z.id) ?? [],
    });
    zonesByLocation.set(z.location_id, arr);
  }

  return {
    locations: locations.rows.map((l) => ({
      id: l.id,
      code: l.code,
      name: l.name,
      zones: zonesByLocation.get(l.id) ?? [],
      unzonedReaders: readersByLocationUnzoned.get(l.id) ?? [],
    })),
  };
}
