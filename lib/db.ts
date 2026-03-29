import { Pool, type PoolConfig } from "pg";

let pool: Pool | null = null;

const poolCommon: Pick<
  PoolConfig,
  "max" | "idleTimeoutMillis" | "connectionTimeoutMillis"
> = {
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
};

function getConnectionString(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  return url && url.length > 0 ? url : undefined;
}

/** When `DATABASE_URL` is unset, use `PGHOST` + `PGUSER` (+ optional `PGPASSWORD`, `PGDATABASE`, `PGPORT`) like libpq. */
function getPoolConfigFromPgEnv(): PoolConfig | null {
  const host = process.env.PGHOST?.trim();
  const user = process.env.PGUSER?.trim();
  if (!host || !user) return null;
  const database = process.env.PGDATABASE?.trim() || "postgres";
  const port = Number(process.env.PGPORT ?? 5432);
  const password = process.env.PGPASSWORD ?? "";
  return {
    host,
    port: Number.isFinite(port) ? port : 5432,
    user,
    password,
    database,
    ...poolCommon,
  };
}

function resolvePoolConfig(): PoolConfig | null {
  const url = getConnectionString();
  if (url) {
    return { connectionString: url, ...poolCommon };
  }
  return getPoolConfigFromPgEnv();
}

/** Singleton connection pool (Coolify / long-running Node). */
export function getPool(): Pool | null {
  const config = resolvePoolConfig();
  if (!config) return null;
  if (!pool) {
    pool = new Pool(config);
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
 * Run a callback with the pool, or return fallback when no DB config is set or the query fails.
 * Config: `DATABASE_URL`, or `PGHOST` + `PGUSER` (+ optional `PGPASSWORD`, `PGDATABASE`, `PGPORT`).
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

/**
 * True when Postgres cannot be used: network failure, connection class SQLSTATE (08*),
 * wrong password / role (28P01), or missing database (3D000).
 * node-pg sets `code` to SQLSTATE for server errors; Node sets syscall codes for TCP/DNS.
 */
export function isDatabaseUnreachable(e: unknown): boolean {
  const err = e as { code?: string };
  const c = err?.code;
  if (!c) return false;
  const network = ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET"];
  if (network.includes(c)) return true;
  if (c === "28P01" || c === "3D000") return true;
  if (c.startsWith("08")) return true;
  return false;
}
