import type { Pool } from "pg";

/** Minimum tables for baseline WMS UI (dashboard KPIs, locations/bin counts, auth, audit). */
export const WMS_CORE_TABLES = [
  "locations",
  "bins",
  "tenants",
  "users",
  "items",
  "audit_log",
] as const;

export type CoreTableName = (typeof WMS_CORE_TABLES)[number];

/**
 * Returns which core tables are missing in `public` (empty array = OK).
 */
export async function listMissingCoreTables(pool: Pool): Promise<CoreTableName[]> {
  const r = await pool.query<{ t: string }>(
    `SELECT table_name AS t
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [WMS_CORE_TABLES as unknown as string[]],
  );
  const have = new Set(r.rows.map((x) => x.t));
  return WMS_CORE_TABLES.filter((name) => !have.has(name));
}
