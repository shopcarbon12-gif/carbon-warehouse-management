import type { Pool } from "pg";
import { DEFECTIVE_SCOPE_CTE, DEFECTIVE_SCOPE_WHERE } from "@/lib/server/defective-epc-scope";

export type HardwareCounts = {
  readers: number;
  antennas: number;
  printers: number;
  handhelds: number;
};

export type CommandCenterKpis = {
  /** items at this location with status='in-stock' (LIVE). */
  live_inventory: number;
  /** legacy alias of live_inventory. */
  total_items: number;
  receiving_concerns: number;
  /** items with status='tag_killed' that haven't been dismissed in Defective EPCs. */
  defective_epcs: number;
  /** legacy alias of defective_epcs. */
  unknown_assets: number;
  /** Real-time activity counts (last 60 s). hardware.readers/antennas can be 0
   *  while the location HAS configured readers — that just means scanning is
   *  off. Use `has_scannable_hardware` to gate the Live scan tile click. */
  hardware: HardwareCounts;
  /** True if the location has at least one configured fixed/transaction/door
   *  reader. Independent of whether scanning is currently active. The Live
   *  scan tile enables on this; without it the tile would be permanently
   *  un-clickable when idle (chicken-and-egg). */
  has_scannable_hardware: boolean;
};

export type AuditLogListRow = {
  id: string;
  action: string;
  entity: string;
  metadata: unknown;
  created_at: string;
};

export async function getCommandCenterKpis(
  pool: Pool,
  locationId: string,
  tenantId: string,
): Promise<CommandCenterKpis> {
  const live = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM items
     WHERE location_id = $1::uuid AND status = 'in-stock'`,
    [locationId],
  );
  // Receiving concerns: inbound transfers headed to this location that
  // haven't fully landed yet — actual receiving work, not exceptions.
  // Previous query counted items.status='pending_visibility' and the
  // tile linked to /alerts (dock-alarm workspace), which is irrelevant
  // when no dock alarms are installed.
  const incomplete = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c
     FROM transfer_records tr
     WHERE tr.tenant_id = $1::uuid
       AND tr.destination_location_id = $2::uuid
       AND tr.state IN ('in-transit', 'partially_received')`,
    [tenantId, locationId],
  );
  // Defective EPCs: shared predicate with the modal (see
  // lib/server/defective-epc-scope). Scoped to the LATEST committed cycle
  // count plus every manually-killed tag, rather than every tag_killed row
  // ever — the old scope only grew and could not distinguish this count's
  // findings from months of accumulation. Still scoped to the active location
  // so switching from Orlando to FL Mall doesn't leak one into the other.
  const defective = await pool.query<{ c: string }>(
    `WITH ${DEFECTIVE_SCOPE_CTE}
     SELECT count(*)::text AS c
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     WHERE ${DEFECTIVE_SCOPE_WHERE}`,
    [tenantId, locationId],
  );
  // Hardware counts reflect "currently operational" state, not "ever
  // registered." Each filter requires status_online=true so paused or
  // stale devices fall out automatically. Handhelds also require
  // is_authorized=true (operator has approved the device).
  // Earlier code added +1 to printers for an "implicit Zebra default"
  // baked into /rfid/commissioning — that wasn't a real device, just a
  // hardcoded fallback in the form. Removed: dashboard counts the
  // printers that actually exist in the devices table, period.
  const hw = await pool.query<{
    readers: string;
    antennas: string;
    printers: string;
    handhelds: string;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE device_type IN ('fixed_reader','transaction_reader','door_reader')
           AND status_online = true
       )::text AS readers,
       COUNT(*) FILTER (
         WHERE device_type = 'antenna'
           AND last_read_at IS NOT NULL
           AND last_read_at >= now() - interval '15 minutes'
       )::text AS antennas,
       COUNT(*) FILTER (
         WHERE device_type = 'printer' AND status_online = true
       )::text AS printers,
       COUNT(*) FILTER (
         WHERE device_type = 'handheld_reader'
           AND status_online = true
           AND is_authorized = true
       )::text AS handhelds
     FROM devices
     WHERE location_id = $1::uuid`,
    [locationId],
  );
  const scannable = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM devices
      WHERE location_id = $1::uuid
        AND device_type IN ('fixed_reader','transaction_reader','door_reader')`,
    [locationId],
  );
  const liveCount = Number(live.rows[0]?.c ?? 0);
  const defectiveCount = Number(defective.rows[0]?.c ?? 0);
  return {
    live_inventory: liveCount,
    total_items: liveCount,
    receiving_concerns: Number(incomplete.rows[0]?.c ?? 0),
    defective_epcs: defectiveCount,
    unknown_assets: defectiveCount,
    hardware: {
      readers: Number(hw.rows[0]?.readers ?? 0),
      antennas: Number(hw.rows[0]?.antennas ?? 0),
      printers: Number(hw.rows[0]?.printers ?? 0),
      handhelds: Number(hw.rows[0]?.handhelds ?? 0),
    },
    has_scannable_hardware: Number(scannable.rows[0]?.c ?? 0) > 0,
  };
}

export async function listRecentAuditForTenant(
  pool: Pool,
  tenantId: string,
  limit: number,
): Promise<AuditLogListRow[]> {
  const r = await pool.query<{
    id: string;
    action: string;
    entity: string;
    metadata: unknown;
    created_at: Date;
  }>(
    `SELECT id, action, entity, metadata, created_at
     FROM audit_log
     WHERE tenant_id = $1::uuid
     ORDER BY created_at DESC
     LIMIT $2`,
    [tenantId, limit],
  );
  return r.rows.map((row) => ({
    id: row.id,
    action: row.action,
    entity: row.entity,
    metadata: row.metadata,
    created_at: row.created_at.toISOString(),
  }));
}
