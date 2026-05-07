import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ driver: z.enum(["stream", "console"]) });

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(session.role))
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });

  const { id } = await ctx.params;
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

  // Active-location guard.
  const r = await pool.query<{ id: string }>(
    `UPDATE devices d
        SET config = jsonb_set(COALESCE(d.config, '{}'::jsonb), '{monsoon_driver}', to_jsonb($3::text), true),
            updated_at = now()
       FROM locations l
      WHERE d.id = $1::uuid
        AND d.location_id = l.id
        AND l.tenant_id = $2::uuid
        AND ($4::uuid IS NULL OR d.location_id = $4::uuid)
        AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
      RETURNING d.id::text`,
    [id, session.tid, parsed.data.driver, session.lid ?? null],
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ error: "Reader not found" }, { status: 404 });
  }
  await pool.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
       VALUES ($1::uuid, $2::uuid, 'cdm_reader_set_monsoon_driver', 'devices', $3::jsonb)`,
    [session.tid, session.sub, JSON.stringify({ device_id: id, driver: parsed.data.driver })],
  );
  return NextResponse.json({ ok: true, driver: parsed.data.driver });
}
