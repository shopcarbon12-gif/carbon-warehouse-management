import type { Pool, PoolClient } from "pg";
import { z } from "zod";

/**
 * Auto-IP-tracking + WIZnet discovery for the Carbon CDM agent.
 *
 * Flow:
 *   1. Agent runs `wiznet-cli -d` every 1 minute; parses each row into
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

  // Janitor: physically purge cdm_agent_discoveries rows for this agent
  // whose bridges have been off the LAN longer than the panel staleness
  // window. The list query already filters them out by last_seen_at, but
  // the row is reused via UPSERT when the bridge eventually reappears,
  // which carries forward stale metadata. Operators who unplug a bridge
  // expect the system to truly forget it — so on each sweep, remove any
  // row that's effectively dead. Adopted and ignored rows are kept since
  // their state was set deliberately by an operator action.
  await client.query(
    `DELETE FROM cdm_agent_discoveries
       WHERE cdm_agent_id = $1::uuid
         AND adopted_at IS NULL
         AND ignored_at IS NULL
         AND last_seen_at < now() - interval '3 minutes'`,
    [agentId],
  );

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
      // The bridge is now bound to a device — clear any pending discovery
      // row for this MAC so it leaves the operator's "Discovered WIZnet
      // bridges" panel immediately, instead of lingering for 24h until the
      // last_seen_at age filter drops it.
      await client.query(
        `UPDATE cdm_agent_discoveries
            SET adopted_at = now()
          WHERE cdm_agent_id = $1::uuid
            AND lower(mac_address) = $2
            AND adopted_at IS NULL`,
        [agentId, macLower],
      );
      continue;
    }

    // Step 1.5: no MAC match — fall back to matching by IP+agent. The
    // operator's expected workflow is to add a reader by IP only and let
    // the agent fill in the MAC ("the agent already knows what's at .16").
    // For any device on this agent at the discovered IP that has a NULL
    // mac_address, auto-bind the discovered MAC to it. Once bound, the
    // normal MAC-based path handles auto-IP-tracking + auto-clear on
    // every subsequent sweep.
    const byIp = await client.query<{ id: string }>(
      `SELECT d.id::text
         FROM devices d
         INNER JOIN cdm_agents a ON a.id = d.cdm_agent_id
         WHERE d.network_address = $1
           AND d.mac_address IS NULL
           AND a.tenant_id = $2::uuid
           AND a.id = $3::uuid
           AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
         LIMIT 1`,
      [d.ip, tenantId, agentId],
    );
    if (byIp.rowCount && byIp.rows[0]) {
      const deviceId = byIp.rows[0].id;
      await client.query(
        `UPDATE devices
            SET mac_address = $1, updated_at = now()
          WHERE id = $2::uuid`,
        [macLower, deviceId],
      );
      await client.query(
        `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
           VALUES ($1::uuid, NULL, 'cdm_agent_auto_mac_bind', 'devices', $2::jsonb)`,
        [
          tenantId,
          JSON.stringify({
            device_id: deviceId,
            ip: d.ip,
            mac: macLower,
            source: "wiznet_discovery",
          }),
        ],
      );
      // Mark any pending discovery for this MAC as adopted so the row
      // leaves the panel on the next list query (60s SWR window).
      await client.query(
        `UPDATE cdm_agent_discoveries
            SET adopted_at = now()
          WHERE cdm_agent_id = $1::uuid
            AND lower(mac_address) = $2
            AND adopted_at IS NULL`,
        [agentId, macLower],
      );
      matchedKnown += 1;
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
             -- Reaching this branch means no device currently owns this MAC
             -- (matched_known / IP-fallback paths handle the bound case). If
             -- a previous adoption was undone by deleting the device, the row
             -- still has adopted_at set from then; clear it so the bridge
             -- reappears in the discovered panel as a new device. Also
             -- reset first_seen_at on re-emergence (operator deleted the
             -- device, then bridge reappears) so the panel timestamps look
             -- like a genuine fresh discovery rather than a zombie row.
             -- For rows that have been continuously pending (never adopted),
             -- preserve the original first_seen_at.
             adopted_at = NULL,
             -- Treat the bridge as a genuine fresh discovery whenever there
             -- was a "gap" between observations: either the row was bound
             -- to a now-deleted device (adopted_at was set), or the bridge
             -- was off the LAN long enough to have aged out of the panel
             -- (last_seen_at older than the staleness window — same 3 min
             -- as the listPending... query). Otherwise (continuously
             -- pending), keep the original first_seen_at.
             first_seen_at = CASE
               WHEN cdm_agent_discoveries.adopted_at IS NOT NULL THEN now()
               WHEN cdm_agent_discoveries.last_seen_at < now() - interval '3 minutes' THEN now()
               ELSE cdm_agent_discoveries.first_seen_at
             END,
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
       -- Live-only window: agent sweeps every 1 min, so a row whose
       -- last_seen_at is older than 3 min means the bridge missed at
       -- least 2 sweeps — i.e. disconnected. Drop it from the panel so
       -- the operator sees the actual current state. Tolerance is 3×
       -- sweep interval so brief network/agent hiccups won't flap a
       -- still-online bridge off the panel.
       AND wd.last_seen_at > now() - interval '3 minutes'
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
