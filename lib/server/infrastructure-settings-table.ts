import type { Pool, PoolClient } from "pg";
import { getInfrastructureSettings } from "@/lib/server/infrastructure-settings";

export type LightspeedSyncCredentialRow = {
  clientId: string;
  clientSecret: string;
  accountId: string;
  domainPrefix: string;
  refreshToken: string;
  personalToken: string;
};

/**
 * Reads `infrastructure_settings` (per-tenant sync store) and merges env + `tenants.settings`
 * fallbacks so POST /api/inventory/sync/trigger can resolve credentials.
 * Client secret prefers `LS_CLIENT_SECRET` env; optional DB column for future encrypted storage.
 */
export async function getLightspeedCredentialsForSync(
  pool: Pool | PoolClient,
  tenantId: string,
): Promise<LightspeedSyncCredentialRow> {
  const row = await pool.query<{
    ls_client_id: string | null;
    ls_client_secret: string | null;
    ls_account_id: string | null;
    ls_domain_prefix: string | null;
  }>(
    `SELECT ls_client_id, ls_client_secret, ls_account_id, ls_domain_prefix
     FROM infrastructure_settings
     WHERE tenant_id = $1::uuid
     LIMIT 1`,
    [tenantId],
  );

  const dto = await getInfrastructureSettings(pool, tenantId);
  const fromRow = row.rows[0];

  const clientId =
    (fromRow?.ls_client_id?.trim() || dto.integrations.lightspeed.client_id || "").trim() ||
    (process.env.LS_CLIENT_ID ?? "").trim();

  const accountId =
    (fromRow?.ls_account_id?.trim() || dto.integrations.lightspeed.account_id || "").trim() ||
    (process.env.LS_ACCOUNT_ID ?? "").trim();

  const domainPrefix =
    (fromRow?.ls_domain_prefix?.trim() || dto.integrations.lightspeed.domain_prefix || "").trim() ||
    (process.env.LS_DOMAIN_PREFIX ?? "").trim();

  const clientSecret =
    (process.env.LS_CLIENT_SECRET ?? "").trim() ||
    (fromRow?.ls_client_secret?.trim() ?? "");

  const refreshToken = (process.env.LS_REFRESH_TOKEN ?? "").trim();
  const personalToken = (process.env.LS_PERSONAL_TOKEN ?? "").trim();

  return {
    clientId,
    clientSecret,
    accountId,
    domainPrefix,
    refreshToken,
    personalToken,
  };
}

/** R-Series (`api.lightspeedapp.com`): account id + OAuth refresh — same as carbon-gen. */
export function credentialsLookUsableForRSeries(c: LightspeedSyncCredentialRow): boolean {
  const account = c.accountId.trim();
  return Boolean(account && c.clientId && c.clientSecret && c.refreshToken);
}

/** Retail X-Series (`*.retail.lightspeed.app` / `LS_PERSONAL_TOKEN`). */
export function credentialsLookUsableForRetailXSeries(c: LightspeedSyncCredentialRow): boolean {
  if (!c.domainPrefix.trim()) return false;
  if (c.personalToken.trim()) return true;
  return Boolean(c.clientId && c.clientSecret && c.refreshToken);
}

export function credentialsLookUsableForLiveFetch(c: LightspeedSyncCredentialRow): boolean {
  return credentialsLookUsableForRSeries(c) || credentialsLookUsableForRetailXSeries(c);
}

/** Upsert Lightspeed identifiers into `infrastructure_settings` after tenant JSON patch. */
export async function upsertInfrastructureSettingsRow(
  client: PoolClient,
  tenantId: string,
  lightspeed: { client_id?: string; account_id?: string; domain_prefix?: string },
): Promise<void> {
  const cid = lightspeed.client_id?.trim() ?? "";
  const aid = lightspeed.account_id?.trim() ?? "";
  const dom = lightspeed.domain_prefix?.trim() ?? "";

  await client.query(
    `INSERT INTO infrastructure_settings (
       tenant_id, ls_client_id, ls_account_id, ls_domain_prefix, updated_at
     )
     VALUES ($1::uuid, NULLIF($2::text, ''), NULLIF($3::text, ''), NULLIF($4::text, ''), now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       ls_client_id = COALESCE(NULLIF(EXCLUDED.ls_client_id, ''), infrastructure_settings.ls_client_id),
       ls_account_id = COALESCE(NULLIF(EXCLUDED.ls_account_id, ''), infrastructure_settings.ls_account_id),
       ls_domain_prefix = COALESCE(NULLIF(EXCLUDED.ls_domain_prefix, ''), infrastructure_settings.ls_domain_prefix),
       updated_at = now()`,
    [tenantId, cid, aid, dom],
  );
}

/** Ensure a row exists (empty) so FK and future edits are consistent. */
export async function ensureInfrastructureSettingsRow(
  client: PoolClient,
  tenantId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO infrastructure_settings (tenant_id, updated_at)
     VALUES ($1::uuid, now())
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );
}
