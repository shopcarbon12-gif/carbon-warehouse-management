import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import {
  classifyVarianceLive,
  getSession,
  patchSessionSchema,
  updateSession,
} from "@/lib/server/rfid-cycle-count-sessions";
import { ingestCycleCountEpcs } from "@/lib/server/rfid-cycle-count-scan";
import { appendSourceSightings } from "@/lib/server/cycle-count-source-attribution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Backfill scanned_epcs from cdm_reads. The workspace's SSE chain
 * (/api/edge/stream → pendingScanRef → POST /scan) drops events on tab
 * background, network blip, or transient server hiccup — EPCs land in
 * cdm_reads with passes_formula=true but never get into the session.
 * Live evidence 2026-05-12: 1,005 of 1,010 "missing" EPCs were actually
 * seen by readers during the count.
 *
 * Every GET /sessions/[id] (SWR-polled) reconciles by pulling any
 * cdm_reads EPCs that aren't in scanned_epcs yet. To keep the GET cheap
 * under SWR polling we do two things:
 *
 *   1. Throttle: at most one backfill per session every BACKFILL_MIN_GAP_MS.
 *   2. Window: after the first backfill, only scan cdm_reads from the last
 *      BACKFILL_WINDOW_MS — anything older was caught by the previous pass
 *      (or was outside this session's window).
 *
 * Idempotent — no-op when SSE is keeping up. Cache is per-process; a Node
 * restart safely falls back to a full first-pass scan.
 */
const BACKFILL_MIN_GAP_MS = 20_000; // skip if we ran within the last 20s
const BACKFILL_WINDOW_MS = 5 * 60_000; // sliding 5-minute scan after first pass
const backfillState = new Map<string, { lastAt: number; firstDone: boolean }>();

async function backfillFromCdmReads(
  client: import("pg").PoolClient,
  tenantId: string,
  sessionId: string,
  detail: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  userId: string | null,
): Promise<void> {
  if (detail.status === "committed" || detail.status === "canceled") return;

  const now = Date.now();
  const state = backfillState.get(sessionId);
  if (state && now - state.lastAt < BACKFILL_MIN_GAP_MS) {
    /* Too soon since last backfill — skip. SSE is the primary path; this
       reconciler only needs to catch occasional drops. */
    return;
  }

  /* First call for this session in this Node process scans from session
     start (catches everything missed before the server came up). Subsequent
     calls use a sliding 5-min window — older drops were caught last time. */
  const startedAtMs = new Date(detail.started_at).getTime();
  const windowStartMs = state?.firstDone
    ? Math.max(startedAtMs, now - BACKFILL_WINDOW_MS)
    : startedAtMs;
  const sinceIso = new Date(windowStartMs).toISOString();

  // Pull reader name + first-sighting timestamp per EPC so we can stamp
  // source attribution alongside the EPC append. `MIN(read_at)` keeps
  // first-sighting wins (matches the cycle-count semantics — we never
  // overwrite an earlier source). `string_agg(DISTINCT d.name)` would
  // be wrong for cross-reader sightings; we pick the reader of the
  // earliest read deterministically via DISTINCT ON.
  const r = await client.query<{
    epc: string;
    reader_name: string;
    first_seen_at: string;
  }>(
    `SELECT DISTINCT ON (upper(cr.epc_hex))
            upper(cr.epc_hex)                         AS epc,
            COALESCE(d.name, 'reader')                AS reader_name,
            to_char(cr.read_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_seen_at
       FROM cdm_reads cr
       JOIN devices d ON d.id = cr.reader_id
      WHERE cr.tenant_id = $1::uuid
        AND d.location_id = $2::uuid
        AND cr.read_at >= $3::timestamptz
        AND cr.passes_formula = true
      ORDER BY upper(cr.epc_hex), cr.read_at ASC`,
    [tenantId, detail.location_id, sinceIso],
  );

  /* Record that this pass ran (even if nothing was missed) so subsequent
     polls within MIN_GAP_MS are skipped. */
  backfillState.set(sessionId, { lastAt: now, firstDone: true });
  if (r.rowCount === 0) return;
  const haveSet = new Set(detail.scanned_epcs.map((e) => e.toUpperCase()));
  const missedRows = r.rows.filter((row) => !haveSet.has(row.epc));
  if (missedRows.length === 0) return;
  const missed = missedRows.map((row) => row.epc);
  // Process through the same pipeline as live SSE-fed scans.
  const results = await ingestCycleCountEpcs(client, {
    tenantId,
    userId,
    sessionId,
    locationId: detail.location_id,
    epcs: missed,
    receivedAt: new Date(),
  });
  if (results.length === 0) return;
  const merged = [
    ...new Set([
      ...detail.scanned_epcs.map((e) => e.toUpperCase()),
      ...results.map((res) => res.epc),
    ]),
  ];
  await client.query(
    `UPDATE cycle_count_sessions
        SET scanned_epcs = $3::jsonb
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, sessionId, JSON.stringify(merged)],
  );
  // Stamp source attribution: each newly-ingested EPC gets the reader
  // name + first-seen timestamp we resolved above. Existing entries in
  // the source map are preserved (first-sighting wins).
  const resultSet = new Set(results.map((res) => res.epc.toUpperCase()));
  await appendSourceSightings(
    client,
    sessionId,
    missedRows
      .filter((row) => resultSet.has(row.epc))
      .map((row) => ({
        epc: row.epc,
        kind: "reader" as const,
        name: row.reader_name,
        ts: row.first_seen_at,
      })),
  );
  detail.scanned_epcs = merged;
}

export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await params;
  const client = await pool.connect();
  let detailOut: NonNullable<Awaited<ReturnType<typeof getSession>>> | null = null;
  let varianceOut: Awaited<ReturnType<typeof classifyVarianceLive>> | null = null;
  try {
    await client.query("BEGIN");
    const detail = await getSession(client, session.tid, id);
    if (!detail) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const variance = await classifyVarianceLive(
      client,
      session.tid,
      detail.expected,
      detail.scanned_epcs,
      detail.location_id,
    );
    await client.query("COMMIT");
    detailOut = detail;
    varianceOut = variance;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }

  /* Backfill SSE-dropped reads OUT OF BAND — runs on its own pool connection
   * after the response goes out. Was blocking the GET response on first open
   * because it scans cdm_reads from session.started_at, which can be tens of
   * thousands of rows. Now the GET is fast (just getSession + variance), and
   * the backfill catches up by the next 10-second poll. */
  void runBackfillAsync(pool, session.tid, id, detailOut, session.sub ?? null);

  return NextResponse.json({ ok: true, session: detailOut, variance: varianceOut });
}

/* Spawns backfill on a fresh pool connection so it survives the GET response. */
async function runBackfillAsync(
  pool: import("pg").Pool,
  tenantId: string,
  sessionId: string,
  detail: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  userId: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await backfillFromCdmReads(client, tenantId, sessionId, detail, userId);
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.warn("[cycle-counts GET] async backfill failed", e);
  } finally {
    client.release();
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSessionSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const { id } = await params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const detail = await updateSession(client, session.tid, id, parsed.data, {
      userId: session.sub ?? null,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, session: detail });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : "Update failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[cycle-counts/sessions PATCH]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
