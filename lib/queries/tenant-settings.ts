import type { Pool } from "pg";
import { mergeDeep } from "@/lib/settings/tenant-settings-merge";
import {
  DEFAULT_EPC_PROFILES,
  DEFAULT_EPC_SETTINGS,
  DEFAULT_HANDHELD_SETTINGS,
  normalizeEpcProfiles,
  normalizeEpcSettings,
  normalizeHandheldSettings,
  type EpcProfile,
  type EpcSettings,
  type HandheldSettings,
  type TenantSettingsRow,
} from "@/lib/settings/tenant-settings-defaults";

export async function getTenantSettingsRow(pool: Pool, tenantId: string): Promise<TenantSettingsRow | null> {
  const r = await pool.query<{
    epc_settings: unknown;
    epc_profiles: unknown;
    handheld_settings: unknown;
    updated_at: Date;
  }>(
    `SELECT epc_settings, epc_profiles, handheld_settings, updated_at
     FROM tenant_settings
     WHERE tenant_id = $1::uuid
     LIMIT 1`,
    [tenantId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    epc_settings: normalizeEpcSettings(row.epc_settings),
    epc_profiles: normalizeEpcProfiles(row.epc_profiles),
    handheld_settings: normalizeHandheldSettings(row.handheld_settings),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function ensureTenantSettings(
  pool: Pool,
  tenantId: string,
): Promise<TenantSettingsRow> {
  const existing = await getTenantSettingsRow(pool, tenantId);
  if (existing) return existing;

  await pool.query(
    `INSERT INTO tenant_settings (tenant_id, epc_settings, epc_profiles, handheld_settings)
     VALUES ($1::uuid, $2::jsonb, $3::jsonb, $4::jsonb)`,
    [
      tenantId,
      JSON.stringify(DEFAULT_EPC_SETTINGS),
      JSON.stringify(DEFAULT_EPC_PROFILES),
      JSON.stringify(DEFAULT_HANDHELD_SETTINGS),
    ],
  );

  const again = await getTenantSettingsRow(pool, tenantId);
  if (!again) throw new Error("tenant_settings insert failed");
  return again;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export async function updateTenantSettingsPartial(
  pool: Pool,
  tenantId: string,
  patch: {
    epc_settings?: Partial<EpcSettings>;
    epc_profiles?: EpcProfile[];
    handheld_settings?: DeepPartial<HandheldSettings>;
  },
): Promise<TenantSettingsRow> {
  const current = await ensureTenantSettings(pool, tenantId);

  let epc_settings = current.epc_settings;
  if (patch.epc_settings) {
    epc_settings = normalizeEpcSettings({ ...current.epc_settings, ...patch.epc_settings });
  }

  let epc_profiles = current.epc_profiles;
  if (patch.epc_profiles) {
    epc_profiles = normalizeEpcProfiles(patch.epc_profiles);
  }

  let handheld_settings = current.handheld_settings;
  if (patch.handheld_settings) {
    handheld_settings = normalizeHandheldSettings(
      mergeDeep(current.handheld_settings, patch.handheld_settings as HandheldSettings),
    );
  }

  await pool.query(
    `UPDATE tenant_settings
     SET epc_settings = $2::jsonb,
         epc_profiles = $3::jsonb,
         handheld_settings = $4::jsonb,
         updated_at = now()
     WHERE tenant_id = $1::uuid`,
    [
      tenantId,
      JSON.stringify(epc_settings),
      JSON.stringify(epc_profiles),
      JSON.stringify(handheld_settings),
    ],
  );

  const next = await getTenantSettingsRow(pool, tenantId);
  if (!next) throw new Error("tenant_settings update failed");
  return next;
}
