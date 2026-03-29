import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { listBinsWithCounts } from "@/lib/queries/locations";
import {
  upsertBinSchema,
  upsertBin,
} from "@/lib/server/overview-locations";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const lidParam = url.searchParams.get("locationId")?.trim();
  const targetLocationId = lidParam && lidParam.length > 0 ? lidParam : session.lid;

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const ok = await pool.query<{ n: string }>(
      `SELECT 1::text AS n FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
      [targetLocationId, session.tid],
    );
    if (!ok.rows[0]) {
      return NextResponse.json({ error: "Location not found" }, { status: 404 });
    }

    const rows = await listBinsWithCounts(pool, targetLocationId);

    const managed = url.searchParams.get("managed") === "1";
    if (managed) {
      const meta = await pool.query<{ code: string; name: string }>(
        `SELECT code, name FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
        [targetLocationId, session.tid],
      );
      const m = meta.rows[0];
      return NextResponse.json({
        locationId: targetLocationId,
        locationCode: m?.code ?? null,
        locationName: m?.name ?? null,
        bins: rows,
      });
    }

    return NextResponse.json(rows);
  } catch (e) {
    console.error("[locations/bins]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = upsertBinSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { id } = await upsertBin(client, session.tid, parsed.data);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : "Save failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[locations/bins POST]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
