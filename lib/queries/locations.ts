import type { Sql } from "@/lib/db";

export type LocationRow = { id: string; code: string; name: string };

export async function listLocationsForTenant(
  sql: Sql,
  tenantId: string,
): Promise<LocationRow[]> {
  return sql<LocationRow[]>`
    SELECT id, code, name FROM locations
    WHERE tenant_id = ${tenantId}::uuid
    ORDER BY code ASC
  `;
}
