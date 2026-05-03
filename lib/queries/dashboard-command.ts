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
  /** Hardware presence at this location. Drives the Live scan tile's enabled state. */
  hardware: HardwareCounts;
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
  // Hardware counts reflect "actually working RIGHT NOW" state, not
  // "ever registered" or "configured." Definition of "working":
  //   - Readers / antennas: produced at least one read in the last 60 s
  //     (i.e. cdm_reads.ingested_at within the window). A reader that's
  //     wedged at firmware level shows up as 0 even if its DB row says
  //     status_online=true. This is the operator's mental model: if .22
  //     stops scanning, the readers count drops from 2 → 1 immediately.
  //   - Printers / handhelds: status_online=true (and authorized for
  //     handhelds). They don't produce a read stream we can sample, so
  //     the heartbeat-based status is the best signal we have.
  const hw = await pool.query<{
    readers: string;
    antennas: string;
    printers: string;
    handhelds: string;
  }>(
    `WITH active_streams AS (
       SELECT reader_id, antenna_id
         FROM cdm_reads
        WHERE tenant_id = $2::uuid
          AND ingested_at > now() - interval '60 seconds'
     )
     SELECT
       (SELECT count(DISTINCT a.reader_id)::text
          FROM active_streams a
          INNER JOIN devices d ON d.id = a.reader_id
         WHERE d.location_id = $1::uuid
           AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
       ) AS readers,
       (SELECT count(DISTINCT a.antenna_id)::text
          FROM active_streams a
          INNER JOIN devices d ON d.id = a.antenna_id
         WHERE d.location_id = $1::uuid
           AND d.device_type = 'antenna'
           AND a.antenna_id IS NOT NULL
       ) AS antennas,
       (SELECT count(*)::text FROM devices
         WHERE location_id = $1::uuid
           AND device_type = 'printer'
           AND status_online = true
       ) AS printers,
       (SELECT count(*)::text FROM devices
         WHERE location_id = $1::uuid
           AND device_type = 'handheld_reader'
           AND status_online = true
           AND is_authorized = true
       ) AS handhelds`,
    [locationId, tenantId],
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
