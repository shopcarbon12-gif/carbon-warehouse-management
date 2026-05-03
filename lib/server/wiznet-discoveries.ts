import type { Pool, PoolClient } from "pg";
import { z } from "zod";

/**
 * Auto-IP-tracking + WIZnet discovery for the Carbon CDM agent.
 *
 * Flow:
 *   1. Agent runs `wiznet-cli -d` every 5 minutes; parses each row into
 *      `{ mac, ip, port, dhcp, ... }` and POSTs the full list here.
 *   2. For every discovered MAC, we look up `devices.mac_address`:
 *       - HIT  → if `devices.network_address` differs from the discovered
 *                IP, we auto-update it. The agent's next config poll picks
 *                up the new IP transparently. THIS IS WHAT MAKES NIGHTLY
 *                POWER-CYCLES SAFE — even if DHCP shuffles the lease, the
 *                WMS finds the reader by MAC and follows it to the new IP.
 *       - MISS → upsert into `cdm_agent_discoveries` so an admin can
 *                adopt it from the hardware-config UI.
 *   3. Discoveries that haven't been seen in 24 hours fade out of the
 *      "pending" view (we still keep the row for audit).
 */

export const wiznetDiscoverySchema = z.object({
  discoveries: z
    .array(
      z.object({
        mac: z.string().regex(/^[0-9A-Fa-f]{12}$/),
        ip: z
          .string()
          .regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/),
        port: z.coerce.number().int().min(1).max(65535).default(10002),
        dhcp: z.boolean().optional(),
        raw: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(64),
});

export type WiznetDiscoveryBody = z.infer<typeof wiznetDiscoverySchema>;

export type WiznetSyncResult = {
  matched_known: number;
  ip_updated: number;
  new_discoveries: number;
};

export async function ingestWiznetDiscoveries(
  client: PoolClient,
  agentId: string,
  tenantId: string,
  body: WiznetDiscoveryBody,
): Promise<WiznetSyncResult> {
  let matchedKnown = 0;
  let ipUpdated = 0;
  let newDiscoveries = 0;

  for (const d of body.discoveries) {
    const macLower = d.mac.toLowerCase();

    // Step 1: known device? Match by mac_address (case-insensitive).
    const known = await client.query<{ id: string; network_address: string | null }>(
      `SELECT d.id::text, d.network_address
         FROM devices d
         INNER JOIN cdm_agents a ON a.id = d.cdm_agent_id
         WHERE lower(d.mac_address) = $1
           AND a.tenant_id = $2::uuid
         LIMIT 1`,
      [macLower, tenantId],
    );

    if (known.rowCount && known.rows[0]) {
      matchedKnown += 1;
      const row = known.rows[0];
      if (row.network_address !== d.ip) {
        await client.query(
          `UPDATE devices SET network_address = $1, updated_at = now() WHERE id = $2::uuid`,
          [d.ip, row.id],
        );
        ipUpdated += 1;
        await client.query(
          `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
             VALUES ($1::uuid, NULL, 'cdm_agent_auto_ip_update', 'devices', $2::jsonb)`,
          [
            tenantId,
            JSON.stringify({
              device_id: row.id,
              mac: macLower,
              old_ip: row.network_address,
              new_ip: d.ip,
              source: "wiznet_discovery",
            }),
          ],
        );
      }
      continue;
    }

    // Step 2: unknown — upsert into cdm_agent_discoveries.
    const upsert = await client.query<{ inserted: boolean }>(
      `INSERT INTO cdm_agent_discoveries
         (cdm_agent_id, mac_address, current_ip, port, dhcp_enabled, raw, first_seen_at, last_seen_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, now(), now())
       ON CONFLICT (cdm_agent_id, lower(mac_address)) DO UPDATE
         SET current_ip = EXCLUDED.current_ip,
             port = EXCLUDED.port,
             dhcp_enabled = EXCLUDED.dhcp_enabled,
             raw = EXCLUDED.raw,
             last_seen_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        agentId,
        macLower,
        d.ip,
        d.port,
        d.dhcp ?? null,
        JSON.stringify(d.raw ?? {}),
      ],
    );
    if (upsert.rows[0]?.inserted) newDiscoveries += 1;
  }

  return {
    matched_known: matchedKnown,
    ip_updated: ipUpdated,
    new_discoveries: newDiscoveries,
  };
}

export type DiscoveryRow = {
  id: string;
  cdm_agent_id: string;
  cdm_agent_name: string;
  mac_address: string;
  current_ip: string;
  port: number;
  dhcp_enabled: boolean | null;
  first_seen_at: string;
  last_seen_at: string;
  age_seconds: number | null;
};

export async function listPendingWiznetDiscoveries(
  pool: Pool,
  tenantId: string,
): Promise<DiscoveryRow[]> {
  const r = await pool.query<DiscoveryRow & { last_seen_iso: string }>(
    `SELECT
       wd.id::text,
       wd.cdm_agent_id::text,
       a.name AS cdm_agent_name,
       wd.mac_address,
       wd.current_ip,
       wd.port,
       wd.dhcp_enabled,
       wd.first_seen_at::text,
       wd.last_seen_at::text,
       wd.last_seen_at::text AS last_seen_iso,
       EXTRACT(EPOCH FROM (now() - wd.last_seen_at))::int AS age_seconds
     FROM cdm_agent_discoveries wd
     INNER JOIN cdm_agents a ON a.id = wd.cdm_agent_id
     WHERE a.tenant_id = $1::uuid
       AND wd.adopted_at IS NULL
       AND wd.ignored_at IS NULL
       AND wd.last_seen_at > now() - interval '24 hours'
     ORDER BY wd.last_seen_at DESC`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    cdm_agent_id: row.cdm_agent_id,
    cdm_agent_name: row.cdm_agent_name,
    mac_address: row.mac_address,
    current_ip: row.current_ip,
    port: row.port,
    dhcp_enabled: row.dhcp_enabled,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    age_seconds: row.age_seconds,
  }));
}
