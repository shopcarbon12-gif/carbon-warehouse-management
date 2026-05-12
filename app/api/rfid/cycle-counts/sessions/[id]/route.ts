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
 * Every GET /sessions/[id] (SWR-polled every 5 s) reconciles by pulling
 * any cdm_reads EPCs since started_at that aren't in scanned_epcs yet,
 * running them through the same ingest pipeline (formula → items upsert
 * → audit), and merging into scanned_epcs. Idempotent — no-op when SSE
 * is keeping up.
 */
async function backfillFromCdmReads(
  client: import("pg").PoolClient,
  tenantId: string,
  sessionId: string,
  detail: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  userId: string | null,
): Promise<void> {
  if (detail.status === "committed" || detail.status === "canceled") return;
  const startedAtIso = new Date(detail.started_at).toISOString();
  const r = await client.query<{ epc: string }>(
    `SELECT DISTINCT upper(cr.epc_hex) AS epc
       FROM cdm_reads cr
       JOIN devices d ON d.id = cr.reader_id
      WHERE cr.tenant_id = $1::uuid
        AND d.location_id = $2::uuid
        AND cr.read_at >= $3::timestamptz
        AND cr.passes_formula = true`,
    [tenantId, detail.location_id, startedAtIso],
  );
  if (r.rowCount === 0) return;
  const haveSet = new Set(detail.scanned_epcs.map((e) => e.toUpperCase()));
  const missed = r.rows.map((row) => row.epc).filter((epc) => !haveSet.has(epc));
  if (missed.length === 0) return;
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
  detail.scanned_epcs = merged;
}

export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const detail = await getSession(client, session.tid, id);
    if (!detail) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // Recover any SSE-dropped reads before computing variance.
    try {
      await backfillFromCdmReads(client, session.tid, id, detail, session.sub ?? null);
    } catch (e) {
      console.warn("[cycle-counts GET] backfill failed (continuing)", e);
    }
    const variance = await classifyVarianceLive(
      client,
      session.tid,
      detail.expected,
      detail.scanned_epcs,
      detail.location_id,
    );
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, session: detail, variance });
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
