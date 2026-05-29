import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listAuthorizedHandheldsForTenant } from "@/lib/server/infrastructure-devices";
import { enqueueEpcsForDevice } from "@/lib/queries/device-epc-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Location-scoped fan-out of EPCs to every authorized handheld at the
 * operator's active location. Replaces the per-device picker for flows
 * where the operator doesn't know (or care) which handheld will pick up —
 * e.g. the catalog "Defective EPCs" modal: any handheld at the warehouse
 * should be able to walk over and locate the tag via Cloud + Geiger.
 *
 * Under the hood we still use the per-device queue (device_epc_queue) —
 * we just insert one copy per handheld so each handheld's Cloud + Geiger
 * screen shows the same EPCs independently. No new schema needed.
 *
 * POST /api/handhelds/epc-queue
 *   Body : { epcs: string[] }
 *   Auth : session
 *   Returns { ok, enqueued, handhelds, location }
 */

const bodySchema = z.object({
  epcs: z.array(z.string().min(4).max(64)).min(1).max(5000),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.lid) {
    return NextResponse.json(
      { error: "No active location on this session — pick one first." },
      { status: 400 },
    );
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  /* Active location must belong to the operator's tenant — listDevices...
     filters by tenant, but we still pull the location row for the toast
     so the operator sees which location they hit (helpful when the same
     account has multiple). */
  const loc = await pool.query<{ id: string; code: string; name: string }>(
    `SELECT id::text, code, name
       FROM locations
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      LIMIT 1`,
    [session.lid, session.tid],
  );
  if (!loc.rows[0]) {
    return NextResponse.json({ error: "Active location not found" }, { status: 404 });
  }

  const handhelds = await listAuthorizedHandheldsForTenant(pool, session.tid, session.lid);
  if (handhelds.length === 0) {
    return NextResponse.json(
      {
        ok: true,
        enqueued: 0,
        handhelds: 0,
        location: loc.rows[0],
        warning: "No authorized handhelds at this location.",
      },
      { status: 200 },
    );
  }

  /* Sequential fan-out keeps the SQL trivial and the rowCount tally
     accurate. ~Dozens of handhelds at most per location, so the
     round-trip cost is bounded. */
  let total = 0;
  for (const h of handhelds) {
    try {
      const r = await enqueueEpcsForDevice(pool, {
        tenantId: session.tid,
        deviceId: h.id,
        epcs: parsed.data.epcs,
        enqueuedBy: session.sub,
      });
      total += r.enqueued;
    } catch (e) {
      /* Don't fail the whole fan-out for one bad device row — log and
         continue so the other handhelds still receive the queue. */
      console.warn(
        "[handhelds/epc-queue] enqueue failed for device",
        h.id,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return NextResponse.json(
    {
      ok: true,
      enqueued: total,
      handhelds: handhelds.length,
      location: loc.rows[0],
    },
    { status: 201 },
  );
}
