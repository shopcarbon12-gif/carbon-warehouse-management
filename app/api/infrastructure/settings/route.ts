import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import {
  getInfrastructureSettings,
  updateInfrastructureSettings,
} from "@/lib/server/infrastructure-settings";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const settings = await getInfrastructureSettings(pool, session.tid);
    return NextResponse.json(settings, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[infrastructure/settings GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  // Writing tenant-wide integration settings (Lightspeed endpoint, RFID bit
  // layout, printers) is an admin action — a member/warehouse_ops/handheld user
  // must not be able to repoint the Lightspeed token refresh or corrupt EPCs.
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const settings = await updateInfrastructureSettings(client, session.tid, json);
    await client.query("COMMIT");
    return NextResponse.json(settings);
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
    console.error("[infrastructure/settings POST]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}

export const POST = withActivity("infrastructure/settings", POST_handler);
