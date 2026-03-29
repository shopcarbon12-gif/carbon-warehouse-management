import type { Pool, PoolClient } from "pg";
import { z } from "zod";

function normalizeEpc(s: string): string {
  return s.replace(/\s/g, "").toUpperCase();
}

const epcHex24 = z
  .string()
  .transform((s) => normalizeEpc(s))
  .refine((s) => /^[0-9A-F]{24}$/.test(s), "Invalid 24-char hex EPC");

export const transferCommitSchema = z.object({
  destinationLocationId: z.string().uuid(),
  destinationBinId: z.string().uuid(),
  epcs: z
    .array(epcHex24)
    .max(500)
    .transform((a) => [...new Set(a)])
    .refine((a) => a.length >= 1, { message: "At least one EPC required" }),
});

export type TransferCommitBody = z.infer<typeof transferCommitSchema>;

export type SessionPayload = {
  sub: string;
  tid: string;
  lid: string;
};

export type TransferLookupRow = {
  epc: string;
  sku: string;
  location_id: string;
  location_code: string;
  bin_id: string | null;
  bin_code: string | null;
  status: string;
};

export async function lookupTransferEpcs(
  pool: Pool,
  tenantId: string,
  epcs: string[],
): Promise<TransferLookupRow[]> {
  const norm = [...new Set(epcs.map(normalizeEpc))].filter((e) =>
    /^[0-9A-F]{24}$/.test(e),
  );
  if (norm.length === 0) return [];

  const r = await pool.query<{
    epc: string;
    sku: string;
    location_id: string;
    location_code: string;
    bin_id: string | null;
    bin_code: string | null;
    status: string;
  }>(
    `SELECT
       i.epc,
       cs.sku,
       i.location_id::text,
       l.code AS location_code,
       i.bin_id::text AS bin_id,
       b.code AS bin_code,
       i.status
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     LEFT JOIN bins b ON b.id = i.bin_id
     WHERE i.epc = ANY($2::text[])`,
    [tenantId, norm],
  );

  return r.rows.map((row) => ({
    epc: normalizeEpc(row.epc),
    sku: row.sku,
    location_id: row.location_id,
    location_code: row.location_code,
    bin_id: row.bin_id,
    bin_code: row.bin_code,
    status: row.status,
  }));
}

export async function listSimTransferEpcs(
  pool: Pool,
  tenantId: string,
  locationId: string,
  limit: number,
): Promise<TransferLookupRow[]> {
  const r = await pool.query<{
    epc: string;
    sku: string;
    location_id: string;
    location_code: string;
    bin_id: string | null;
    bin_code: string | null;
    status: string;
  }>(
    `SELECT
       i.epc,
       cs.sku,
       i.location_id::text,
       l.code AS location_code,
       i.bin_id::text AS bin_id,
       b.code AS bin_code,
       i.status
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     LEFT JOIN bins b ON b.id = i.bin_id
     WHERE i.location_id = $2::uuid
       AND i.status = 'in-stock'
     ORDER BY random()
     LIMIT $3`,
    [tenantId, locationId, limit],
  );
  return r.rows.map((row) => ({
    epc: normalizeEpc(row.epc),
    sku: row.sku,
    location_id: row.location_id,
    location_code: row.location_code,
    bin_id: row.bin_id,
    bin_code: row.bin_code,
    status: row.status,
  }));
}

export type TransferCommitResult = {
  moved: number;
  audit_id: string;
};

export async function commitTransfer(
  client: PoolClient,
  session: SessionPayload,
  body: TransferCommitBody,
): Promise<TransferCommitResult> {
  const { destinationLocationId, destinationBinId, epcs } = body;

  const destLoc = await client.query<{ id: string; code: string; name: string }>(
    `SELECT id::text, code, name FROM locations
     WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [destinationLocationId, session.tid],
  );
  const dl = destLoc.rows[0];
  if (!dl) throw new Error("BAD_REQUEST:Destination location not found");

  const destBin = await client.query<{ id: string; code: string }>(
    `SELECT id::text, code FROM bins
     WHERE id = $1::uuid AND location_id = $2::uuid LIMIT 1`,
    [destinationBinId, destinationLocationId],
  );
  const db = destBin.rows[0];
  if (!db) throw new Error("BAD_REQUEST:Destination bin not in destination location");

  const rows = await client.query<{
    epc: string;
    sku: string;
    location_id: string;
    location_code: string;
  }>(
    `SELECT i.epc, cs.sku, i.location_id::text, loc.code AS location_code
     FROM items i
     INNER JOIN locations loc ON loc.id = i.location_id AND loc.tenant_id = $1::uuid
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     WHERE i.epc = ANY($2::text[])`,
    [session.tid, epcs],
  );

  if (rows.rows.length !== epcs.length) {
    throw new Error("BAD_REQUEST:One or more EPCs were not found in this tenant");
  }

  const byLoc = new Map<string, { code: string; epcs: string[] }>();
  for (const row of rows.rows) {
    const k = row.location_id;
    if (!byLoc.has(k)) {
      byLoc.set(k, { code: row.location_code, epcs: [] });
    }
    byLoc.get(k)!.epcs.push(normalizeEpc(row.epc));
  }

  const locEntries = [...byLoc.entries()];
  const primarySource =
    locEntries.length === 1
      ? { id: locEntries[0]![0], code: locEntries[0]![1].code }
      : { id: "", code: "MIXED" };

  const skuSummary: Record<string, number> = {};
  for (const row of rows.rows) {
    skuSummary[row.sku] = (skuSummary[row.sku] ?? 0) + 1;
  }

  const upd = await client.query(
    `UPDATE items i
     SET
       location_id = $1::uuid,
       bin_id = $2::uuid,
       status = 'in-stock'
     FROM locations loc
     WHERE i.epc = ANY($3::text[])
       AND i.location_id = loc.id
       AND loc.tenant_id = $4::uuid`,
    [destinationLocationId, destinationBinId, epcs, session.tid],
  );

  const meta = {
    source_location: primarySource,
    source_breakdown:
      locEntries.length > 1
        ? locEntries.map(([id, v]) => ({
            location_id: id,
            location_code: v.code,
            epcs: v.epcs,
          }))
        : undefined,
    destination_location: {
      id: dl.id,
      code: dl.code,
      name: dl.name,
    },
    destination_bin: { id: db.id, code: db.code },
    epcs,
    sku_summary: skuSummary,
    moved_count: epcs.length,
  };

  const ins = await client.query<{ id: string }>(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
     VALUES ($1::uuid, $2::uuid, 'rfid_transfer', 'items', $3::jsonb)
     RETURNING id::text`,
    [session.tid, session.sub, JSON.stringify(meta)],
  );

  return {
    moved: upd.rowCount ?? 0,
    audit_id: ins.rows[0]?.id ?? "",
  };
}
