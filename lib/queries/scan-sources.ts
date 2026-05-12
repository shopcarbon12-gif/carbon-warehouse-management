import type { Pool } from "pg";

/**
 * Add-On Count source picker — UNION across the 3 v1 source tables:
 *   - inventory_reports     (Mobile Count uploads)
 *   - cycle_count_sessions  (committed cycle counts)
 *   - device_upload_logs    (web-session CSV imports)
 *
 * Live Scan + Antenna Test are intentionally NOT included in v1
 * (Q3 + Q5 locked: drop from picker).
 */

export type ScanSourceType = "mobile_count" | "cycle_count" | "csv_import";

export type ScanSourceState = "free" | "in_use" | "completed";

export type ScanSourceRow = {
  /** Stable type+id pair the picker passes back when a row is selected. */
  source_type: ScanSourceType;
  source_id: string;
  /** 5-digit display slip prefixed with source-type letter. Q25 lock. */
  slip: string;
  state: ScanSourceState;
  uploaded_at: string;
  uploaded_by_email: string | null;
  device_id: string | null;
  row_count: number;
  /** When state='in_use', the active add_on_sessions.id. NULL otherwise.
   *  Picker passes this to the join-request flow. */
  locked_session_id: string | null;
  /** Email of the operator currently using the session (when locked). */
  locked_by_user_email: string | null;
  /** Filled when state = completed. */
  completed_at: string | null;
  completed_by_user_email: string | null;
};

/** 5-digit decimal slip from a UUID (Q25 lock: number, 5 digits). */
function slipFromUuid(uuid: string, prefix: string): string {
  const hex = uuid.replace(/-/g, "").slice(-12);
  const n = Number(BigInt("0x" + hex) % BigInt(100000));
  return `${prefix}-${n.toString().padStart(5, "0")}`;
}

function slipFromInt(n: number, prefix: string): string {
  const five = (n % 100000).toString().padStart(5, "0");
  return `${prefix}-${five}`;
}

function deriveState(
  lockedBy: string | null,
  completedAt: string | null,
): ScanSourceState {
  if (completedAt) return "completed";
  if (lockedBy) return "in_use";
  return "free";
}

export type ListScanSourcesOpts = {
  /** Hide rows where state = 'completed'. Default: hide. */
  includeCompleted?: boolean;
  limit?: number;
};

/**
 * One UNION query against all 3 source tables. Sorted newest-first across
 * the union (Q28 lock: newest-first w/ type badges in UI).
 */
export async function listScanSources(
  pool: Pool,
  tenantId: string,
  opts: ListScanSourcesOpts = {},
): Promise<ScanSourceRow[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const includeCompleted = !!opts.includeCompleted;

  const completedFilter = includeCompleted
    ? ""
    : "AND add_on_completed_at IS NULL";

  // Mobile Count: handheld Count screen archives here via finalize.
  // Activity values now stored as 'MOBILE COUNT' / 'MOBILE COUNT (OVERRIDE)'
  // (see lib/server/scan-finalize.ts activityForScreen). Legacy rows from
  // before 2026-05-05 used 'COUNT' — we still match those for back-compat.
  const mobileSql = `
    SELECT
      'mobile_count'::text                        AS source_type,
      id::text                                    AS source_id,
      uploaded_at                                 AS uploaded_at,
      uploaded_by                                 AS uploaded_by_id,
      device_id                                   AS device_id,
      row_count                                   AS row_count,
      add_on_locked_by::text                      AS locked_by,
      add_on_completed_at                         AS completed_at,
      add_on_completed_by::text                   AS completed_by,
      NULL::int                                   AS session_number
    FROM inventory_reports
    WHERE tenant_id = $1::uuid
      AND (
            activity ILIKE 'MOBILE COUNT%'
         OR activity = 'COUNT'
         OR activity = 'INVENTORY COUNT'
         OR UPPER(activity) LIKE 'COUNT\\_%' ESCAPE '\\'
          )
      ${completedFilter}
  `;

  // Cycle Count: only committed sessions are valid sources (in-progress ones
  // could change). 'scanned_epcs' is a JSONB array of EPCs. `session_number`
  // (migration 0064, soon 0070) is the operator-visible "#NNN" displayed in
  // the cycle-counts web UI — we surface it as the slip so picker rows match
  // what the operator already knows the count as.
  const cycleSql = `
    SELECT
      'cycle_count'::text                         AS source_type,
      id::text                                    AS source_id,
      COALESCE(completed_at, started_at)          AS uploaded_at,
      started_by::text                            AS uploaded_by_id,
      NULL::text                                  AS device_id,
      jsonb_array_length(scanned_epcs)            AS row_count,
      add_on_locked_by::text                      AS locked_by,
      add_on_completed_at                         AS completed_at,
      add_on_completed_by::text                   AS completed_by,
      session_number                              AS session_number
    FROM cycle_count_sessions
    WHERE tenant_id = $1::uuid
      AND status = 'committed'
      ${completedFilter}
  `;

  // CSV Import: web-session uploads via /api/inventory/upload that are NOT
  // count-style modes (those already surface as Mobile Count rows).
  const csvSql = `
    SELECT
      'csv_import'::text                          AS source_type,
      id::text                                    AS source_id,
      created_at                                  AS uploaded_at,
      NULL::text                                  AS uploaded_by_id,
      device_id                                   AS device_id,
      0                                           AS row_count,
      add_on_locked_by::text                      AS locked_by,
      add_on_completed_at                         AS completed_at,
      add_on_completed_by::text                   AS completed_by,
      NULL::int                                   AS session_number
    FROM device_upload_logs
    WHERE tenant_id = $1::uuid
      AND device_id = 'web-session'
      AND workflow_mode NOT ILIKE 'count\\_%' ESCAPE '\\'
      ${completedFilter}
  `;

  // LEFT JOIN add_on_sessions on the lock to surface the active session id +
  // owner. This is what powers the "in use by … " row state and the join
  // request flow on the picker. Lock is stored on the source-row (Phase 3a),
  // session id is matched by tenant + owner_user_id since that's what the
  // lock column points at. We also support direct session lookup by id when
  // applicable.
  const sql = `
    WITH all_sources AS (
      ${mobileSql}
      UNION ALL
      ${cycleSql}
      UNION ALL
      ${csvSql}
    )
    SELECT
      s.*,
      sess.id::text          AS locked_session_id,
      sess.owner_user_id::text AS locked_owner_id
    FROM all_sources s
    LEFT JOIN LATERAL (
      SELECT id, owner_user_id
        FROM add_on_sessions
       WHERE add_on_sessions.tenant_id = $1::uuid
         AND add_on_sessions.source_type = s.source_type
         AND add_on_sessions.source_id = s.source_id
         AND add_on_sessions.state IN ('active','paused')
       ORDER BY add_on_sessions.last_activity_at DESC
       LIMIT 1
    ) sess ON true
    ORDER BY s.uploaded_at DESC
    LIMIT $2::int
  `;

  const r = await pool.query<{
    source_type: ScanSourceType;
    source_id: string;
    uploaded_at: Date;
    uploaded_by_id: string | null;
    device_id: string | null;
    row_count: number | string;
    locked_by: string | null;
    completed_at: Date | null;
    completed_by: string | null;
    locked_session_id: string | null;
    locked_owner_id: string | null;
    // Only present for cycle_count rows — mobile_count + csv_import return null.
    session_number?: number | null;
  }>(sql, [tenantId, limit]);

  // Resolve user emails for uploaded_by / locked_owner / completed_by in one batch.
  const userIds = Array.from(
    new Set(
      r.rows
        .flatMap((row) => [row.uploaded_by_id, row.locked_owner_id, row.completed_by])
        .filter((v): v is string => !!v),
    ),
  );
  const emails = new Map<string, string>();
  if (userIds.length > 0) {
    try {
      const er = await pool.query<{ id: string; email: string }>(
        `SELECT id::text, email FROM users WHERE id = ANY($1::uuid[])`,
        [userIds],
      );
      for (const row of er.rows) emails.set(row.id, row.email);
    } catch {
      /* best-effort */
    }
  }

  return r.rows.map((row) => {
    const completedAt = row.completed_at?.toISOString() ?? null;
    const slip = (() => {
      if (row.source_type === "csv_import") {
        const n = Number.parseInt(row.source_id, 10);
        return slipFromInt(Number.isFinite(n) ? n : 0, "I");
      }
      // Cycle Count: prefer the operator-visible session_number (#NNN in
      // the web UI). Falls back to UUID-hash slip only if the column is
      // null — should only happen for pre-0064 rows that never got
      // backfilled. 3-digit pad matches the "#010" form the operator sees.
      if (row.source_type === "cycle_count" && typeof row.session_number === "number") {
        return `C-${row.session_number.toString().padStart(3, "0")}`;
      }
      const prefix = row.source_type === "mobile_count" ? "M" : "C";
      return slipFromUuid(row.source_id, prefix);
    })();
    return {
      source_type: row.source_type,
      source_id: row.source_id,
      slip,
      state: deriveState(row.locked_by, completedAt),
      uploaded_at: row.uploaded_at.toISOString(),
      uploaded_by_email:
        row.uploaded_by_id ? emails.get(row.uploaded_by_id) ?? null : null,
      device_id: row.device_id,
      row_count: Number(row.row_count) || 0,
      locked_session_id: row.locked_session_id,
      locked_by_user_email:
        row.locked_owner_id ? emails.get(row.locked_owner_id) ?? null : null,
      completed_at: completedAt,
      completed_by_user_email:
        row.completed_by ? emails.get(row.completed_by) ?? null : null,
    };
  });
}

/**
 * Fetch the EPC list for a single source. Returns a flat array of upper-case
 * 24-char EPC hex strings. The Add-On Count scan screen loads this once when
 * a source is picked and uses it for client-side dedup display (server still
 * mediates dedup across multiple operators — see Phase 3b).
 */
export async function getScanSourceEpcs(
  pool: Pool,
  tenantId: string,
  sourceType: ScanSourceType,
  sourceId: string,
): Promise<string[] | null> {
  if (sourceType === "mobile_count") {
    const r = await pool.query<{ csv_content: string }>(
      `SELECT csv_content FROM inventory_reports
        WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
      [sourceId, tenantId],
    );
    if (!r.rows[0]) return null;
    return extractEpcsFromCsv(r.rows[0].csv_content);
  }

  if (sourceType === "cycle_count") {
    const r = await pool.query<{ scanned_epcs: unknown }>(
      `SELECT scanned_epcs FROM cycle_count_sessions
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = 'committed' LIMIT 1`,
      [sourceId, tenantId],
    );
    const raw = r.rows[0]?.scanned_epcs;
    if (!Array.isArray(raw)) return null;
    return raw
      .map((e) => (typeof e === "string" ? e.replace(/\s/g, "").toUpperCase() : null))
      .filter((e): e is string => !!e && /^[0-9A-F]{24}$/.test(e));
  }

  // csv_import
  const idNum = Number.parseInt(sourceId, 10);
  if (!Number.isFinite(idNum)) return null;
  const r = await pool.query<{ raw_csv: string }>(
    `SELECT raw_csv FROM device_upload_logs
      WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1`,
    [idNum, tenantId],
  );
  if (!r.rows[0]) return null;
  return extractEpcsFromCsv(r.rows[0].raw_csv);
}

function extractEpcsFromCsv(csv: string): string[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0]!.split(",").map((h) =>
    h.toLowerCase().replace(/^"|"$/g, "").trim(),
  );
  const epcIdx = headers.findIndex((h) => h === "epc" || h === "tag" || h === "epc_hex");
  if (epcIdx < 0) return [];
  const out = new Set<string>();
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const raw = cells[epcIdx]?.replace(/^"|"$/g, "").replace(/\s/g, "").toUpperCase();
    if (raw && /^[0-9A-F]{24}$/.test(raw)) out.add(raw);
  }
  return [...out];
}

/** Acquire the Add-On lock on a source row. Returns false if already locked. */
export async function acquireSourceLock(
  pool: Pool,
  tenantId: string,
  sourceType: ScanSourceType,
  sourceId: string,
  sessionId: string,
): Promise<boolean> {
  const table = sourceType === "mobile_count"
    ? "inventory_reports"
    : sourceType === "cycle_count"
      ? "cycle_count_sessions"
      : "device_upload_logs";
  const idCast = sourceType === "csv_import" ? "::int" : "::uuid";
  const r = await pool.query(
    `UPDATE ${table}
        SET add_on_locked_by = $1::uuid
      WHERE id = $2${idCast}
        AND tenant_id = $3::uuid
        AND add_on_locked_by IS NULL
        AND add_on_completed_at IS NULL`,
    [sessionId, sourceId, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Release the lock without marking completed (e.g. session cancelled). */
export async function releaseSourceLock(
  pool: Pool,
  tenantId: string,
  sourceType: ScanSourceType,
  sourceId: string,
): Promise<void> {
  const table = sourceType === "mobile_count"
    ? "inventory_reports"
    : sourceType === "cycle_count"
      ? "cycle_count_sessions"
      : "device_upload_logs";
  const idCast = sourceType === "csv_import" ? "::int" : "::uuid";
  await pool.query(
    `UPDATE ${table}
        SET add_on_locked_by = NULL
      WHERE id = $1${idCast} AND tenant_id = $2::uuid`,
    [sourceId, tenantId],
  );
}

/** Mark source completed (locks it from future Add-On picks until super-admin re-opens). */
export async function markSourceCompleted(
  pool: Pool,
  tenantId: string,
  sourceType: ScanSourceType,
  sourceId: string,
  userId: string | null,
): Promise<void> {
  const table = sourceType === "mobile_count"
    ? "inventory_reports"
    : sourceType === "cycle_count"
      ? "cycle_count_sessions"
      : "device_upload_logs";
  const idCast = sourceType === "csv_import" ? "::int" : "::uuid";
  await pool.query(
    `UPDATE ${table}
        SET add_on_locked_by    = NULL,
            add_on_completed_at = now(),
            add_on_completed_by = $1::uuid
      WHERE id = $2${idCast} AND tenant_id = $3::uuid`,
    [userId, sourceId, tenantId],
  );
}

/** Super-admin re-open: clears completion (Q29 lock — events table preserves history). */
export async function reopenSource(
  pool: Pool,
  tenantId: string,
  sourceType: ScanSourceType,
  sourceId: string,
): Promise<void> {
  const table = sourceType === "mobile_count"
    ? "inventory_reports"
    : sourceType === "cycle_count"
      ? "cycle_count_sessions"
      : "device_upload_logs";
  const idCast = sourceType === "csv_import" ? "::int" : "::uuid";
  await pool.query(
    `UPDATE ${table}
        SET add_on_completed_at = NULL,
            add_on_completed_by = NULL,
            add_on_locked_by    = NULL
      WHERE id = $1${idCast} AND tenant_id = $2::uuid`,
    [sourceId, tenantId],
  );
}
