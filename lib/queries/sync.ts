import type { Pool } from "pg";

export type SyncRunRow = {
  id: number;
  provider: string;
  status: string;
  message: string | null;
  started_at: string;
  finished_at: string | null;
};

export async function listRecentSyncRuns(pool: Pool, limit = 20): Promise<SyncRunRow[]> {
  const { rows } = await pool.query<SyncRunRow>(
    `SELECT id, provider, status, message,
            to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
            to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS finished_at
     FROM sync_runs
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function insertSyncRun(
  pool: Pool,
  provider: "shopify" | "lightspeed" | "senitron",
  status: string,
  message: string | null,
  finished: boolean
): Promise<void> {
  await pool.query(
    `INSERT INTO sync_runs (provider, status, message, finished_at)
     VALUES ($1, $2, $3, CASE WHEN $4 THEN now() ELSE NULL END)`,
    [provider, status, message, finished]
  );
}
