/**
 * WMS shim for the ported Shopify Collection Mapping feature.
 *
 * The feature's repositories were written against carbon-gen's `lib/sqlDb`,
 * which exposes a tiny query helper over a shared pg Pool. This shim provides
 * the same surface backed by WMS's own `getPool()` so the copied repository +
 * token repository run unchanged. Each repository creates its own tables
 * lazily (CREATE TABLE IF NOT EXISTS), so `ensureSqlReady` is a no-op here.
 */
import { getPool } from "@/lib/db";

export function hasSqlDatabaseConfigured(): boolean {
  return getPool() != null;
}

export async function sqlQuery<T = Record<string, unknown>>(
  query: string,
  params: unknown[] = []
): Promise<T[]> {
  const pool = getPool();
  if (!pool) throw new Error("Database unavailable");
  const { rows } = await pool.query(query, params);
  return rows as T[];
}

export async function ensureSqlReady(): Promise<void> {
  // No-op: WMS's getPool() lazily initializes the pool, and the
  // collection-mapping repositories create their own tables on first use.
}
