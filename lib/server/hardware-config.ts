import type { Pool } from "pg";
import { isReaderEffectivelyPaused, type ScanSchedule } from "./scan-schedule";

export type HardwareAntennaRow = {
  id: string;
  name: string;
  status_online: boolean;
  config: Record<string, unknown>;
  /** Auto-sweep diagnosed working power below configured. Surfaced in UI
   *  as a one-click "Apply X dBm" banner. NULL = no suggestion. */
  suggested_power_dbm: number | null;
  suggested_power_dbm_at: string | null;
};

export type ReaderHealthStatus = "ok" | "slow" | "stuck" | "offline" | "needs_service";

export type ReaderHealth = {
  /** "stuck"   — bridge reachable on LAN but reader producing zero reads
   *              for the freshness window (chassis firmware-wedged; needs
   *              physical power-cycle or a Hard Reset click).
   *  "slow"    — reads_5m below SLOW_FRACTION_OF_MEDIAN of the location's
   *              peer median, with enough peers to be meaningful.
   *  "offline" — bridge missed last few sweeps OR no MAC bound.
   *  "ok"      — everything else (including effectively-paused readers,
   *              which are already surfaced via scan_paused_at separately). */
  status: ReaderHealthStatus;
  reads_5m: number;
  peers_median_5m: number;
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
  /** Per-reader health derived from the last 5 minutes of cdm_reads + bridge
   *  reachability. Drives the Hardware Config badge next to the reader name.
   *  Effectively-paused readers always report "ok" — pause state is its
   *  own UI affordance and shouldn't compound the badge. */
  health: ReaderHealth;
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
  /** Stamped by the agent's heartbeat when the supervisor flags a reader
   *  at wedge Level 3 (chip unresponsive to recovery after 6+ failed
   *  attempts in 10 min). NULL = healthy. Drives the "needs_service"
   *  badge in Hardware Config. */
  chassis_wedged_at: string | null;
  /** Per-antenna columns: set on the antenna row, not the reader row.
   *  These two come back attached to the reader query because the SELECT
   *  pulls them in for both reader and antenna devices in one pass —
   *  ignored on reader rows, used on antenna rows by the antenna mapper. */
  suggested_power_dbm: number | null;
  suggested_power_dbm_at: string | null;
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
// Test-passed bypass has NO time limit. Once an antenna's last_test_passed
// flips true (operator ran a test, reads came in), the dot stays green
// until a subsequent test FAILS (last_test_passed flips false) or the
// reader is removed. This matches the operator's stated expectation:
// "I tested it, it works — don't make me re-test every 24h."
// /api/antenna-test/stop persists pass/fail based on session.totalReadsCount.
/**
 * Bridge-reachability freshness window. Agent runs `wiznet-cli -d` every
 * minute; ~3 missed sweeps = solid signal that the bridge is off the LAN.
 * Matches the existing wiznet-discoveries.ts purge cutoff for orphan rows.
 */
const BRIDGE_REACHABLE_MS = 3 * 60_000;

/**
 * "slow" badge threshold: a reader is slow if its 5-min read count is below
 * this fraction of the median read count of its location peers. 0.5 = "less
 * than half the median." Live evidence 2026-05-11: Aisle 1-2/2 (.225)
 * 16,589 reads / 5min vs sibling readers' 27,747 and 40,087 in the same
 * aisle. The slow one was 60% of its slower sibling and 40% of its faster
 * sibling — clearly degraded. 0.5 of median catches that without flagging
 * normal variance.
 */
const SLOW_FRACTION_OF_MEDIAN = 0.5;
/**
 * Don't flag "slow" unless the location's peers produced at least this many
 * reads in the window — otherwise low-activity periods (overnight, weekends)
 * cause a flood of false-positive slow badges where everyone reads 5 tags
 * and one reader reads 2.
 */
const SLOW_MIN_PEER_MEDIAN = 100;
/**
 * Need this many peer readers in the same location to compute a meaningful
 * median. Below this, the comparison is too noisy to draw a slow conclusion.
 */
const SLOW_MIN_PEERS = 3;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

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
  const [locations, zones, devices, readsByReader] = await Promise.all([
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
         d.bridge_seen_at::text AS bridge_seen_at,
         d.chassis_wedged_at::text AS chassis_wedged_at,
         d.suggested_power_dbm,
         d.suggested_power_dbm_at::text AS suggested_power_dbm_at
       FROM devices d
       LEFT JOIN cdm_agents a ON a.id = d.cdm_agent_id
       WHERE d.tenant_id = $1::uuid
         ${scoped ? "AND d.location_id = $2::uuid" : ""}
         AND d.device_type IN ('fixed_reader','transaction_reader','door_reader','antenna')
       ORDER BY d.name ASC`,
      scoped ? [tenantId, locationId] : [tenantId],
    ),
    // Per-reader read counts over the last 5 min. Drives the "slow" and
    // "stuck" badges. Aggregated client-side per location (median of peers).
    pool.query<{ reader_id: string; reads_5m: number }>(
      scoped
        ? `SELECT cr.reader_id::text AS reader_id, COUNT(*)::int AS reads_5m
             FROM cdm_reads cr
             JOIN devices d ON d.id = cr.reader_id
            WHERE cr.tenant_id = $1::uuid
              AND d.location_id = $2::uuid
              AND cr.read_at > now() - interval '5 minutes'
            GROUP BY cr.reader_id`
        : `SELECT cr.reader_id::text AS reader_id, COUNT(*)::int AS reads_5m
             FROM cdm_reads cr
            WHERE cr.tenant_id = $1::uuid
              AND cr.read_at > now() - interval '5 minutes'
            GROUP BY cr.reader_id`,
      scoped ? [tenantId, locationId] : [tenantId],
    ),
  ]);

  const readsByReaderId = new Map<string, number>();
  for (const r of readsByReader.rows) {
    readsByReaderId.set(r.reader_id, r.reads_5m);
  }

  // Reader paused/stopped state used to short-circuit antenna status to
  // "online" — that flattered defective antennas (operator stopped a
  // reader, broken antenna went green). Per operator: antenna status
  // must reflect the antenna's own reality, independent of reader
  // start/stop. The lookup is kept (other code paths read it) but the
  // antenna-status calculation below no longer consults it.
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

  // Parent → bridge-reachable lookup. The "test-passed sticky" bypass below
  // needs this so we don't show an antenna green when its parent reader's
  // WIZnet bridge has been off the LAN for hours. Live evidence 2026-05-10:
  // operator's PoE switch was off for ~2h, hardware-config showed ~5
  // antennas as green because they had `last_test_passed=true` from earlier
  // antenna-test sessions even though the parent bridge_seen_at was 7547s
  // stale. Test-passed should only count when the parent is currently
  // reachable enough to actually be using the antenna.
  const parentBridgeReachable = new Map<string, boolean>();
  for (const d of devices.rows) {
    if (!READER_TYPES.has(d.device_type)) continue;
    const reachable =
      d.bridge_seen_at !== null &&
      nowMs - new Date(d.bridge_seen_at).getTime() <= BRIDGE_REACHABLE_MS;
    parentBridgeReachable.set(d.id, !!d.status_online || reachable);
  }

  const antennasByParent = new Map<string, HardwareAntennaRow[]>();
  for (const d of devices.rows) {
    if (d.device_type !== "antenna" || !d.parent_device_id) continue;
    const arr = antennasByParent.get(d.parent_device_id) ?? [];
    const fresh =
      d.last_read_at !== null &&
      nowMs - new Date(d.last_read_at).getTime() <= ANTENNA_FRESHNESS_MS;
    // Test-passed signal sticks until a test fails — but ONLY while the
    // parent reader's bridge is currently on the LAN. A passed test from
    // last week doesn't mean the antenna is reading right now if the
    // chassis lost power.
    const parentReachable = parentBridgeReachable.get(d.parent_device_id) ?? false;
    const testedOk = d.last_test_passed === true && parentReachable;
    arr.push({
      id: d.id,
      name: d.name,
      // Antenna status reflects the antenna's reality, not the parent
      // reader's start/stop state. Online means we have concrete evidence
      // the antenna can produce reads RIGHT NOW: either a fresh read
      // within ANTENNA_FRESHNESS_MS, or a last-test-passed result while
      // the parent bridge is still reachable. Everything else is offline.
      // The stored `status_online` column is intentionally ignored —
      // see migration 0060.
      status_online: fresh || testedOk,
      config: (d.config ?? {}) as Record<string, unknown>,
      suggested_power_dbm: d.suggested_power_dbm,
      suggested_power_dbm_at: d.suggested_power_dbm_at,
    });
    antennasByParent.set(d.parent_device_id, arr);
  }

  // Per-location peer-rate median. Computed across all non-paused readers in
  // the location, so the "slow" comparison isn't dragged down by readers an
  // admin has deliberately paused (they'll have 0 reads but shouldn't count).
  //
  // Group by (location_id, device_type) so device roles only compare against
  // their own kind. A transaction_reader at the POS sees a handful of EPCs
  // per customer; a fixed_reader in an aisle sees hundreds continuously.
  // Lumping them in the same peer pool gave false-positive "slow" badges
  // on POS-type readers — they look 5% of peers but are healthy for their
  // role. Same logic protects door_reader from being graded against
  // fixed_reader inventory rates. With the group key tightened, a single
  // POS reader alone in its (location, type) group falls below
  // SLOW_MIN_PEERS and gets no slow flag at all — exactly what we want.
  const readerRowsByGroup = new Map<string, RawDevice[]>();
  const groupKey = (d: RawDevice) => `${d.location_id}|${d.device_type}`;
  for (const d of devices.rows) {
    if (!READER_TYPES.has(d.device_type)) continue;
    const key = groupKey(d);
    const arr = readerRowsByGroup.get(key) ?? [];
    arr.push(d);
    readerRowsByGroup.set(key, arr);
  }
  const peerMedianByGroup = new Map<string, number>();
  const peerCountByGroup = new Map<string, number>();
  for (const [key, rows] of readerRowsByGroup.entries()) {
    const activeRates: number[] = [];
    for (const r of rows) {
      if (parentPaused.get(r.id)) continue;
      activeRates.push(readsByReaderId.get(r.id) ?? 0);
    }
    peerMedianByGroup.set(key, median(activeRates));
    peerCountByGroup.set(key, activeRates.length);
  }

  const readersByZone = new Map<string, HardwareReaderRow[]>();
  const readersByLocationUnzoned = new Map<string, HardwareReaderRow[]>();
  for (const d of devices.rows) {
    if (!READER_TYPES.has(d.device_type)) continue;
    // Bi-state dot: bridge present on the LAN → online; absent → offline.
    // The old amber/yellow "reachable" middle state — bridge alive but
    // chip not producing reads — was hated by operators (it dominated the
    // dashboard while the supervisor abort-loop bug 2026-05-11 kept chips
    // wedged across the fleet, and "reachable" reads as "kind of broken"
    // even when the network was perfectly healthy). The health-badge
    // logic below still surfaces "stuck" when a reachable bridge has zero
    // reads, so the diagnostic isn't lost — it just stops poisoning the
    // dot. The dot now answers "is this reader reachable?" not "is this
    // reader perfect?".
    const bridgeFresh =
      d.bridge_seen_at !== null &&
      nowMs - new Date(d.bridge_seen_at).getTime() <= BRIDGE_REACHABLE_MS;
    const bridgeState: "online" | "reachable" | "offline" =
      d.status_online || bridgeFresh ? "online" : "offline";

    const paused = parentPaused.get(d.id) ?? false;
    const reads5m = readsByReaderId.get(d.id) ?? 0;
    const groupId = `${d.location_id}|${d.device_type}`;
    const peerMedian = peerMedianByGroup.get(groupId) ?? 0;
    const peerCount = peerCountByGroup.get(groupId) ?? 0;
    let healthStatus: ReaderHealthStatus = "ok";
    if (paused) {
      healthStatus = "ok";
    } else if (d.chassis_wedged_at) {
      // Supervisor escalated this reader to Level 3 — chip unresponsive to
      // every software recovery. Surface clearly so the operator knows
      // physical service is the next step (instead of waiting for the
      // supervisor to silently retry forever).
      healthStatus = "needs_service";
    } else if (bridgeState === "offline") {
      healthStatus = "offline";
    } else if (
      bridgeState === "online" &&
      reads5m === 0 &&
      !d.status_online
    ) {
      // Bridge alive on the LAN but the chip is silent (no status_online
      // push from the agent + zero reads in 5 min). Chassis firmware
      // wedged → "stuck" badge. The dot stays green so the operator's eye
      // isn't drawn away from a network-healthy reader; the badge carries
      // the chip-level diagnostic. Was previously gated on the now-removed
      // bridge_state === "reachable" branch.
      healthStatus = "stuck";
    } else if (
      peerCount >= SLOW_MIN_PEERS &&
      peerMedian >= SLOW_MIN_PEER_MEDIAN &&
      reads5m < peerMedian * SLOW_FRACTION_OF_MEDIAN
    ) {
      healthStatus = "slow";
    }

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
      health: {
        status: healthStatus,
        reads_5m: reads5m,
        peers_median_5m: peerMedian,
      },
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
