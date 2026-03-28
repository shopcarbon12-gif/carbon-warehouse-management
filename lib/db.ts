import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

let client: Sql | null = null;

function getConnectionString(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  return url && url.length > 0 ? url : undefined;
}

/** Singleton Postgres client (Coolify / long-running Node). */
export function getSql(): Sql | null {
  const url = getConnectionString();
  if (!url) return null;
  if (!client) {
    client = postgres(url, { max: 10, prepare: false });
  }
  return client;
}

/**
 * Run a query with SQL, or return fallback when DATABASE_URL is unset or query fails.
 */
export async function withDb<T>(
  fn: (sql: Sql) => Promise<T>,
  fallback: T,
): Promise<T> {
  const sql = getSql();
  if (!sql) return fallback;
  try {
    return await fn(sql);
  } catch (e) {
    console.error("[db]", e);
    return fallback;
  }
}

/** True when the driver failed to connect (local dev: Postgres not running). */
export function isDatabaseUnreachable(e: unknown): boolean {
  const err = e as { code?: string; errors?: { code?: string }[] };
  const codes = ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"];
  if (err?.code && codes.includes(err.code)) return true;
  return err?.errors?.some((x) => x?.code && codes.includes(x.code)) ?? false;
}
