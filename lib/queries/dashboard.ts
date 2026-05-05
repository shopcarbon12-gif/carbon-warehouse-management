import type { Pool } from "pg";

export type DashboardKpis = {
  inventory_units: number;
  order_open: number;
  exceptions_open: number;
  sync_pending: number;
  // Hardware Pulse (location-scoped device counts).
  hw_readers: number;
  hw_readers_online: number;
  hw_antennas: number;
  hw_antennas_online: number;
  hw_printers: number;
  hw_printers_online: number;
};

export async function getDashboardKpis(
  pool: Pool,
  tenantId: string,
  locationId: string,
): Promise<DashboardKpis> {
  const inv = await pool.query<{ c: string }>(
    `SELECT coalesce(sum(qty), 0)::text AS c
     FROM inventory_items
     WHERE location_id = $1::uuid`,
    [locationId],
  );
  const ord = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM orders
     WHERE tenant_id = $1::uuid
       AND location_id = $2::uuid
       AND status NOT IN ('shipped', 'cancelled')`,
    [tenantId, locationId],
  );
  const exc = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM exceptions
     WHERE tenant_id = $1::uuid
       AND location_id = $2::uuid
       AND state NOT IN ('resolved', 'ignored')`,
    [tenantId, locationId],
  );
  const sync = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM sync_jobs
     WHERE tenant_id = $1::uuid
       AND (location_id IS NULL OR location_id = $2::uuid)
       AND status IN ('queued', 'running', 'failed')`,
    [tenantId, locationId],
  );
  // Match the web command-center exactly: same FILTER clauses, same
  // location-only WHERE (no tenant filter — devices.location_id is unique
  // per tenant and the web query doesn't filter by tenant either, so
  // adding one here would surface a different count than the dashboard).
  // Online counts use status_online=true; "total" counts everything in
  // the category for completeness, even though the mobile UI surfaces
  // only the online figure to mirror the web's PulsePill.
  const hw = await pool.query<{
    readers: string;
    readers_online: string;
    antennas: string;
    antennas_online: string;
    printers: string;
    printers_online: string;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE device_type IN ('fixed_reader','transaction_reader','door_reader')
       )::text AS readers,
       COUNT(*) FILTER (
         WHERE device_type IN ('fixed_reader','transaction_reader','door_reader')
           AND status_online = true
       )::text AS readers_online,
       COUNT(*) FILTER (WHERE device_type = 'antenna')::text AS antennas,
       COUNT(*) FILTER (
         WHERE device_type = 'antenna' AND status_online = true
       )::text AS antennas_online,
       COUNT(*) FILTER (WHERE device_type = 'printer')::text AS printers,
       COUNT(*) FILTER (
         WHERE device_type = 'printer' AND status_online = true
       )::text AS printers_online
     FROM devices
     WHERE location_id = $1::uuid`,
    [locationId],
  );
  const reader = {
    total: Number(hw.rows[0]?.readers ?? 0),
    online: Number(hw.rows[0]?.readers_online ?? 0),
  };
  const antenna = {
    total: Number(hw.rows[0]?.antennas ?? 0),
    online: Number(hw.rows[0]?.antennas_online ?? 0),
  };
  const printer = {
    total: Number(hw.rows[0]?.printers ?? 0),
    online: Number(hw.rows[0]?.printers_online ?? 0),
  };
  return {
    inventory_units: Number(inv.rows[0]?.c ?? 0),
    order_open: Number(ord.rows[0]?.c ?? 0),
    exceptions_open: Number(exc.rows[0]?.c ?? 0),
    sync_pending: Number(sync.rows[0]?.c ?? 0),
    hw_readers: reader.total,
    hw_readers_online: reader.online,
    hw_antennas: antenna.total,
    hw_antennas_online: antenna.online,
    hw_printers: printer.total,
    hw_printers_online: printer.online,
  };
}
