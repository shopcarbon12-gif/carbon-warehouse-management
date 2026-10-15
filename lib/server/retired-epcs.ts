import type { Pool, PoolClient } from "pg";

/**
 * Retired EPCs — chip IDs a confirmed re-encode replaced.
 *
 * A re-encode writes a new EPC onto the chip; once the new tag is live,
 * encode-finalize deletes the old EPC's items row (encode_events keeps
 * old → new). With the row gone, a later read of the old EPC looked like a
 * brand-new tag, and the scan rule lets a brand-new tag that decodes to a
 * catalog SKU go LIVE — so the same garment counted twice, under the old SKU
 * too. The late reads come from scans taken before the encode (an Add-On Count
 * session uploads its whole list hours later) or from an old chip that is
 * physically still around.
 *
 * Owner rule (2026-10-14): an EPC that was re-encoded away never comes back
 * through a scan — no beep, no count, never LIVE again. An encode_events row
 * with status 'ok' is a verified write. An EPC that a LATER confirmed encode
 * wrote again (old → X → … → X) is a live chip ID again, so it is not retired.
 */

/** Status the handheld's live catalog and epc-lookup carry for a retired EPC
 *  that has no items row. Never written to items.status. */
export const RETIRED_EPC_STATUS = "retired";

const NOT_WRITTEN_AGAIN = `NOT EXISTS (
         SELECT 1 FROM encode_events n
          WHERE n.status = 'ok'
            AND n.new_epc = e.old_epc
            AND COALESCE(n.encoded_at, n.created_at) > COALESCE(e.encoded_at, e.created_at))`;

/** The subset of [epcs] that are retired (uppercased). */
export async function loadRetiredEpcs(
  db: Pool | PoolClient,
  epcs: string[],
): Promise<Set<string>> {
  const upper = [...new Set(epcs.map((e) => e.replace(/\s/g, "").toUpperCase()))].filter(Boolean);
  if (upper.length === 0) return new Set();
  const r = await db.query<{ epc: string }>(
    `SELECT DISTINCT e.old_epc AS epc
       FROM encode_events e
      WHERE e.status = 'ok'
        AND e.old_epc = ANY($1::text[])
        AND ${NOT_WRITTEN_AGAIN}`,
    [upper],
  );
  return new Set(r.rows.map((row) => row.epc.toUpperCase()));
}

/**
 * Every retired EPC of [tenantId] that has no items row — what the handheld's
 * live catalog needs so the phone stays silent on them. Encodes logged before
 * warehouse_id held a location id ('001') belong to the only tenant there was.
 */
export async function listRetiredEpcsWithoutItem(
  db: Pool | PoolClient,
  tenantId: string,
): Promise<string[]> {
  const r = await db.query<{ epc: string }>(
    `SELECT DISTINCT e.old_epc AS epc
       FROM encode_events e
       LEFT JOIN locations l ON l.id::text = e.warehouse_id
      WHERE e.status = 'ok'
        AND (l.tenant_id = $1::uuid OR l.id IS NULL)
        AND ${NOT_WRITTEN_AGAIN}
        AND NOT EXISTS (SELECT 1 FROM items i WHERE i.epc = e.old_epc)`,
    [tenantId],
  );
  return r.rows.map((row) => row.epc.toUpperCase());
}
