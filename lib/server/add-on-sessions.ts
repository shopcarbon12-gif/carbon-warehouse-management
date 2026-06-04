import type { Pool, PoolClient } from "pg";
import { acquireSourceLock, releaseSourceLock, type ScanSourceType } from "@/lib/queries/scan-sources";

/**
 * Server-side state machine for Add-On Count multi-operator sessions.
 *
 * Locks live in the source table (Phase 3a's add_on_locked_by columns).
 * Session state lives in add_on_sessions. Per-event audit lives in
 * add_on_session_events (Q29 lock: append-only history).
 *
 * Q12-Q14 locks:
 *   - 60s disconnect kick (Q12)        — heartbeat-based janitor
 *   - 10min idle session cancel (Q13)  — janitor too
 *   - cap 3 operators per session (Q14)
 */

export const MAX_OPERATORS_PER_SESSION = 3;
export const HEARTBEAT_DROP_MS = 60_000;
export const IDLE_CANCEL_MS = 10 * 60_000;

export type SessionState = "active" | "paused" | "completed" | "cancelled";

export type SessionEventType =
  | "started"
  | "joined"
  | "join_requested"
  | "join_approved"
  | "join_declined"
  | "epc_new"
  | "epc_duplicate"
  | "epc_failed"
  | "paused"
  | "resumed"
  | "signed_out"
  | "heartbeat"
  | "completed"
  | "cancelled"
  | "reopened";

export type AddOnSessionRow = {
  id: string;
  tenant_id: string;
  source_type: ScanSourceType;
  source_id: string;
  source_slip: string;
  owner_user_id: string | null;
  owner_device_id: string | null;
  joined_user_ids: string[];
  joined_device_ids: string[];
  state: SessionState;
  epc_ledger: Record<string, { u: string | null; d: string | null; at: string }>;
  failed_ledger: Record<string, { u: string | null; d: string | null; at: string; r: string }>;
  started_at: string;
  last_activity_at: string;
  ended_at: string | null;
  report_id: string | null;
};

export async function logEvent(
  client: PoolClient | Pool,
  args: {
    sessionId: string;
    tenantId: string;
    userId: string | null;
    deviceId: string | null;
    eventType: SessionEventType;
    payload?: Record<string, unknown>;
  },
): Promise<{ id: string; createdAtIso: string }> {
  const r = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO add_on_session_events
       (session_id, tenant_id, user_id, device_id, event_type, payload)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb)
     RETURNING id::text, created_at`,
    [
      args.sessionId,
      args.tenantId,
      args.userId,
      args.deviceId,
      args.eventType,
      JSON.stringify(args.payload ?? {}),
    ],
  );
  const row = r.rows[0]!;
  return { id: row.id, createdAtIso: row.created_at.toISOString() };
}

export async function getSession(
  pool: Pool,
  tenantId: string,
  sessionId: string,
): Promise<AddOnSessionRow | null> {
  // epc_ledger / failed_ledger are reconstructed from the add_on_session_epcs
  // child table (the JSONB columns are no longer written per-EPC). This runs
  // once per getSession call (session open / join / SSE-stream start), NOT on
  // the per-EPC hot path, so the O(n) aggregate here is fine — the win is that
  // each individual EPC write is now O(1).
  const r = await pool.query(
    `SELECT s.id::text, s.tenant_id::text, s.source_type, s.source_id, s.source_slip,
            s.owner_user_id::text AS owner_user_id, s.owner_device_id,
            s.joined_user_ids::text[] AS joined_user_ids,
            s.joined_device_ids::text[] AS joined_device_ids,
            s.state,
            COALESCE((
              SELECT jsonb_object_agg(e.epc, jsonb_build_object(
                       'u', e.u::text, 'd', e.d, 'at', to_jsonb(e.at)))
                FROM add_on_session_epcs e
               WHERE e.session_id = s.id AND e.failed = false
            ), '{}'::jsonb) AS epc_ledger,
            COALESCE((
              SELECT jsonb_object_agg(e.epc, jsonb_build_object(
                       'u', e.u::text, 'd', e.d, 'at', to_jsonb(e.at), 'r', e.reason))
                FROM add_on_session_epcs e
               WHERE e.session_id = s.id AND e.failed = true
            ), '{}'::jsonb) AS failed_ledger,
            s.started_at, s.last_activity_at, s.ended_at, s.report_id::text AS report_id
       FROM add_on_sessions s
      WHERE s.id = $1::uuid AND s.tenant_id = $2::uuid
      LIMIT 1`,
    [sessionId, tenantId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    ...row,
    started_at: row.started_at.toISOString(),
    last_activity_at: row.last_activity_at.toISOString(),
    ended_at: row.ended_at?.toISOString() ?? null,
  } as AddOnSessionRow;
}

export type StartSessionInput = {
  tenantId: string;
  sourceType: ScanSourceType;
  sourceId: string;
  sourceSlip: string;
  ownerUserId: string | null;
  ownerDeviceId: string | null;
};

/**
 * Start a new session against a source. Acquires the source-row lock and
 * inserts the add_on_sessions row in one transaction. Returns null if the
 * source is already locked or completed.
 */
export async function startSession(
  pool: Pool,
  input: StartSessionInput,
): Promise<AddOnSessionRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Pre-check: source must be free + not completed.
    const sessionR = await client.query<{ id: string }>(
      `INSERT INTO add_on_sessions
         (tenant_id, source_type, source_id, source_slip,
          owner_user_id, owner_device_id, state)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, 'active')
       RETURNING id::text`,
      [
        input.tenantId,
        input.sourceType,
        input.sourceId,
        input.sourceSlip,
        input.ownerUserId,
        input.ownerDeviceId,
      ],
    );
    const sessionId = sessionR.rows[0]!.id;

    const lockOk = await acquireSourceLock(
      pool,
      input.tenantId,
      input.sourceType,
      input.sourceId,
      sessionId,
    );
    if (!lockOk) {
      await client.query("ROLLBACK");
      return null;
    }

    await logEvent(client, {
      sessionId,
      tenantId: input.tenantId,
      userId: input.ownerUserId,
      deviceId: input.ownerDeviceId,
      eventType: "started",
      payload: { source_type: input.sourceType, source_id: input.sourceId },
    });

    await client.query("COMMIT");
    return await getSession(pool, input.tenantId, sessionId);
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    // Unique-violation = source already has an active session.
    if ((e as { code?: string }).code === "23505") return null;
    throw e;
  } finally {
    client.release();
  }
}

/** Capacity check + member add. Returns the updated session, or null if cap. */
export async function joinSession(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  userId: string | null,
  deviceId: string | null,
): Promise<AddOnSessionRow | null> {
  const session = await getSession(pool, tenantId, sessionId);
  if (!session) return null;
  const total = 1 + session.joined_user_ids.length;
  if (total >= MAX_OPERATORS_PER_SESSION) return null;

  await pool.query(
    `UPDATE add_on_sessions
        SET joined_user_ids   = CASE WHEN $1::uuid IS NULL OR $1::uuid = ANY(joined_user_ids)
                                     THEN joined_user_ids
                                     ELSE array_append(joined_user_ids, $1::uuid) END,
            joined_device_ids = CASE WHEN $2::text IS NULL OR $2::text = ANY(joined_device_ids)
                                     THEN joined_device_ids
                                     ELSE array_append(joined_device_ids, $2::text) END,
            last_activity_at  = now()
      WHERE id = $3::uuid AND tenant_id = $4::uuid`,
    [userId, deviceId, sessionId, tenantId],
  );

  await logEvent(pool, {
    sessionId,
    tenantId,
    userId,
    deviceId,
    eventType: "joined",
  });

  return await getSession(pool, tenantId, sessionId);
}

/** Server-mediated dedup for an incoming EPC.
 *
 * O(1) — `epc_count` is maintained in the same UPDATE so we never need to
 * scan the JSONB ledger to count keys. The UPDATE row-lock is sufficient to
 * prevent two concurrent submissions racing the same EPC (whichever lands
 * second sees the key already present and short-circuits to duplicate).
 */
export async function submitEpc(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  epc: string,
  userId: string | null,
  deviceId: string | null,
): Promise<{ outcome: "new" | "duplicate"; ledgerSize: number }> {
  const cleanEpc = epc.replace(/\s/g, "").toUpperCase();

  // O(1): insert one row into the child table, gated on the session belonging
  // to this tenant. ON CONFLICT means a re-read of the same EPC is a no-op
  // ("duplicate"). epc_count is bumped only when a row was actually added.
  const r = await pool.query<{ added: boolean; ledger_size: number }>(
    `WITH ins AS (
       INSERT INTO add_on_session_epcs (session_id, epc, failed, u, d)
       SELECT $1::uuid, $3::text, false, $4::uuid, $5::text
       WHERE EXISTS (
         SELECT 1 FROM add_on_sessions WHERE id = $1::uuid AND tenant_id = $2::uuid
       )
       ON CONFLICT (session_id, epc) DO NOTHING
       RETURNING true AS added
     ),
     upd AS (
       UPDATE add_on_sessions
          SET epc_count = epc_count + (SELECT COUNT(*)::int FROM ins),
              last_activity_at = now()
        WHERE id = $1::uuid AND tenant_id = $2::uuid
        RETURNING epc_count
     )
     SELECT
       COALESCE((SELECT added FROM ins), false) AS added,
       COALESCE((SELECT epc_count FROM upd), 0) AS ledger_size`,
    [sessionId, tenantId, cleanEpc, userId, deviceId],
  );
  const row = r.rows[0]!;

  await logEvent(pool, {
    sessionId,
    tenantId,
    userId,
    deviceId,
    eventType: row.added ? "epc_new" : "epc_duplicate",
    payload: { epc: cleanEpc },
  });

  return {
    outcome: row.added ? "new" : "duplicate",
    ledgerSize: row.ledger_size,
  };
}

/**
 * Batch counterpart of {@link submitEpc} — the handheld buffers reads locally
 * (counter ticks up per-tag with no network wait) and flushes them here in
 * chunks. Inserts valid EPCs and failed-validation EPCs in two bulk statements
 * (O(1) per row via ON CONFLICT), bumps the counters by the number actually
 * added, and emits ONE `epc_new` SSE event carrying the freshly-added EPCs so
 * other devices in the session dedup against them.
 */
export type BatchEpcInput = {
  epc: string;
  validationFailed?: boolean;
  failureReason?: string;
};

export async function submitEpcsBatch(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  items: BatchEpcInput[],
  userId: string | null,
  deviceId: string | null,
): Promise<{
  added: string[];
  failedAdded: string[];
  epcCount: number;
  failedCount: number;
}> {
  const clean = (s: string) => s.replace(/\s/g, "").toUpperCase();
  // De-dup within the batch and split valid vs failed.
  const validSet = new Set<string>();
  const failedMap = new Map<string, string>();
  for (const it of items) {
    const e = clean(it.epc);
    if (!/^[0-9A-F]{24}$/.test(e)) continue;
    if (it.validationFailed) {
      if (!validSet.has(e)) failedMap.set(e, it.failureReason ?? "device_decode_failed");
    } else {
      validSet.add(e);
      failedMap.delete(e);
    }
  }
  const validEpcs = [...validSet];
  const failedEpcs = [...failedMap.keys()];
  const failedReasons = failedEpcs.map((e) => failedMap.get(e)!);

  let added: string[] = [];
  let failedAdded: string[] = [];

  if (validEpcs.length > 0) {
    const r = await pool.query<{ epc: string }>(
      `INSERT INTO add_on_session_epcs (session_id, epc, failed, u, d)
       SELECT $1::uuid, x.epc, false, $2::uuid, $3::text
       FROM unnest($4::text[]) AS x(epc)
       WHERE EXISTS (
         SELECT 1 FROM add_on_sessions WHERE id = $1::uuid AND tenant_id = $5::uuid
       )
       ON CONFLICT (session_id, epc) DO NOTHING
       RETURNING epc`,
      [sessionId, userId, deviceId, validEpcs, tenantId],
    );
    added = r.rows.map((x) => x.epc);
  }

  if (failedEpcs.length > 0) {
    const r = await pool.query<{ epc: string }>(
      `INSERT INTO add_on_session_epcs (session_id, epc, failed, reason, u, d)
       SELECT $1::uuid, x.epc, true, x.reason, $2::uuid, $3::text
       FROM unnest($4::text[], $5::text[]) AS x(epc, reason)
       WHERE EXISTS (
         SELECT 1 FROM add_on_sessions WHERE id = $1::uuid AND tenant_id = $6::uuid
       )
       ON CONFLICT (session_id, epc) DO NOTHING
       RETURNING epc`,
      [sessionId, userId, deviceId, failedEpcs, failedReasons, tenantId],
    );
    failedAdded = r.rows.map((x) => x.epc);
  }

  const upd = await pool.query<{ epc_count: number; failed_count: number }>(
    `UPDATE add_on_sessions
        SET epc_count = epc_count + $2::int,
            failed_count = failed_count + $3::int,
            last_activity_at = now()
      WHERE id = $1::uuid AND tenant_id = $4::uuid
      RETURNING epc_count, failed_count`,
    [sessionId, added.length, failedAdded.length, tenantId],
  );

  // One SSE event per batch (not per EPC) carrying the newly-added EPCs so
  // other handhelds in the session mark them as duplicates.
  if (added.length > 0) {
    await logEvent(pool, {
      sessionId,
      tenantId,
      userId,
      deviceId,
      eventType: "epc_new",
      payload: { epcs: added },
    });
  }

  return {
    added,
    failedAdded,
    epcCount: upd.rows[0]?.epc_count ?? 0,
    failedCount: upd.rows[0]?.failed_count ?? 0,
  };
}

/** Record a failed-validation EPC into the failed_ledger (hidden during scan).
 *  Increments failed_count atomically so the review screen can read it cheap. */
export async function recordFailedEpc(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  epc: string,
  reason: string,
  userId: string | null,
  deviceId: string | null,
): Promise<void> {
  const cleanEpc = epc.replace(/\s/g, "").toUpperCase();
  await pool.query(
    `WITH ins AS (
       INSERT INTO add_on_session_epcs (session_id, epc, failed, reason, u, d)
       SELECT $6::uuid, $1::text, true, $5::text, $2::uuid, $3::text
       WHERE EXISTS (
         SELECT 1 FROM add_on_sessions WHERE id = $6::uuid AND tenant_id = $7::uuid
       )
       ON CONFLICT (session_id, epc) DO NOTHING
       RETURNING true AS added
     )
     UPDATE add_on_sessions
        SET failed_count = failed_count + (SELECT COUNT(*)::int FROM ins),
            last_activity_at = now()
      WHERE id = $6::uuid AND tenant_id = $7::uuid`,
    [cleanEpc, userId, deviceId, new Date().toISOString(), reason, sessionId, tenantId],
  );
  await logEvent(pool, {
    sessionId,
    tenantId,
    userId,
    deviceId,
    eventType: "epc_failed",
    payload: { epc: cleanEpc, reason },
  });
}

/** Sign one operator out. If they were owner and there are joined users, the
 *  longest-joined user inherits ownership. If the session has no remaining
 *  members, it stays in 'paused' awaiting the last operator's Continue, OR
 *  the janitor cancels it after the idle timeout. */
export async function signOut(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  userId: string | null,
  deviceId: string | null,
): Promise<AddOnSessionRow | null> {
  const session = await getSession(pool, tenantId, sessionId);
  if (!session) return null;

  // Remove from joined arrays.
  if (userId && session.joined_user_ids.includes(userId)) {
    await pool.query(
      `UPDATE add_on_sessions
          SET joined_user_ids   = array_remove(joined_user_ids, $1::uuid),
              joined_device_ids = array_remove(joined_device_ids, $2::text),
              last_activity_at  = now()
        WHERE id = $3::uuid AND tenant_id = $4::uuid`,
      [userId, deviceId, sessionId, tenantId],
    );
  } else if (session.owner_user_id === userId) {
    // Owner leaves: promote the first joined user, or pause the session.
    const newOwner = session.joined_user_ids[0] ?? null;
    if (newOwner) {
      const newDevice = session.joined_device_ids[0] ?? null;
      await pool.query(
        `UPDATE add_on_sessions
            SET owner_user_id     = $1::uuid,
                owner_device_id   = $2,
                joined_user_ids   = array_remove(joined_user_ids, $1::uuid),
                joined_device_ids = array_remove(joined_device_ids, $2),
                last_activity_at  = now()
          WHERE id = $3::uuid AND tenant_id = $4::uuid`,
        [newOwner, newDevice, sessionId, tenantId],
      );
    } else {
      await pool.query(
        `UPDATE add_on_sessions
            SET owner_user_id    = NULL,
                owner_device_id  = NULL,
                state            = 'paused',
                last_activity_at = now()
          WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [sessionId, tenantId],
      );
    }
  }

  await logEvent(pool, {
    sessionId,
    tenantId,
    userId,
    deviceId,
    eventType: "signed_out",
  });

  return await getSession(pool, tenantId, sessionId);
}

/** Bump last_activity_at — used by SSE clients on a 30s heartbeat. */
export async function touchSession(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  userId: string | null,
  deviceId: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE add_on_sessions
        SET last_activity_at = now()
      WHERE id = $1::uuid AND tenant_id = $2::uuid
        AND state IN ('active','paused')`,
    [sessionId, tenantId],
  );
  await logEvent(pool, {
    sessionId,
    tenantId,
    userId,
    deviceId,
    eventType: "heartbeat",
  });
}

/** Re-open a completed Add-On session so the operator can continue scanning.
 *  Caller MUST verify super-admin role before invoking — this helper does no
 *  authorisation of its own. Flips state back to 'paused' (operator is in
 *  the picker about to enter, not actively scanning yet), clears ended_at +
 *  report_id, and resets the underlying source's add_on_completed_at /
 *  add_on_locked_by so the picker treats the source as 'in_use' again and
 *  the picker filter doesn't hide it.
 *
 *  EPC ledger + failed ledger are preserved — the operator picks up where
 *  the prior session left off. The next finalize will create a NEW
 *  inventory_reports row; the prior report remains as a historical record.
 */
export async function reopenSession(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  reopenedByUserId: string | null,
  reopenedByDeviceId: string | null,
): Promise<AddOnSessionRow | null> {
  const session = await getSession(pool, tenantId, sessionId);
  if (!session) return null;
  if (session.state !== "completed") {
    // Only re-open *completed* sessions. Cancelled / active stay as-is.
    return null;
  }

  await pool.query(
    `UPDATE add_on_sessions
        SET state            = 'paused',
            ended_at         = NULL,
            report_id        = NULL,
            last_activity_at = now()
      WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [sessionId, tenantId],
  );

  // Reset the underlying source's add-on lock columns so the picker shows
  // the source as 'in_use' again rather than 'completed'. Three possible
  // source types — we update all three by id; only the matching one
  // actually has a row.
  const srcType = session.source_type;
  const srcId = session.source_id;
  const tables: Record<string, string> = {
    mobile_count: "inventory_reports",
    cycle_count: "cycle_count_sessions",
    csv_import: "device_upload_logs",
  };
  const table = tables[srcType];
  if (table) {
    await pool.query(
      `UPDATE ${table}
          SET add_on_completed_at = NULL,
              add_on_completed_by = NULL,
              add_on_locked_by    = $1::uuid
        WHERE id = $2::uuid AND tenant_id = $3::uuid`,
      [session.owner_user_id, srcId, tenantId],
    );
  }

  await logEvent(pool, {
    sessionId,
    tenantId,
    userId: reopenedByUserId,
    deviceId: reopenedByDeviceId,
    eventType: "reopened",
  });

  return await getSession(pool, tenantId, sessionId);
}

/** Janitor: cancel sessions idle past IDLE_CANCEL_MS. Run periodically. */
export async function janitorIdleSessions(pool: Pool): Promise<number> {
  const r = await pool.query<{ id: string; tenant_id: string; source_type: ScanSourceType; source_id: string }>(
    `UPDATE add_on_sessions
        SET state = 'cancelled',
            ended_at = now()
      WHERE state IN ('active','paused')
        AND last_activity_at < now() - ($1::int * interval '1 millisecond')
      RETURNING id::text, tenant_id::text, source_type, source_id`,
    [IDLE_CANCEL_MS],
  );
  for (const row of r.rows) {
    try {
      await releaseSourceLock(pool, row.tenant_id, row.source_type, row.source_id);
      await logEvent(pool, {
        sessionId: row.id,
        tenantId: row.tenant_id,
        userId: null,
        deviceId: null,
        eventType: "cancelled",
        payload: { reason: "idle_timeout" },
      });
    } catch (e) {
      console.error("[add-on-sessions janitor]", e);
    }
  }
  return r.rowCount ?? 0;
}

/**
 * Fetch events with id > sinceId — used by SSE for catch-up replay
 * after a brief disconnect.
 */
export async function eventsSince(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  sinceId: number,
  limit = 200,
): Promise<
  Array<{
    id: number;
    eventType: SessionEventType;
    userId: string | null;
    deviceId: string | null;
    payload: Record<string, unknown>;
    createdAtIso: string;
  }>
> {
  const r = await pool.query<{
    id: string;
    event_type: SessionEventType;
    user_id: string | null;
    device_id: string | null;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id::text, event_type, user_id::text AS user_id, device_id, payload, created_at
       FROM add_on_session_events
      WHERE session_id = $1::uuid AND tenant_id = $2::uuid AND id > $3::bigint
      ORDER BY id ASC
      LIMIT $4::int`,
    [sessionId, tenantId, sinceId, Math.min(limit, 1000)],
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    eventType: row.event_type,
    userId: row.user_id,
    deviceId: row.device_id,
    payload: row.payload,
    createdAtIso: row.created_at.toISOString(),
  }));
}
