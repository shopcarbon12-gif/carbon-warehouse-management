import type { Pool } from "pg";
import { isReaderEffectivelyPaused, type ScanSchedule } from "./scan-schedule";

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
  /** Tri-state Hardware Config dot; derived server-side. Distinguishes the
   *  ambiguous case where the chassis is on the LAN (bridge responding to
   *  agent's wiznet-cli sweep) but the chip isn't producing valid tag-read
   *  bytes — chassis firmware fault rather than network/cable fault.
   *    "online"    — chip producing valid output (status_online = true)
   *    "reachable" — bridge seen on LAN within freshness window, no reads
   *    "offline"   — bridge missed last few sweeps OR no MAC bound */
  bridge_state: "online" | "reachable" | "offline";
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
  /** Bumped by ingestAgentReads on every antenna that produces a tag read,
   *  and by /api/antenna-test/* endpoints during operator-driven tests.
   *  Used here (with a 15-minute freshness threshold) to derive the
   *  antenna's status_online dot. Reader rows ignore this field. */
  last_read_at: string | null;
  /** When the most recent antenna-test result was reported. Pairs with
   *  last_test_passed in the antenna freshness derivation: a passed test
   *  within 24 h keeps the dot green even when no scan reads followed. */
  last_test_at: string | null;
  last_test_passed: boolean | null;
  /** Bumped by ingestWiznetDiscoveries on every MAC match in the agent's
   *  LAN sweep. Used here (with a ~3 min freshness window matching the
   *  agent's stale-row purge cutoff) to derive the reader's tri-state
   *  bridge_state. Antenna rows ignore this field. */
  bridge_seen_at: string | null;
};

/**
 * Antenna freshness window. An antenna with `last_read_at` newer than this
 * relative to now() shows online, unless its parent reader is paused/stopped
 * (which short-circuits to online regardless — we don't punish an antenna
 * for not reading when the operator deliberately turned the reader off).
 *
 * 15 minutes (was 60 s). Live evidence on .16 (Senitron Transfer Bin) and
 * other transactional readers: tag reads come in bursts every 60-180 s,
 * not continuously. A 60 s window made those antennas flap between online
 * and offline every cycle even though they were verifiably reading. 15 min
 * keeps the dot honest for genuine outages while letting transactional and
 * test-driven readers stay green between bursts.
 */
const ANTENNA_FRESHNESS_MS = 15 * 60_000;
/**
 * Test-passed window. An antenna whose most recent test passed within this
 * window also shows green — captures the operator's "I tested it, it works"
 * signal even when no normal-scan reads have followed. 24 hours is long
 * enough that a morning test stays green through the workday; after that
 * the antenna ages out and needs fresh reads or a fresh test to stay green.
 */
const ANTENNA_TEST_PASSED_MS = 24 * 60 * 60_000;
/**
 * Bridge-reachability freshness window. Agent runs `wiznet-cli -d` every
 * minute; ~3 missed sweeps = solid signal that the bridge is off the LAN.
 * Matches the existing wiznet-discoveries.ts purge cutoff for orphan rows.
 */
const BRIDGE_REACHABLE_MS = 3 * 60_000;

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
         d.scan_schedule,
         d.last_read_at::text AS last_read_at,
         d.last_test_at::text AS last_test_at,
         d.last_test_passed,
         d.bridge_seen_at::text AS bridge_seen_at
       FROM devices d
       LEFT JOIN cdm_agents a ON a.id = d.cdm_agent_id
       WHERE d.tenant_id = $1::uuid
         ${scoped ? "AND d.location_id = $2::uuid" : ""}
         AND d.device_type IN ('fixed_reader','transaction_reader','door_reader','antenna')
       ORDER BY d.name ASC`,
      scoped ? [tenantId, locationId] : [tenantId],
    ),
  ]);

  // Build a parent→effectively-paused lookup so we can short-circuit
  // antenna online to TRUE when the parent reader is paused or stopped.
  // This matches the operator UX expectation: "I turned this reader off
  // on purpose; don't punish its antennas with red dots." The freshness
  // path (last_read_at within ANTENNA_FRESHNESS_MS) only kicks in when
  // the parent is NOT paused.
  const now = new Date();
  const nowMs = now.getTime();
  const parentPaused = new Map<string, boolean>();
  for (const d of devices.rows) {
    if (!READER_TYPES.has(d.device_type)) continue;
    parentPaused.set(
      d.id,
      isReaderEffectivelyPaused(
        d.scan_paused_at,
        (d.scan_schedule as ScanSchedule | null) ?? null,
        now,
      ),
    );
  }

  const antennasByParent = new Map<string, HardwareAntennaRow[]>();
  for (const d of devices.rows) {
    if (d.device_type !== "antenna" || !d.parent_device_id) continue;
    const arr = antennasByParent.get(d.parent_device_id) ?? [];
    const fresh =
      d.last_read_at !== null &&
      nowMs - new Date(d.last_read_at).getTime() <= ANTENNA_FRESHNESS_MS;
    const recentlyTestedOk =
      d.last_test_passed === true &&
      d.last_test_at !== null &&
      nowMs - new Date(d.last_test_at).getTime() <= ANTENNA_TEST_PASSED_MS;
    const parentIsPaused = parentPaused.get(d.parent_device_id) ?? false;
    arr.push({
      id: d.id,
      name: d.name,
      // Derived: paused parent OR fresh read (15min) OR passed test (24h).
      // The stored `status_online` column is intentionally ignored — see
      // migration 0060_devices_last_read_at and lib/server/cdm-agents.ts.
      status_online: parentIsPaused || fresh || recentlyTestedOk,
      config: (d.config ?? {}) as Record<string, unknown>,
    });
    antennasByParent.set(d.parent_device_id, arr);
  }

  const readersByZone = new Map<string, HardwareReaderRow[]>();
  const readersByLocationUnzoned = new Map<string, HardwareReaderRow[]>();
  for (const d of devices.rows) {
    if (!READER_TYPES.has(d.device_type)) continue;
    // Tri-state derivation: chip producing valid reads beats everything;
    // otherwise fall back to "is the bridge on the LAN" via bridge_seen_at.
    // Operators reading the dot get an actionable signal — yellow means
    // "look at the chassis firmware/state, not the network/cable."
    const bridgeFresh =
      d.bridge_seen_at !== null &&
      nowMs - new Date(d.bridge_seen_at).getTime() <= BRIDGE_REACHABLE_MS;
    const bridgeState: "online" | "reachable" | "offline" = d.status_online
      ? "online"
      : bridgeFresh
        ? "reachable"
        : "offline";
    const reader: HardwareReaderRow = {
      id: d.id,
      name: d.name,
      network_address: d.network_address,
      mac_address: d.mac_address,
      device_type: d.device_type,
      status_online: d.status_online,
      bridge_state: bridgeState,
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
