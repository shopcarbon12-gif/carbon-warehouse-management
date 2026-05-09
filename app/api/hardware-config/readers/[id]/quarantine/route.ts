import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { endSessionForReader } from "@/lib/server/scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mark / un-mark a reader as chassis-broken (quarantine).
 *
 * POST   { reason: "..." }   — set the quarantine flag, force-end any active
 *                              scan-session for this reader, log to audit.
 *                              Reason is required, free text. Operator-visible.
 * DELETE                     — clear the quarantine flag (un-quarantine).
 *
 * Admin-only. Active-location guard same as pause/resume.
 *
 * Side effect: the agent's next config-pull (~5 s) will see
 * `quarantine_reason` populated and the supervisor will skip this reader
 * entirely. Any in-flight scan-session is force-ended here so the supervisor
 * doesn't keep the reader alive on the 250 ms session-poll path before the
 * config-pull lands.
 */

const postBodySchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Reason must be at least 3 characters")
    .max(500, "Reason too long"),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(session.role))
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = postBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const { id } = await ctx.params;
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const r = await pool.query<{ id: string }>(
    `UPDATE devices d
        SET quarantine_reason = $5,
            quarantined_at = now(),
            quarantined_by = $3::uuid,
            updated_at = now()
       FROM locations l
      WHERE d.id = $1::uuid
        AND d.location_id = l.id
        AND l.tenant_id = $2::uuid
        AND ($4::uuid IS NULL OR d.location_id = $4::uuid)
        AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
      RETURNING d.id::text`,
    [id, session.tid, session.sub, session.lid ?? null, parsed.data.reason],
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ error: "Reader not found" }, { status: 404 });
  }

  // Force-end any in-flight scan-session for this reader so the agent's
  // 250 ms session-poll stops keeping it awake before the next config
  // bundle lands. The bundle-side effective_paused will lock it for good
  // a few seconds later.
  endSessionForReader(id);

  await pool.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
       VALUES ($1::uuid, $2::uuid, 'cdm_reader_quarantine', 'devices', $3::jsonb)`,
    [
      session.tid,
      session.sub,
      JSON.stringify({ device_id: id, reason: parsed.data.reason }),
    ],
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(
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

  const r = await pool.query<{ id: string }>(
    `UPDATE devices d
        SET quarantine_reason = NULL,
            quarantined_at = NULL,
            quarantined_by = NULL,
            updated_at = now()
       FROM locations l
      WHERE d.id = $1::uuid
        AND d.location_id = l.id
        AND l.tenant_id = $2::uuid
        AND ($4::uuid IS NULL OR d.location_id = $4::uuid)
        AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
      RETURNING d.id::text`,
    [id, session.tid, session.sub, session.lid ?? null],
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ error: "Reader not found" }, { status: 404 });
  }
  await pool.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
       VALUES ($1::uuid, $2::uuid, 'cdm_reader_unquarantine', 'devices', $3::jsonb)`,
    [session.tid, session.sub, JSON.stringify({ device_id: id })],
  );
  return NextResponse.json({ ok: true });
}
