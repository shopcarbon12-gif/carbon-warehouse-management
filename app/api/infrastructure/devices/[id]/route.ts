import { NextResponse } from "next/server";
import { z } from "zod";
import { SCOPES } from "@/lib/auth/roles";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { deleteDevice } from "@/lib/server/infrastructure-devices";
import { setDeviceAuthorization } from "@/lib/queries/enterprise-devices";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  androidId: z.string().max(128).nullable().optional(),
  isAuthorized: z.boolean().optional(),
});

export async function PATCH(req: Request, ctx: Ctx) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid device id" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (parsed.data.androidId === undefined && parsed.data.isAuthorized === undefined) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  try {
    const ok = await setDeviceAuthorization(pool, session.tid, id, {
      android_id: parsed.data.androidId,
      is_authorized: parsed.data.isAuthorized,
    });
    if (!ok) {
      return NextResponse.json({ error: "Device not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[infrastructure/devices PATCH]", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid device id" }, { status: 400 });
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
    await deleteDevice(client, session.tid, id);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : "Delete failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[infrastructure/devices DELETE]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
