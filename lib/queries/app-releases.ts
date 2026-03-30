import type { Pool } from "pg";

export type AppReleaseRow = {
  id: number;
  version_label: string;
  apk_url: string;
  is_active: boolean;
  created_at: string;
};

export async function listAppReleases(pool: Pool, tenantId: string): Promise<AppReleaseRow[]> {
  const r = await pool.query<{
    id: number;
    version_label: string;
    apk_url: string;
    is_active: boolean;
    created_at: Date;
  }>(
    `SELECT id, version_label, apk_url, is_active, created_at
     FROM app_releases
     WHERE tenant_id = $1::uuid
     ORDER BY created_at DESC`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    version_label: row.version_label,
    apk_url: row.apk_url,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
  }));
}

export async function deactivateAllReleases(pool: Pool, tenantId: string): Promise<void> {
  await pool.query(`UPDATE app_releases SET is_active = false, updated_at = now() WHERE tenant_id = $1::uuid`, [
    tenantId,
  ]);
}

export async function insertAppRelease(
  pool: Pool,
  tenantId: string,
  input: { version_label: string; apk_url: string; makeActive: boolean },
): Promise<number> {
  if (input.makeActive) {
    await deactivateAllReleases(pool, tenantId);
  }
  const r = await pool.query<{ id: string }>(
    `INSERT INTO app_releases (tenant_id, version_label, apk_url, is_active)
     VALUES ($1::uuid, $2, $3, $4)
     RETURNING id::text`,
    [tenantId, input.version_label.trim(), input.apk_url, input.makeActive],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error("insertAppRelease failed");
  return Number(id);
}

export async function getActiveRelease(
  pool: Pool,
  tenantId: string,
): Promise<AppReleaseRow | null> {
  const r = await pool.query<{
    id: number;
    version_label: string;
    apk_url: string;
    is_active: boolean;
    created_at: Date;
  }>(
    `SELECT id, version_label, apk_url, is_active, created_at
     FROM app_releases
     WHERE tenant_id = $1::uuid AND is_active = true
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    version_label: row.version_label,
    apk_url: row.apk_url,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
  };
}
