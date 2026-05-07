import type { Pool, PoolClient } from "pg";

/**
 * Assert that a row in `table` with `id` belongs to (a) the caller's tenant
 * AND (b) the caller's *active* location. Used by per-row mutation routes
 * (CDM agents, zones, readers, antennas, devices) so a user signed into FL
 * Mall can't directly hit `/api/cdm-agents/{orlando-uuid}/regenerate-token`
 * and succeed because the tenant matches.
 *
 * Returns one of:
 *   - "ok"             — row exists and matches both tenant + location.
 *   - "not_found"      — no row with that id and tenant_id.
 *   - "wrong_location" — row exists for the tenant but at a different location.
 *
 * `locationId` is the active session lid. If the caller passes `null`/
 * `undefined`, only the tenant check is performed (legacy callers).
 */
export async function assertRowLocation(
  client: Pool | PoolClient,
  table: string,
  rowId: string,
  tenantId: string,
  locationId: string | null | undefined,
): Promise<"ok" | "not_found" | "wrong_location"> {
  // Whitelist the table name — `client.query` does not parameterize table
  // names, and this helper is called from many routes, so an injection
  // surface here would be very wide. Add new tables explicitly.
  const ALLOWED = new Set([
    "cdm_agents",
    "zones",
    "devices",
    "bins",
  ]);
  if (!ALLOWED.has(table)) {
    throw new Error(`assertRowLocation: refusing unknown table ${table}`);
  }

  const r = await client.query<{ location_id: string | null }>(
    `SELECT location_id::text AS location_id
       FROM ${table}
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      LIMIT 1`,
    [rowId, tenantId],
  );
  if (!r.rows[0]) return "not_found";
  if (locationId && r.rows[0].location_id !== locationId) return "wrong_location";
  return "ok";
}
