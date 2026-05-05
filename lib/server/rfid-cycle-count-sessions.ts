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
  name: z.string().trim().max(160).optional(),
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

export type CreateSessionBody = z.infer<typeof createSessionSchema>;
export type PatchSessionBody = z.infer<typeof patchSessionSchema>;

export type SessionRow = {
  id: string;
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
  const loc = await assertLocationInTenant(client, session.tid, body.locationId);
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

  const name =
    (body.name && body.name.length > 0)
      ? body.name
      : autoSessionName(loc.code, binCode);

  const ins = await client.query<{ id: string }>(
    `INSERT INTO cycle_count_sessions
       (tenant_id, location_id, bin_id, name, status, started_by,
        expected_snapshot, scanned_epcs, reader_filter, notes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'active', $5::uuid,
             $6::jsonb, '[]'::jsonb, $7::jsonb, $8)
     RETURNING id::text`,
    [
      session.tid,
      body.locationId,
      body.binId ?? null,
      name,
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

function autoSessionName(locationCode: string, binCode: string | null): string {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 16);
  return binCode
    ? `${locationCode} · ${binCode} · ${ts}`
    : `${locationCode} · all bins · ${ts}`;
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
 * Variance computation — used by the commit path AND the CSV export so
 * both stay consistent. The misplaced/unrecognized split for "extras"
 * (scanned EPCs not in the expected snapshot) is determined by checking
 * if the EPC currently exists as in-stock anywhere else in the tenant.
 */
export async function classifyVariance(
  client: PoolClient,
  tenantId: string,
  expected: CycleCountExpectedRow[],
  scanned: string[],
): Promise<{
  matched: string[];
  missing: string[];
  misplaced: string[];
  unrecognized: string[];
}> {
  const expSet = new Set(expected.map((e) => e.epc));
  const scSet = new Set(scanned.map((s) => s.toUpperCase()));
  const matched = [...expSet].filter((e) => scSet.has(e));
  const missing = [...expSet].filter((e) => !scSet.has(e));
  const extras = [...scSet].filter((e) => !expSet.has(e));

  if (extras.length === 0) {
    return { matched, missing, misplaced: [], unrecognized: [] };
  }

  // Look up which extras are in-stock somewhere else → misplaced.
  // Anything not found OR not in-stock → unrecognized.
  const r = await client.query<{ epc: string }>(
    `SELECT i.epc
       FROM items i
       INNER JOIN locations loc ON loc.id = i.location_id AND loc.tenant_id = $1::uuid
       WHERE i.epc = ANY($2::text[])
         AND i.status = 'in-stock'`,
    [tenantId, extras],
  );
  const stillInStock = new Set(r.rows.map((row) => row.epc.toUpperCase()));
  const misplaced: string[] = [];
  const unrecognized: string[] = [];
  for (const epc of extras) {
    if (stillInStock.has(epc)) misplaced.push(epc);
    else unrecognized.push(epc);
  }
  return { matched, missing, misplaced, unrecognized };
}

export type CommitOpts = {
  /** If set, only the misplaced EPCs in this list are persisted. Lets the
   *  operator deselect a misplaced row in the preview if they don't trust
   *  the auto-classification. Same for missing. */
  acceptMisplaced?: string[];
  acceptMissing?: string[];
  acceptUnrecognized?: string[];
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

  const variance = await classifyVariance(
    client,
    session.tid,
    cur.expected,
    cur.scanned_epcs,
  );

  // Apply opt-in filters: if the operator passed explicit accept lists,
  // intersect them with auto-classified buckets so anything unchecked in
  // the preview modal is left unchanged.
  const filteredMissing = opts.acceptMissing
    ? variance.missing.filter((e) => opts.acceptMissing!.includes(e))
    : variance.missing;
  const filteredMisplaced = opts.acceptMisplaced
    ? variance.misplaced.filter((e) => opts.acceptMisplaced!.includes(e))
    : variance.misplaced;
  const filteredUnrecognized = opts.acceptUnrecognized
    ? variance.unrecognized.filter((e) => opts.acceptUnrecognized!.includes(e))
    : variance.unrecognized;

  const commitBody = cycleCountCommitSchema.parse({
    locationId: cur.location_id,
    binId: cur.bin_id,
    matched: variance.matched,
    missing: filteredMissing,
    misplaced: filteredMisplaced,
    unrecognized: filteredUnrecognized,
  });

  const result = await commitCycleCount(client, session, commitBody);

  const summary: VarianceSummary = {
    matched: variance.matched.length,
    missing: filteredMissing.length,
    misplaced: filteredMisplaced.length,
    unrecognized: filteredUnrecognized.length,
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

/**
 * Server-rendered CSV: fixed column order so it diffs cleanly between
 * counts. Includes session header + one row per EPC + variance totals.
 */
export function renderSessionCsv(
  detail: SessionDetail,
  variance: {
    matched: string[];
    missing: string[];
    misplaced: string[];
    unrecognized: string[];
  },
): string {
  const expByEpc = new Map(detail.expected.map((e) => [e.epc, e]));
  const lines: string[] = [];
  lines.push(`# Cycle count session ${detail.id}`);
  lines.push(`# Name: ${csvEscape(detail.name)}`);
  lines.push(`# Location: ${detail.location_code} (${csvEscape(detail.location_name)})`);
  lines.push(`# Bin: ${detail.bin_code ?? "(all bins at location)"}`);
  lines.push(`# Status: ${detail.status}`);
  lines.push(`# Started: ${detail.started_at}`);
  lines.push(`# Started by: ${detail.started_by_email ?? "(unknown)"}`);
  lines.push(`# Completed: ${detail.completed_at ?? ""}`);
  lines.push(`# Notes: ${csvEscape(detail.notes ?? "")}`);
  lines.push(`#`);
  lines.push(`# Totals`);
  lines.push(`# Matched, Missing, Misplaced, Unrecognized, Expected, Scanned`);
  lines.push(
    `# ${variance.matched.length}, ${variance.missing.length}, ${variance.misplaced.length}, ${variance.unrecognized.length}, ${detail.expected.length}, ${detail.scanned_epcs.length}`,
  );
  lines.push(`#`);
  lines.push(`epc,sku,description,expected_bin,state`);

  const seen = new Set<string>();
  const push = (epc: string, state: string) => {
    if (seen.has(epc)) return;
    seen.add(epc);
    const exp = expByEpc.get(epc);
    lines.push(
      [
        epc,
        csvEscape(exp?.sku ?? ""),
        csvEscape(exp?.description ?? ""),
        csvEscape(exp?.bin_code ?? ""),
        state,
      ].join(","),
    );
  };
  for (const e of variance.matched) push(e, "matched");
  for (const e of variance.missing) push(e, "missing");
  for (const e of variance.misplaced) push(e, "misplaced");
  for (const e of variance.unrecognized) push(e, "unrecognized");

  return lines.join("\n");
}

function csvEscape(s: string): string {
  if (!s) return "";
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
