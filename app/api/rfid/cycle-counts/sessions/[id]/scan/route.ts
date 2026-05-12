import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { ingestCycleCountEpcs } from "@/lib/server/rfid-cycle-count-scan";
import {
  classifyVarianceLive,
  getSession as getCycleSession,
} from "@/lib/server/rfid-cycle-count-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  epcs: z
    .array(z.string().transform((s) => s.replace(/\s/g, "").toUpperCase()))
    .min(1)
    .max(500),
});

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
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
  const parsed = bodySchema.safeParse(json);
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
    const cur = await getCycleSession(client, session.tid, id);
    if (!cur) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (cur.status === "committed" || cur.status === "canceled") {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "Session is closed; reads are no longer accepted" },
        { status: 400 },
      );
    }

    const results = await ingestCycleCountEpcs(client, {
      tenantId: session.tid,
      userId: session.sub ?? null,
      sessionId: id,
      locationId: cur.location_id,
      epcs: parsed.data.epcs,
      receivedAt: new Date(),
    });

    // Append new EPCs to the session's running scanned_epcs list so the
    // expected/variance views (and the commit step) see them. Dedup happens
    // in updateSession via dedupeEpcs.
    if (results.length > 0) {
      const merged = [
        ...new Set([
          ...cur.scanned_epcs.map((e) => e.toUpperCase()),
          ...results.map((r) => r.epc),
        ]),
      ];
      await client.query(
        `UPDATE cycle_count_sessions
            SET scanned_epcs = $3::jsonb
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [session.tid, id, JSON.stringify(merged)],
      );
    }

    // Refetch the session + variance in the same transaction so the workspace
    // can show new rows the instant the POST returns — no extra SWR round
    // trip needed.
    const refreshed = await getCycleSession(client, session.tid, id);
    const variance = refreshed
      ? await classifyVarianceLive(
          client,
          session.tid,
          refreshed.expected,
          refreshed.scanned_epcs,
          refreshed.location_id,
        )
      : null;

    await client.query("COMMIT");
    return NextResponse.json({
      ok: true,
      results,
      session: refreshed,
      variance,
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[cycle-counts scan]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Scan failed" },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}
