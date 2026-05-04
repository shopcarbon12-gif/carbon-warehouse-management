import type { Pool } from "pg";

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
  const incomplete = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM items
     WHERE location_id = $1::uuid AND status = 'pending_visibility'`,
    [locationId],
  );
  // Defective EPCs: same predicate as the modal — tag_killed and not yet dismissed,
  // OR re-scanned since the last dismissal so they re-appear automatically.
  // Tenant-wide (matches catalog modal scope) since defectives aren't location-specific.
  const defective = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     WHERE i.status = 'tag_killed'
       AND (i.defective_acknowledged_at IS NULL
            OR i.last_seen_at > i.defective_acknowledged_at)`,
    [tenantId],
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
         WHERE device_type = 'antenna' AND status_online = true
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
