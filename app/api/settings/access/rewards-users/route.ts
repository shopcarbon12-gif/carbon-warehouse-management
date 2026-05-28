import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import {
  createTenantRewardsUser,
  listTenantRewardsUsers,
} from "@/lib/queries/settings-rewards-users";

/**
 * GET /api/settings/access/rewards-users
 * List rewards users (users joined with rewards_employees) for the caller's
 * tenant. Empty list if the rewards schema (migration 0079) hasn't been
 * applied to this DB.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  try {
    const rows = await listTenantRewardsUsers(pool, session.tid);
    return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[access/rewards-users GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}

const postSchema = z.object({
  email: z.string().email().max(256),
  password: z.string().min(6).max(128),
  roleName: z.enum(["Super Admin", "Manager"]).optional(),
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
});

/**
 * POST /api/settings/access/rewards-users
 * Provision a rewards user (default role = Manager). No PIN, no per-location.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  try {
    const result = await createTenantRewardsUser(pool, session.tid, parsed.data);
    if (!result.ok) {
      const map: Record<typeof result.code, { status: number; msg: string }> = {
        email_taken: { status: 409, msg: "A user with that email already exists" },
        rewards_employees_missing: {
          status: 503,
          msg: "Rewards schema not applied. Run migration 0079_rewards_access.sql.",
        },
        role_missing: {
          status: 503,
          msg: "Rewards role not seeded. Re-run migration 0079_rewards_access.sql.",
        },
        role_not_allowed: {
          status: 400,
          msg: "Rewards roles are limited to Super Admin and Manager.",
        },
      };
      const m = map[result.code];
      return NextResponse.json({ error: m.msg }, { status: m.status });
    }
    return NextResponse.json({ id: result.id }, { status: 201 });
  } catch (e) {
    console.error("[access/rewards-users POST]", e);
    return NextResponse.json({ error: "Create failed" }, { status: 500 });
  }
}
