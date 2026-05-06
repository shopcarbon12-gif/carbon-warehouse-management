import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import {
  getSession,
  joinSession,
  logEvent,
  MAX_OPERATORS_PER_SESSION,
} from "@/lib/server/add-on-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * POST /api/handheld/add-on-sessions/<id>/join-request
 *
 * Body shapes:
 *   { kind: 'request' }                           → operator B requests to join
 *   { kind: 'respond', approve: true|false,       → owner A approves/declines
 *     requesterUserId, requesterDeviceId }
 */
const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("request"),
    deviceId: z.string().min(1).max(256).optional(),
  }),
  z.object({
    kind: z.literal("respond"),
    approve: z.boolean(),
    requesterUserId: z.string().min(1).max(64).nullable().optional(),
    requesterDeviceId: z.string().min(1).max(256).nullable().optional(),
    deviceId: z.string().min(1).max(256).optional(),
  }),
]);

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const auth = await resolveTenantOrError(req, pool, parsed.data.deviceId);
  if (auth instanceof Response) return auth;

  const session = await getSession(pool, auth.tenantId, id);
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (parsed.data.kind === "request") {
    if (session.state !== "active" && session.state !== "paused") {
      return NextResponse.json({ error: "Session not joinable" }, { status: 409 });
    }
    const total = 1 + session.joined_user_ids.length;
    if (total >= MAX_OPERATORS_PER_SESSION) {
      return NextResponse.json({ error: "Session full (max 3 operators)" }, { status: 409 });
    }
    await logEvent(pool, {
      sessionId: id,
      tenantId: auth.tenantId,
      userId: auth.userId,
      deviceId: auth.deviceId,
      eventType: "join_requested",
      payload: { requester_user_id: auth.userId, requester_device_id: auth.deviceId },
    });
    // SSE channel will deliver the request to the owner.
    return NextResponse.json({ pending: true });
  }

  // 'respond' — only the owner can approve/decline.
  if (auth.userId !== session.owner_user_id) {
    return NextResponse.json({ error: "Only the owner can respond" }, { status: 403 });
  }

  if (parsed.data.approve) {
    const updated = await joinSession(
      pool,
      auth.tenantId,
      id,
      parsed.data.requesterUserId ?? null,
      parsed.data.requesterDeviceId ?? null,
    );
    if (!updated) {
      return NextResponse.json(
        { error: "Cannot join (capacity or invalid session)" },
        { status: 409 },
      );
    }
    await logEvent(pool, {
      sessionId: id,
      tenantId: auth.tenantId,
      userId: auth.userId,
      deviceId: auth.deviceId,
      eventType: "join_approved",
      payload: {
        requester_user_id: parsed.data.requesterUserId,
        requester_device_id: parsed.data.requesterDeviceId,
      },
    });
    return NextResponse.json({ approved: true, session: updated });
  }

  await logEvent(pool, {
    sessionId: id,
    tenantId: auth.tenantId,
    userId: auth.userId,
    deviceId: auth.deviceId,
    eventType: "join_declined",
    payload: {
      requester_user_id: parsed.data.requesterUserId,
      requester_device_id: parsed.data.requesterDeviceId,
    },
  });
  return NextResponse.json({ approved: false });
}
