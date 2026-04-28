import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import {
  deleteReader,
  getDeviceById,
  upsertReader,
  upsertReaderSchema,
} from "@/lib/server/cdm-devices";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  const { id } = await params;
  const reader = await getDeviceById(pool, session.tid, id);
  if (!reader) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ reader }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: Request, { params }: Ctx) {
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

  const { id } = await params;
  const parsed = upsertReaderSchema.safeParse({ ...(json as object), id });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await upsertReader(client, session.tid, parsed.data);
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
    console.error("[hardware-config/readers PATCH]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { id } = await params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { deleted } = await deleteReader(client, session.tid, id);
    await client.query("COMMIT");
    if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[hardware-config/readers DELETE]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Delete failed" },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}
