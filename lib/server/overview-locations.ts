import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { listBinsWithCounts } from "@/lib/queries/locations";
import {
  applyBinPlan,
  canonicalBinCode,
  clearHomeBin,
  liveBinsOf,
  lockItems,
  planRemove,
  publicChanges,
  type BinActor,
  type BinChange,
} from "@/lib/server/bin-engine";

export type LocationWithBinsRow = {
  id: string;
  code: string;
  name: string;
  bins: {
    id: string;
    code: string;
    capacity: number | null;
    in_stock_count: number;
    status: string;
    bin_items: string | null;
  }[];
};

export async function listTenantLocationsWithBins(
  pool: Pool,
  tenantId: string,
): Promise<LocationWithBinsRow[]> {
  const locs = await pool.query<{ id: string; code: string; name: string }>(
    `SELECT id::text, code, name FROM locations
     WHERE tenant_id = $1::uuid
     ORDER BY code ASC`,
    [tenantId],
  );

  const out: LocationWithBinsRow[] = [];
  for (const l of locs.rows) {
    const bins = await listBinsWithCounts(pool, l.id);
    out.push({
      id: l.id,
      code: l.code,
      name: l.name,
      bins: bins.map((b) => ({
        id: b.id,
        code: b.code,
        capacity: b.capacity,
        in_stock_count: b.in_stock_count,
        status: b.status,
        bin_items: b.bin_items,
      })),
    });
  }
  return out;
}

export const upsertBinSchema = z.object({
  // Optional: when omitted, the POST route defaults it to the caller's active
  // session location (session.lid). The handheld omits it so a bin is always
  // created at the operator's CURRENT location — fixes create→delete/clean 404
  // where the mobile previously sent locations[0] (often the wrong location).
  locationId: z.string().uuid().optional(),
  binId: z.string().uuid().optional(),
  code: z.string().trim().min(1).max(64),
  capacity: z.coerce.number().int().min(0).max(1_000_000).nullable().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export type UpsertBinBody = z.infer<typeof upsertBinSchema>;

export async function assertLocationTenant(
  client: Pool | PoolClient,
  locationId: string,
  tenantId: string,
): Promise<void> {
  const r = await client.query(
    `SELECT 1 FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [locationId, tenantId],
  );
  if (!r.rows[0]) throw new Error("BAD_REQUEST:Location not found");
}

export async function upsertBin(
  client: PoolClient,
  tenantId: string,
  body: UpsertBinBody,
): Promise<{ id: string }> {
  const parsed = upsertBinSchema.parse(body);
  // locationId is optional on the schema (the handheld omits it and the POST
  // route fills in the active session location); by the time it reaches here it
  // must be resolved.
  const locationId = parsed.locationId;
  if (!locationId) throw new Error("BAD_REQUEST:locationId is required");
  await assertLocationTenant(client, locationId, tenantId);

  // One spelling per bin: the handheld sent its display form "2-B-03-L" when
  // creating, so "2B03L" and "2-B-03-L" could both exist and the handheld's
  // normalised lookups picked either one.
  const code = canonicalBinCode(parsed.code);
  if (!code) throw new Error("BAD_REQUEST:Bin code is required");
  const dup = await client.query(
    `SELECT 1 FROM bins
      WHERE location_id = $1::uuid
        AND archived_at IS NULL
        AND regexp_replace(upper(code), '[^A-Z0-9]', '', 'g') = regexp_replace(upper($2), '[^A-Z0-9]', '', 'g')
        AND ($3::uuid IS NULL OR id <> $3::uuid)
      LIMIT 1`,
    [locationId, code, parsed.binId ?? null],
  );
  if (dup.rows[0]) throw new Error(`BAD_REQUEST:Bin ${code} already exists`);

  if (parsed.binId) {
    // Fields the caller didn't send keep their value: the Shelf Map's
    // active/inactive toggle sends no capacity and used to wipe it (and an
    // edit without a status reset the bin to active).
    const u = await client.query<{ id: string }>(
      `UPDATE bins b
       SET code = $1,
           capacity = CASE WHEN $5::boolean THEN $2::int ELSE b.capacity END,
           status = COALESCE($6, b.status)
       FROM locations l
       WHERE b.id = $3::uuid
         AND b.location_id = l.id
         AND l.tenant_id = $4::uuid
         AND b.archived_at IS NULL
       RETURNING b.id::text`,
      [code, parsed.capacity ?? null, parsed.binId, tenantId, parsed.capacity !== undefined, parsed.status ?? null],
    );
    if (!u.rows[0]) throw new Error("BAD_REQUEST:Bin not found or archived");
    return { id: u.rows[0].id };
  }

  const ins = await client.query<{ id: string }>(
    `INSERT INTO bins (location_id, code, capacity, status)
     VALUES ($1::uuid, $2, $3, $4)
     RETURNING id::text`,
    [locationId, code, parsed.capacity ?? null, parsed.status ?? "active"],
  );
  const id = ins.rows[0]?.id;
  if (!id) throw new Error("SERVER:Insert failed");
  return { id };
}

/**
 * Delete a bin (shared bin engine, same rule as Clean): every tag that lists
 * the bin loses it — a tag whose primary bin it was gets its first live extra
 * bin promoted — with history per tag and the user / handheld. The bin also
 * stops being anyone's home bin and store pin. Then the bin is soft-archived;
 * its code gets `·arch·<rand>` so the same code can be created again.
 * Returns before → after per EPC; Undo replays it after restoreDeletedBin.
 */
export async function deleteBin(
  client: PoolClient,
  tenantId: string,
  binId: string,
  actor: BinActor = { userId: null, deviceId: null },
): Promise<{ orphaned: number; changes: BinChange[]; binCode: string }> {
  const bin = await client.query<{ code: string; location_id: string }>(
    `SELECT b.code, b.location_id::text
       FROM bins b
       INNER JOIN locations l ON l.id = b.location_id
      WHERE b.id = $1::uuid
        AND l.tenant_id = $2::uuid
        AND b.archived_at IS NULL
      LIMIT 1`,
    [binId, tenantId],
  );
  const row = bin.rows[0];
  if (!row) {
    throw new Error("BAD_REQUEST:Bin not found or already archived");
  }

  const rows = await lockItems(client, `(i.bin_id = $1::uuid OR $1::uuid = ANY(i.additional_bin_ids))`, [binId]);
  const live = await liveBinsOf(client, row.location_id);
  live.delete(binId);
  const changes = await applyBinPlan(client, tenantId, rows, planRemove(binId, live), actor);
  await clearHomeBin(client, binId, "all");
  await client.query(`UPDATE items SET pinned_bin_id = NULL WHERE pinned_bin_id = $1::uuid`, [binId]);

  const u = await client.query(
    `UPDATE bins b
     SET archived_at = now(),
         code = b.code || '·arch·' || substr(md5(random()::text), 1, 6)
     FROM locations l
     WHERE b.id = $1::uuid
       AND b.location_id = l.id
       AND l.tenant_id = $2::uuid
       AND b.archived_at IS NULL`,
    [binId, tenantId],
  );
  if ((u.rowCount ?? 0) === 0) {
    throw new Error("BAD_REQUEST:Bin not found or already archived");
  }
  return { orphaned: changes.length, changes: publicChanges(changes), binCode: row.code };
}

/**
 * Undo of a delete: brings the archived bin back under its old code (same
 * id, so the tags' before-state still points at it). Refused when a bin with
 * that code has been created again since.
 */
export async function restoreDeletedBin(
  client: PoolClient,
  tenantId: string,
  locationId: string,
  binId: string,
): Promise<{ code: string }> {
  const r = await client.query<{ code: string; archived: boolean }>(
    `SELECT b.code, b.archived_at IS NOT NULL AS archived
       FROM bins b
       JOIN locations l ON l.id = b.location_id
      WHERE b.id = $1::uuid AND b.location_id = $2::uuid AND l.tenant_id = $3::uuid
      LIMIT 1
      FOR UPDATE OF b`,
    [binId, locationId, tenantId],
  );
  const row = r.rows[0];
  if (!row) throw new Error("BAD_REQUEST:Bin not found");
  if (!row.archived) return { code: row.code };
  const code = row.code.split("·arch·")[0];
  const dup = await client.query(
    `SELECT 1 FROM bins
      WHERE location_id = $1::uuid AND archived_at IS NULL
        AND regexp_replace(upper(code), '[^A-Z0-9]', '', 'g') = regexp_replace(upper($2), '[^A-Z0-9]', '', 'g')
      LIMIT 1`,
    [locationId, code],
  );
  if (dup.rows[0]) throw new Error(`BAD_REQUEST:Bin ${code} was created again — undo not possible`);
  await client.query(`UPDATE bins SET archived_at = NULL, code = $2 WHERE id = $1::uuid`, [binId, code]);
  return { code };
}

/** @deprecated retained for legacy callers — forwards to deleteBin which
 *  no longer blocks on in-stock items. */
export async function archiveBin(
  client: PoolClient,
  tenantId: string,
  binId: string,
): Promise<void> {
  await deleteBin(client, tenantId, binId);
}
