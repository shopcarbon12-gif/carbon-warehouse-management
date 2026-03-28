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
