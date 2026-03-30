import type { Pool, PoolClient } from "pg";
import { labelNameForWmsStatus } from "@/lib/server/wms-status-to-label-name";

export type StatusLabelBrainRow = {
  name: string;
  is_sellable: boolean;
  is_visible_to_scanner: boolean;
  is_visible_in_ui: boolean;
  super_admin_locked: boolean;
  is_system_only: boolean;
};

/** Handheld + stationary antenna: drop reads when scanner visibility is off. */
export function shouldGhostDropLabel(flags: StatusLabelBrainRow | undefined): boolean {
  if (!flags) return false;
  return !flags.is_visible_to_scanner;
}

export async function loadStatusLabelBrainMap(
  db: Pool | PoolClient,
): Promise<Map<string, StatusLabelBrainRow>> {
  const r = await db.query<StatusLabelBrainRow>(
    `SELECT name,
            is_sellable,
            is_visible_to_scanner,
            is_visible_in_ui,
            super_admin_locked,
            is_system_only
     FROM status_labels`,
  );
  const m = new Map<string, StatusLabelBrainRow>();
  for (const row of r.rows) {
    m.set(row.name.trim().toLowerCase(), row);
  }
  return m;
}

function flagsForWmsStatus(
  map: Map<string, StatusLabelBrainRow>,
  wmsStatus: string,
): StatusLabelBrainRow | undefined {
  const labelName = labelNameForWmsStatus(wmsStatus);
  return map.get(labelName.trim().toLowerCase());
}

/** First EPC that must not move via transfer (ghost / non-scanner-visible inventory). */
export async function findTransferBlockedEpc(
  db: Pool | PoolClient,
  tenantId: string,
  epcs: string[],
): Promise<string | null> {
  if (epcs.length === 0) return null;
  const map = await loadStatusLabelBrainMap(db);
  const r = await db.query<{ epc: string; status: string }>(
    `SELECT i.epc, i.status
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     WHERE i.epc = ANY($2::text[])`,
    [tenantId, epcs],
  );
  for (const row of r.rows) {
    const f = flagsForWmsStatus(map, row.status);
    if (f && !f.is_visible_to_scanner) return row.epc.trim().toUpperCase();
  }
  return null;
}

/** First EPC that cannot be adjusted during cycle-count commit without Super Admin policy. */
export async function findAuditBlockedEpc(
  db: Pool | PoolClient,
  tenantId: string,
  epcs: string[],
): Promise<string | null> {
  if (epcs.length === 0) return null;
  const map = await loadStatusLabelBrainMap(db);
  const r = await db.query<{ epc: string; status: string }>(
    `SELECT i.epc, i.status
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     WHERE i.epc = ANY($2::text[])`,
    [tenantId, epcs],
  );
  for (const row of r.rows) {
    const f = flagsForWmsStatus(map, row.status);
    if (f?.super_admin_locked) return row.epc.trim().toUpperCase();
  }
  return null;
}

export type EpcVisibilityRow = { epc: string; visible: boolean };

/**
 * Per-EPC visibility for handheld ghost filter. Unknown EPC → visible (commissioning).
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
  const map = await loadStatusLabelBrainMap(db);
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
