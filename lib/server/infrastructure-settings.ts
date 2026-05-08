import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { upsertInfrastructureSettingsRow } from "@/lib/server/infrastructure-settings-table";

export type RfidSettings = {
  company_prefix: number;
  item_bits: number;
  serial_bits: number;
  printer_default: string;
};

export type LightspeedIntegrationSettings = {
  client_id: string;
  account_id: string;
  domain_prefix: string;
  client_secret_configured_env: boolean;
};

export type InfrastructureSettingsDto = {
  rfid: RfidSettings;
  integrations: { lightspeed: LightspeedIntegrationSettings };
  hints: {
    env_company_prefix: boolean;
    env_ls_client_secret: boolean;
    env_ls_refresh_token: boolean;
  };
};

const patchSchema = z.object({
  rfid: z
    .object({
      company_prefix: z.coerce.number().int().min(0).optional(),
      item_bits: z.coerce.number().int().min(1).max(64).optional(),
      serial_bits: z.coerce.number().int().min(1).max(64).optional(),
      printer_default: z.string().max(256).optional(),
    })
    .optional(),
  integrations: z
    .object({
      lightspeed: z
        .object({
          client_id: z.string().max(256).optional(),
          account_id: z.string().max(128).optional(),
          domain_prefix: z.string().max(128).optional(),
        })
        .optional(),
    })
    .optional(),
});

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] !== null) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export async function getInfrastructureSettings(
  pool: Pool | PoolClient,
  tenantId: string,
): Promise<InfrastructureSettingsDto> {
  const r = await pool.query<{ settings: unknown }>(
    `SELECT COALESCE(settings, '{}'::jsonb) AS settings FROM tenants WHERE id = $1::uuid LIMIT 1`,
    [tenantId],
  );
  const raw = r.rows[0]?.settings;
  const s =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const rfidStored = (s.rfid as Record<string, unknown> | undefined) ?? {};
  const lsStored =
    ((s.integrations as Record<string, unknown> | undefined)?.lightspeed as Record<
      string,
      unknown
    > | undefined) ?? {};

  const fromEnv = Boolean(process.env.WMS_COMPANY_PREFIX?.trim());
  const effectivePrefix = fromEnv
    ? envNum("WMS_COMPANY_PREFIX", 1_044_991)
    : Number(rfidStored.company_prefix ?? 1_044_991);

  const rfid: RfidSettings = {
    company_prefix: effectivePrefix,
    item_bits: Number(rfidStored.item_bits ?? 40),
    serial_bits: Number(rfidStored.serial_bits ?? 36),
    printer_default: String(
      rfidStored.printer_default ?? "192.168.1.3:80 / PSTPRNT",
    ),
  };

  const lightspeed: LightspeedIntegrationSettings = {
    client_id: String(lsStored.client_id ?? process.env.LS_CLIENT_ID ?? ""),
    account_id: String(lsStored.account_id ?? process.env.LS_ACCOUNT_ID ?? ""),
    domain_prefix: String(lsStored.domain_prefix ?? process.env.LS_DOMAIN_PREFIX ?? ""),
    client_secret_configured_env: Boolean(process.env.LS_CLIENT_SECRET?.trim()),
  };

  return {
    rfid,
    integrations: { lightspeed },
    hints: {
      env_company_prefix: fromEnv,
      env_ls_client_secret: Boolean(process.env.LS_CLIENT_SECRET?.trim()),
      env_ls_refresh_token: Boolean(process.env.LS_REFRESH_TOKEN?.trim()),
    },
  };
}

export async function updateInfrastructureSettings(
  client: PoolClient,
  tenantId: string,
  patch: unknown,
): Promise<InfrastructureSettingsDto> {
  const parsed = patchSchema.parse(patch);

  const cur = await client.query<{ settings: unknown }>(
    `SELECT COALESCE(settings, '{}'::jsonb) AS settings FROM tenants WHERE id = $1::uuid FOR UPDATE`,
    [tenantId],
  );
  const row = cur.rows[0];
  if (!row) throw new Error("BAD_REQUEST:Tenant not found");

  const base =
    typeof row.settings === "object" && row.settings !== null && !Array.isArray(row.settings)
      ? (row.settings as Record<string, unknown>)
      : {};

  const next = deepMerge(base, parsed as Record<string, unknown>);

  await client.query(`UPDATE tenants SET settings = $1::jsonb WHERE id = $2::uuid`, [
    JSON.stringify(next),
    tenantId,
  ]);

  const lsNext = (next.integrations as Record<string, unknown> | undefined)?.lightspeed as
    | Record<string, unknown>
    | undefined;
  if (lsNext && typeof lsNext === "object") {
    await upsertInfrastructureSettingsRow(client, tenantId, {
      client_id: lsNext.client_id != null ? String(lsNext.client_id) : "",
      account_id: lsNext.account_id != null ? String(lsNext.account_id) : "",
      domain_prefix: lsNext.domain_prefix != null ? String(lsNext.domain_prefix) : "",
    });
  }

  return getInfrastructureSettings(client, tenantId);
}
