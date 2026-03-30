import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { findAuditBlockedEpc } from "@/lib/server/status-label-enforcement";

const epcHex24 = z
  .string()
  .transform((s) => normalizeEpc(s))
  .refine((s) => /^[0-9A-F]{24}$/.test(s), "Invalid 24-char hex EPC");

function normalizeEpc(s: string): string {
  return s.replace(/\s/g, "").toUpperCase();
}

export type CycleCountExpectedRow = {
  epc: string;
  sku: string;
  ls_system_id: string;
  upc: string;
  description: string;
  bin_id: string | null;
  bin_code: string | null;
  status: string;
};

export const cycleCountCommitSchema = z.object({
  locationId: z.string().uuid(),
  binId: z.string().uuid().nullable().optional(),
  matched: z.array(epcHex24).default([]),
  missing: z.array(epcHex24).default([]),
  misplaced: z.array(epcHex24).default([]),
  unrecognized: z.array(epcHex24).default([]),
});

export type CycleCountCommitBody = z.infer<typeof cycleCountCommitSchema>;

export type SessionPayload = {
  sub: string;
  tid: string;
  lid: string;
};

/** Verify location belongs to tenant. */
export async function assertLocationInTenant(
  client: Pool | PoolClient,
  tenantId: string,
  locationId: string,
): Promise<{ code: string; name: string }> {
  const r = await client.query<{ code: string; name: string }>(
    `SELECT code, name FROM locations
     WHERE id = $1::uuid AND tenant_id = $2::uuid
     LIMIT 1`,
    [locationId, tenantId],
  );
  const row = r.rows[0];
  if (!row) throw new Error("BAD_REQUEST:Location not found for tenant");
  return row;
}

export async function assertBinInLocation(
  client: Pool | PoolClient,
  locationId: string,
  binId: string,
): Promise<{ code: string }> {
  const r = await client.query<{ code: string }>(
    `SELECT code FROM bins WHERE id = $1::uuid AND location_id = $2::uuid LIMIT 1`,
    [binId, locationId],
  );
  const row = r.rows[0];
  if (!row) throw new Error("BAD_REQUEST:Bin not in this location");
  return row;
}

/**
 * In-stock items at location, optionally restricted to a bin (full-location vs bin-level count).
 */
export async function listExpectedCycleCountItems(
  pool: Pool,
  tenantId: string,
  locationId: string,
  binId: string | null,
): Promise<CycleCountExpectedRow[]> {
  await assertLocationInTenant(pool, tenantId, locationId);
  if (binId) {
    await assertBinInLocation(pool, locationId, binId);
  }

  const r = await pool.query<{
    epc: string;
    sku: string;
    ls_system_id: string;
    upc: string;
    description: string;
    bin_id: string | null;
    bin_code: string | null;
    status: string;
  }>(
    `SELECT
       i.epc,
       cs.sku,
       cs.ls_system_id::text AS ls_system_id,
       m.upc,
       m.description,
       i.bin_id::text AS bin_id,
       b.code AS bin_code,
       i.status
     FROM items i
     INNER JOIN locations loc ON loc.id = i.location_id AND loc.tenant_id = $1::uuid
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     INNER JOIN matrices m ON m.id = cs.matrix_id
     LEFT JOIN bins b ON b.id = i.bin_id
     WHERE i.location_id = $2::uuid
       AND i.status = 'in-stock'
       AND ($3::uuid IS NULL OR i.bin_id = $3::uuid)
     ORDER BY cs.sku ASC, i.epc ASC`,
    [tenantId, locationId, binId],
  );

  return r.rows.map((row) => ({
    epc: normalizeEpc(row.epc),
    sku: row.sku,
    ls_system_id: row.ls_system_id,
    upc: row.upc,
    description: row.description,
    bin_id: row.bin_id,
    bin_code: row.bin_code,
    status: row.status,
  }));
}

export type CycleCountCommitResult = {
  updated_missing: number;
  updated_misplaced: number;
  audit_id: string;
};

/**
 * Transaction: mark missing as UNKNOWN, move misplaced into target bin, audit.
 */
export async function commitCycleCount(
  client: PoolClient,
  session: SessionPayload,
  body: CycleCountCommitBody,
): Promise<CycleCountCommitResult> {
  const parsed = cycleCountCommitSchema.parse(body);
  const {
    locationId,
    binId: bodyBinId,
    missing,
    misplaced,
    matched: _matched,
    unrecognized: _unrecognized,
  } = parsed;

  const loc = await assertLocationInTenant(client, session.tid, locationId);
  let binCode: string | null = null;
  if (bodyBinId) {
    const b = await assertBinInLocation(client, locationId, bodyBinId);
    binCode = b.code;
  }

  if (misplaced.length > 0 && !bodyBinId) {
    throw new Error("BAD_REQUEST:binId is required when committing misplaced EPCs");
  }

  const missingSet = [...new Set(missing.map(normalizeEpc))];
  const misplacedSet = [...new Set(misplaced.map(normalizeEpc))];

  if (missingSet.some((e) => misplacedSet.includes(e))) {
    throw new Error("BAD_REQUEST:EPC cannot appear in both missing and misplaced");
  }

  const auditEpcs = [...new Set([...missingSet, ...misplacedSet])];
  const blocked = await findAuditBlockedEpc(client, session.tid, auditEpcs);
  if (blocked) {
    throw new Error(`BAD_REQUEST:Item ${blocked} cannot be processed in its current status.`);
  }

  let updatedMissing = 0;
  for (const epc of missingSet) {
    const u = await client.query(
      `UPDATE items i
       SET status = 'UNKNOWN'
       FROM locations loc
       WHERE i.epc = $1
         AND i.location_id = loc.id
         AND loc.tenant_id = $2::uuid
         AND i.location_id = $3::uuid
         AND i.status = 'in-stock'
         AND ($4::uuid IS NULL OR i.bin_id = $4::uuid)`,
      [epc, session.tid, locationId, bodyBinId],
    );
    updatedMissing += u.rowCount ?? 0;
  }

  let updatedMisplaced = 0;
  for (const epc of misplacedSet) {
    const u = await client.query(
      `UPDATE items i
       SET bin_id = $1::uuid,
           location_id = $2::uuid,
           status = 'in-stock'
       FROM locations loc
       WHERE i.epc = $3
         AND i.location_id = loc.id
         AND loc.tenant_id = $4::uuid
         AND i.status = 'in-stock'
         AND (i.location_id <> $2::uuid OR i.bin_id IS DISTINCT FROM $1::uuid)`,
      [bodyBinId, locationId, epc, session.tid],
    );
    updatedMisplaced += u.rowCount ?? 0;
  }

  const meta = {
    user_id: session.sub,
    location_id: locationId,
    location_code: loc.code,
    location_name: loc.name,
    bin_id: bodyBinId ?? null,
    bin_code: binCode,
    variance: {
      matched: parsed.matched.length,
      missing: missingSet.length,
      misplaced: misplacedSet.length,
      unrecognized: parsed.unrecognized.length,
    },
    epcs: {
      matched: parsed.matched.map(normalizeEpc),
      missing: missingSet,
      misplaced: misplacedSet,
      unrecognized: parsed.unrecognized.map(normalizeEpc),
    },
  };

  const ins = await client.query<{ id: string }>(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
     VALUES ($1::uuid, $2::uuid, 'rfid_cycle_count', 'items', $3::jsonb)
     RETURNING id::text`,
    [session.tid, session.sub, JSON.stringify(meta)],
  );

  return {
    updated_missing: updatedMissing,
    updated_misplaced: updatedMisplaced,
    audit_id: ins.rows[0]?.id ?? "",
  };
}

/** In-stock EPCs outside the count scope (for UI simulation of misplaced reads). */
export async function listSimMisplaceEpcs(
  pool: Pool,
  tenantId: string,
  locationId: string,
  binId: string | null,
  limit: number,
): Promise<string[]> {
  await assertLocationInTenant(pool, tenantId, locationId);
  if (binId) await assertBinInLocation(pool, locationId, binId);

  const r = await pool.query<{ epc: string }>(
    `SELECT i.epc
     FROM items i
     INNER JOIN locations loc ON loc.id = i.location_id AND loc.tenant_id = $1::uuid
     WHERE i.status = 'in-stock'
       AND NOT (
         i.location_id = $2::uuid
         AND ($3::uuid IS NULL OR i.bin_id = $3::uuid)
       )
     ORDER BY random()
     LIMIT $4`,
    [tenantId, locationId, binId, limit],
  );
  return r.rows.map((row) => normalizeEpc(row.epc));
}
