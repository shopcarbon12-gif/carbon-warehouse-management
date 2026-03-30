import type { Pool, PoolClient } from "pg";
import { labelNameForWmsStatus } from "@/lib/server/wms-status-to-label-name";

export type StatusLabelBehaviorRow = {
  name: string;
  auto_display: boolean;
  hide_in_search_filters: boolean;
  hide_in_item_details: boolean;
  prevent_transfer: boolean;
  prevent_audit: boolean;
};

/** Ghost read: drop from handheld UI / session when any of these apply. */
export function shouldGhostDropLabel(flags: StatusLabelBehaviorRow | undefined): boolean {
  if (!flags) return false;
  return (
    flags.hide_in_search_filters ||
    flags.hide_in_item_details ||
    flags.auto_display === false
  );
}

export async function loadStatusLabelBehaviorMap(
  db: Pool | PoolClient,
): Promise<Map<string, StatusLabelBehaviorRow>> {
  const r = await db.query<{
    name: string;
    auto_display: boolean;
    hide_in_search_filters: boolean;
    hide_in_item_details: boolean;
    prevent_transfer: boolean;
    prevent_audit: boolean;
  }>(
    `SELECT name,
            auto_display,
            hide_in_search_filters,
            hide_in_item_details,
            prevent_transfer,
            prevent_audit
     FROM status_labels`,
  );
  const m = new Map<string, StatusLabelBehaviorRow>();
  for (const row of r.rows) {
    m.set(row.name.trim().toLowerCase(), {
      name: row.name,
      auto_display: row.auto_display,
      hide_in_search_filters: row.hide_in_search_filters,
      hide_in_item_details: row.hide_in_item_details,
      prevent_transfer: row.prevent_transfer,
      prevent_audit: row.prevent_audit,
    });
  }
  return m;
}

function flagsForWmsStatus(
  map: Map<string, StatusLabelBehaviorRow>,
  wmsStatus: string,
): StatusLabelBehaviorRow | undefined {
  const labelName = labelNameForWmsStatus(wmsStatus);
  return map.get(labelName.trim().toLowerCase());
}

/** First EPC that cannot move during transfer (web or edge). */
export async function findTransferBlockedEpc(
  db: Pool | PoolClient,
  tenantId: string,
  epcs: string[],
): Promise<string | null> {
  if (epcs.length === 0) return null;
  const map = await loadStatusLabelBehaviorMap(db);
  const r = await db.query<{ epc: string; status: string }>(
    `SELECT i.epc, i.status
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     WHERE i.epc = ANY($2::text[])`,
    [tenantId, epcs],
  );
  for (const row of r.rows) {
    const f = flagsForWmsStatus(map, row.status);
    if (f?.prevent_transfer) return row.epc.trim().toUpperCase();
  }
  return null;
}

/** First EPC that cannot be changed during cycle-count / audit commit. */
export async function findAuditBlockedEpc(
  db: Pool | PoolClient,
  tenantId: string,
  epcs: string[],
): Promise<string | null> {
  if (epcs.length === 0) return null;
  const map = await loadStatusLabelBehaviorMap(db);
  const r = await db.query<{ epc: string; status: string }>(
    `SELECT i.epc, i.status
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     WHERE i.epc = ANY($2::text[])`,
    [tenantId, epcs],
  );
  for (const row of r.rows) {
    const f = flagsForWmsStatus(map, row.status);
    if (f?.prevent_audit) return row.epc.trim().toUpperCase();
  }
  return null;
}

export type EpcVisibilityRow = { epc: string; visible: boolean };

/**
 * Per-EPC visibility for handheld ghost-read rule. Unknown EPC → visible (commissioning).
 */
export async function resolveEpcVisibilityForTenant(
  db: Pool | PoolClient,
  tenantId: string,
  epcs: string[],
): Promise<EpcVisibilityRow[]> {
  const norm = [...new Set(epcs.map((e) => e.replace(/\s/g, "").toUpperCase()))].filter((e) =>
    /^[0-9A-F]{24}$/.test(e),
  );
  if (norm.length === 0) return [];
  const map = await loadStatusLabelBehaviorMap(db);
  const r = await db.query<{ epc: string; status: string | null }>(
    `SELECT i.epc, i.status
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     WHERE i.epc = ANY($2::text[])`,
    [tenantId, norm],
  );
  const byEpc = new Map<string, string | null>();
  for (const row of r.rows) {
    byEpc.set(row.epc.trim().toUpperCase(), row.status);
  }
  return norm.map((epc) => {
    const st = byEpc.get(epc);
    if (st == null) return { epc, visible: true };
    const flags = flagsForWmsStatus(map, st);
    return { epc, visible: !shouldGhostDropLabel(flags) };
  });
}
