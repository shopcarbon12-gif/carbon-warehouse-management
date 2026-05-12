import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  assertBinInLocation,
  assertLocationInTenant,
  commitCycleCount,
  cycleCountCommitSchema,
  listExpectedCycleCountItems,
  type CycleCountExpectedRow,
  type SessionPayload,
} from "./rfid-cycle-counts";
import { loadStatusLabelBrainMap } from "./status-label-enforcement";
import { labelNameForWmsStatus } from "./wms-status-to-label-name";

/**
 * Persistent state for the cycle count workflow.
 *
 * A session captures the *expected* in-stock snapshot at the moment it was
 * created (frozen) plus the running list of *scanned* EPCs. Operators can
 * pause/resume across hours or days, and historical sessions are queryable
 * for audit.
 *
 * Variance buckets (matched/missing/misplaced/unrecognized) are derived
 * client-side from `expected_snapshot` ⊕ `scanned_epcs`, then sent to the
 * existing `commitCycleCount(...)` path on commit. This keeps the
 * inventory-mutation logic in one place — no duplication.
 */

export const sessionStatuses = ["active", "paused", "committed", "canceled"] as const;
export type SessionStatus = (typeof sessionStatuses)[number];

const epcArray = z
  .array(z.string().transform((s) => s.replace(/\s/g, "").toUpperCase()))
  .max(500_000);

export const createSessionSchema = z.object({
  locationId: z.string().uuid(),
  binId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
  readerFilter: z.array(z.string().uuid()).max(64).optional(),
});

export const patchSessionSchema = z.object({
  status: z.enum(["active", "paused", "canceled"]).optional(),
  scannedEpcs: epcArray.optional(),
  appendEpcs: epcArray.optional(),
  notes: z.string().trim().max(2000).optional(),
  readerFilter: z.array(z.string().uuid()).max(64).optional(),
});

/** Live variance — buckets derived from current items state, not the snapshot. */
export type LiveScanRow = {
  epc: string;
  sku: string | null;
  description: string | null;
  upc: string | null;
  color: string | null;
  size: string | null;
  bin_id: string | null;
  bin_code: string | null;
  current_status: string;
  current_location_id: string | null;
  current_location_code: string | null;
};

export type LiveVariance = {
  matched: CycleCountExpectedRow[];
  missing: CycleCountExpectedRow[];
  added_here: LiveScanRow[];
  defective: LiveScanRow[];
  locked: LiveScanRow[];
};

export type CreateSessionBody = z.infer<typeof createSessionSchema>;
export type PatchSessionBody = z.infer<typeof patchSessionSchema>;

export type SessionRow = {
  id: string;
  /** Per-(tenant, location) monotonic session number. Stamped at INSERT, never reused. */
  session_number: number;
  tenant_id: string;
  location_id: string;
  location_code: string;
  location_name: string;
  bin_id: string | null;
  bin_code: string | null;
  name: string;
  status: SessionStatus;
  started_by: string | null;
  started_by_email: string | null;
  started_at: string;
  completed_at: string | null;
  scanned_count: number;
  expected_count: number;
  reader_filter: string[];
  notes: string | null;
  variance_summary: VarianceSummary | null;
  audit_log_id: string | null;
};

export type SessionDetail = SessionRow & {
  expected: CycleCountExpectedRow[];
  scanned_epcs: string[];
};

export type VarianceSummary = {
  matched: number;
  missing: number;
  misplaced: number;
  unrecognized: number;
};

const SESSION_COLUMNS = `
  s.id::text,
  s.session_number,
  s.tenant_id::text,
  s.location_id::text,
  loc.code AS location_code,
  loc.name AS location_name,
  s.bin_id::text,
  b.code AS bin_code,
  s.name,
  s.status,
  s.started_by::text,
  u.email AS started_by_email,
  s.started_at::text,
  s.completed_at::text,
  jsonb_array_length(s.scanned_epcs) AS scanned_count,
  jsonb_array_length(s.expected_snapshot) AS expected_count,
  s.reader_filter,
  s.notes,
  s.variance_summary,
  s.audit_log_id::text
`;

export async function createSession(
  client: PoolClient,
  session: SessionPayload,
  body: CreateSessionBody,
): Promise<SessionDetail> {
  await assertLocationInTenant(client, session.tid, body.locationId);
  let binCode: string | null = null;
  if (body.binId) {
    const b = await assertBinInLocation(client, body.locationId, body.binId);
    binCode = b.code;
  }

  // Block two open sessions on the same scope (matches the partial unique
  // index on `cycle_count_sessions`).
  const open = await client.query<{ id: string }>(
    `SELECT id::text FROM cycle_count_sessions
       WHERE tenant_id = $1::uuid
         AND location_id = $2::uuid
         AND COALESCE(bin_id, '00000000-0000-0000-0000-000000000000'::uuid)
             = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
         AND status IN ('active','paused')
       LIMIT 1`,
    [session.tid, body.locationId, body.binId ?? null],
  );
  if (open.rowCount && open.rows[0]) {
    throw new Error(
      `BAD_REQUEST:Another count is already open for this location${binCode ? `+bin (${binCode})` : ""}. Resume or close it first.`,
    );
  }

  // Snapshot expected items now — frozen baseline.
  const expected = await listExpectedCycleCountItems(
    client as unknown as Pool,
    session.tid,
    body.locationId,
    body.binId ?? null,
  );

  // Stamp session_number = MAX(session_number)+1 scoped to (tenant, location)
  // and use the zero-padded number as the session name ("001", "002", …).
  // Status defaults to 'paused' so readers don't auto-wake; operator clicks
  // Start to begin scanning.
  const ins = await client.query<{ id: string; session_number: number; name: string }>(
    `WITH next_num AS (
       SELECT COALESCE(MAX(session_number), 0) + 1 AS n
         FROM cycle_count_sessions
        WHERE tenant_id = $1::uuid AND location_id = $2::uuid
     )
     INSERT INTO cycle_count_sessions
       (tenant_id, location_id, bin_id, name, status, started_by,
        expected_snapshot, scanned_epcs, reader_filter, notes,
        session_number)
     SELECT $1::uuid, $2::uuid, $3::uuid,
            lpad(next_num.n::text, 3, '0'),
            'paused', $4::uuid,
            $5::jsonb, '[]'::jsonb, $6::jsonb, $7,
            next_num.n
       FROM next_num
     RETURNING id::text, session_number, name`,
    [
      session.tid,
      body.locationId,
      body.binId ?? null,
      session.sub,
      JSON.stringify(expected),
      JSON.stringify(body.readerFilter ?? []),
      body.notes ?? null,
    ],
  );

  const detail = await getSession(client, session.tid, ins.rows[0].id);
  if (!detail) throw new Error("INTERNAL:Created session not found");
  return detail;
}

export async function listSessions(
  pool: Pool | PoolClient,
  tenantId: string,
  filters: { status?: SessionStatus | "open" | "closed"; locationId?: string },
): Promise<SessionRow[]> {
  const conditions: string[] = [`s.tenant_id = $1::uuid`];
  const params: unknown[] = [tenantId];
  if (filters.status === "open") {
    conditions.push(`s.status IN ('active','paused')`);
  } else if (filters.status === "closed") {
    conditions.push(`s.status IN ('committed','canceled')`);
  } else if (filters.status) {
    params.push(filters.status);
    conditions.push(`s.status = $${params.length}`);
  }
  if (filters.locationId) {
    params.push(filters.locationId);
    conditions.push(`s.location_id = $${params.length}::uuid`);
  }

  const r = await pool.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS}
       FROM cycle_count_sessions s
       INNER JOIN locations loc ON loc.id = s.location_id
       LEFT JOIN bins b ON b.id = s.bin_id
       LEFT JOIN users u ON u.id = s.started_by
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.started_at DESC
       LIMIT 200`,
    params,
  );
  return r.rows;
}

export async function getSession(
  client: Pool | PoolClient,
  tenantId: string,
  id: string,
): Promise<SessionDetail | null> {
  const r = await client.query<
    SessionRow & { expected_snapshot: CycleCountExpectedRow[]; scanned_epcs: string[] }
  >(
    `SELECT ${SESSION_COLUMNS},
            s.expected_snapshot,
            s.scanned_epcs
       FROM cycle_count_sessions s
       INNER JOIN locations loc ON loc.id = s.location_id
       LEFT JOIN bins b ON b.id = s.bin_id
       LEFT JOIN users u ON u.id = s.started_by
       WHERE s.tenant_id = $1::uuid AND s.id = $2::uuid`,
    [tenantId, id],
  );
  const row = r.rows[0];
  if (!row) return null;
  const { expected_snapshot, scanned_epcs, ...summary } = row;
  return {
    ...summary,
    expected: expected_snapshot ?? [],
    scanned_epcs: scanned_epcs ?? [],
  };
}

export async function updateSession(
  client: PoolClient,
  tenantId: string,
  id: string,
  patch: PatchSessionBody,
): Promise<SessionDetail> {
  // Fetch first so we can validate transitions and merge appendEpcs.
  const cur = await getSession(client, tenantId, id);
  if (!cur) throw new Error("BAD_REQUEST:Session not found");

  if (cur.status === "committed" || cur.status === "canceled") {
    throw new Error("BAD_REQUEST:Session is closed and cannot be modified");
  }

  const sets: string[] = [];
  const params: unknown[] = [tenantId, id];

  if (patch.status) {
    if (patch.status === "active" || patch.status === "paused") {
      sets.push(`status = $${params.length + 1}`);
      params.push(patch.status);
    } else if (patch.status === "canceled") {
      sets.push(`status = 'canceled'`);
      sets.push(`completed_at = now()`);
    }
  }

  let nextScanned: string[] | null = null;
  if (patch.scannedEpcs) {
    nextScanned = dedupeEpcs(patch.scannedEpcs);
  } else if (patch.appendEpcs && patch.appendEpcs.length > 0) {
    nextScanned = dedupeEpcs([...cur.scanned_epcs, ...patch.appendEpcs]);
  }
  if (nextScanned !== null) {
    sets.push(`scanned_epcs = $${params.length + 1}::jsonb`);
    params.push(JSON.stringify(nextScanned));
  }

  if (patch.notes !== undefined) {
    sets.push(`notes = $${params.length + 1}`);
    params.push(patch.notes);
  }

  if (patch.readerFilter !== undefined) {
    sets.push(`reader_filter = $${params.length + 1}::jsonb`);
    params.push(JSON.stringify(patch.readerFilter));
  }

  if (sets.length === 0) {
    return cur;
  }

  await client.query(
    `UPDATE cycle_count_sessions SET ${sets.join(", ")}
       WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    params,
  );

  const updated = await getSession(client, tenantId, id);
  if (!updated) throw new Error("INTERNAL:Updated session not found");
  return updated;
}

function dedupeEpcs(epcs: string[]): string[] {
  return [...new Set(epcs.map((e) => e.replace(/\s/g, "").toUpperCase()))];
}

/**
 * Live variance — buckets are derived from current items state at the moment
 * of the call, NOT from a queued/staged list waiting for commit. Cycle-count
 * scans now mutate inventory in real time (see ingestCycleCountEpcs), so:
 *   - matched   : scanned ∩ expected snapshot
 *   - missing   : expected − scanned (still applied to tag_killed on commit)
 *   - added_here: scanned − expected, currently in-stock at this location
 *   - defective : scanned − expected, currently tag_killed (formula failed)
 *   - locked    : scanned − expected, currently super_admin_locked (untouched)
 */
export async function classifyVarianceLive(
  client: PoolClient,
  tenantId: string,
  expected: CycleCountExpectedRow[],
  scanned: string[],
  sessionLocationId: string,
): Promise<LiveVariance> {
  const expByEpc = new Map(expected.map((e) => [e.epc, e]));
  const scSet = new Set(scanned.map((s) => s.toUpperCase()));
  const matched: CycleCountExpectedRow[] = [];
  const missing: CycleCountExpectedRow[] = [];
  for (const e of expected) {
    if (scSet.has(e.epc)) matched.push(e);
    else missing.push(e);
  }
  const extras = [...scSet].filter((e) => !expByEpc.has(e));

  if (extras.length === 0) {
    return { matched, missing, added_here: [], defective: [], locked: [] };
  }

  const labelMap = await loadStatusLabelBrainMap(client);

  const r = await client.query<{
    epc: string;
    sku: string | null;
    description: string | null;
    upc: string | null;
    color: string | null;
    size: string | null;
    bin_id: string | null;
    bin_code: string | null;
    current_status: string;
    current_location_id: string | null;
    current_location_code: string | null;
  }>(
    `SELECT
       i.epc,
       cs.sku,
       m.description,
       COALESCE(NULLIF(trim(cs.upc), ''), m.upc) AS upc,
       cs.color_code AS color,
       cs.size,
       i.bin_id::text AS bin_id,
       b.code AS bin_code,
       i.status AS current_status,
       i.location_id::text AS current_location_id,
       loc.code AS current_location_code
     FROM items i
     INNER JOIN locations loc ON loc.id = i.location_id AND loc.tenant_id = $1::uuid
     LEFT JOIN custom_skus cs ON cs.id = i.custom_sku_id
     LEFT JOIN matrices m ON m.id = cs.matrix_id
     LEFT JOIN bins b ON b.id = i.bin_id
     WHERE i.epc = ANY($2::text[])`,
    [tenantId, extras],
  );

  const byEpc = new Map<string, LiveScanRow>();
  for (const row of r.rows) {
    byEpc.set(row.epc.toUpperCase(), row);
  }

  const added_here: LiveScanRow[] = [];
  const defective: LiveScanRow[] = [];
  const locked: LiveScanRow[] = [];

  for (const epc of extras) {
    const row = byEpc.get(epc);
    if (!row) {
      // No items row at all — shouldn't happen since live ingest always
      // writes one. Bucket as defective so it's visible to the operator.
      defective.push({
        epc,
        sku: null,
        description: null,
        upc: null,
        color: null,
        size: null,
        bin_id: null,
        bin_code: null,
        current_status: "tag_killed",
        current_location_id: null,
        current_location_code: null,
      });
      continue;
    }
    const flags = labelMap.get(labelNameForWmsStatus(row.current_status).toLowerCase());
    if (flags?.super_admin_locked && row.current_status !== "tag_killed") {
      locked.push(row);
    } else if (row.current_status === "tag_killed") {
      defective.push(row);
    } else if (
      row.current_status === "in-stock" &&
      row.current_location_id === sessionLocationId
    ) {
      added_here.push(row);
    } else {
      // Edge: in-stock at another location, or some other unlocked non-in-stock
      // status. Show as added_here so the operator at least sees it — they
      // can resolve from there.
      added_here.push(row);
    }
  }

  return { matched, missing, added_here, defective, locked };
}

export type CommitOpts = {
  /** Optional: if set, only the missing EPCs in this list are flipped to
   *  tag_killed. Lets the operator deselect a row in the preview modal if
   *  they don't want to mark a given EPC as missing yet. */
  acceptMissing?: string[];
  notes?: string;
};

export async function commitSession(
  client: PoolClient,
  session: SessionPayload,
  id: string,
  opts: CommitOpts,
): Promise<SessionDetail> {
  const cur = await getSession(client, session.tid, id);
  if (!cur) throw new Error("BAD_REQUEST:Session not found");
  if (cur.status === "committed") throw new Error("BAD_REQUEST:Session already committed");
  if (cur.status === "canceled") throw new Error("BAD_REQUEST:Session was canceled");

  // Live-ingest already settled added_here / defective / locked during the
  // scan. The only thing left to apply at commit is Missing → tag_killed.
  const variance = await classifyVarianceLive(
    client,
    session.tid,
    cur.expected,
    cur.scanned_epcs,
    cur.location_id,
  );
  const missingEpcs = variance.missing.map((m) => m.epc);
  const filteredMissing = opts.acceptMissing
    ? missingEpcs.filter((e) => opts.acceptMissing!.includes(e))
    : missingEpcs;

  const commitBody = cycleCountCommitSchema.parse({
    locationId: cur.location_id,
    binId: cur.bin_id,
    matched: variance.matched.map((m) => m.epc),
    missing: filteredMissing,
    misplaced: [],
    unrecognized: [],
  });

  const result = await commitCycleCount(client, session, commitBody);

  const summary: VarianceSummary = {
    matched: variance.matched.length,
    missing: filteredMissing.length,
    misplaced: 0,
    unrecognized: variance.defective.length + variance.locked.length,
  };

  await client.query(
    `UPDATE cycle_count_sessions
        SET status = 'committed',
            completed_at = now(),
            variance_summary = $3::jsonb,
            audit_log_id = $4::uuid,
            notes = COALESCE($5, notes)
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [
      session.tid,
      id,
      JSON.stringify(summary),
      result.audit_id || null,
      opts.notes ?? null,
    ],
  );

  const refreshed = await getSession(client, session.tid, id);
  if (!refreshed) throw new Error("INTERNAL:Committed session not found");
  return refreshed;
}

export type SkuRollupRow = {
  sku: string;
  description: string;
  expected: number;
  scanned: number;
  matched: number;
  missing: number;
  bins: { bin_code: string | null; expected: number; matched: number }[];
};

export type BinRollupRow = {
  bin_code: string | null;
  bin_id: string | null;
  expected: number;
  matched: number;
  missing: number;
  misplaced_in: number;
};

