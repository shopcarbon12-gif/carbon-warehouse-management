import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function withDb<T>(
  fn: (p: Pool) => Promise<T>,
  fallback: T
): Promise<T> {
  const p = getPool();
  if (!p) return fallback;
  try {
    return await fn(p);
  } catch {
    return fallback;
  }
}
