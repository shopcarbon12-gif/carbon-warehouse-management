import { Pool, type PoolConfig } from "pg";

let pool: Pool | null = null;

function getConnectionString(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  return url && url.length > 0 ? url : undefined;
}

function poolOptions(connectionString: string): PoolConfig {
  return {
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}

/** Singleton connection pool (Coolify / long-running Node). */
export function getPool(): Pool | null {
  const url = getConnectionString();
  if (!url) return null;
  if (!pool) {
    pool = new Pool(poolOptions(url));
    pool.on("error", (err) => {
      console.error("[db] idle pool client error", err);
    });
  }
  return pool;
}

/** @deprecated Use `getPool()` — alias for existing call sites during migration. */
export const getSql = getPool;

export type DbPool = Pool;

/**
 * Run a callback with the pool, or return fallback when DATABASE_URL is unset or the query fails.
 */
export async function withDb<T>(
  fn: (pool: Pool) => Promise<T>,
  fallback: T,
): Promise<T> {
  const p = getPool();
  if (!p) return fallback;
  try {
    return await fn(p);
  } catch (e) {
    console.error("[db]", e);
    return fallback;
  }
}

/** True when the driver failed to connect (local dev: Postgres not running). */
export function isDatabaseUnreachable(e: unknown): boolean {
  const err = e as { code?: string };
  const codes = ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"];
  return err?.code != null && codes.includes(err.code);
}
