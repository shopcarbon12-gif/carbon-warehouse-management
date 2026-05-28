import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import {
  createTenantPosManager,
  listTenantPosUsers,
} from "@/lib/queries/settings-pos-users";

/**
 * GET /api/settings/access/pos-users
 * Returns POS users (users joined with pos_employees) for the caller's
 * tenant. Empty list if the POS schema hasn't been applied to this DB.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  try {
    const rows = await listTenantPosUsers(pool, session.tid);
    return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[access/pos-users GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}

const postSchema = z.object({
  email: z.string().email().max(256),
  password: z.string().min(6).max(128),
  pin: z.string().regex(/^\d{4}$/, "PIN must be 4 digits"),
  locationId: z.string().uuid(),
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
});

/**
 * POST /api/settings/access/pos-users
 * Provisions a POS *Manager* for a single location. The role is implicitly
 * the seeded "Manager" POS role — this endpoint exists so the WMS admin can
 * stand up a per-location manager who then logs into the POS to add
 * cashiers from there. Cashiers themselves are created from the POS
 * back-office, not here.
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
    const result = await createTenantPosManager(pool, session.tid, parsed.data);
    if (!result.ok) {
      const map: Record<typeof result.code, { status: number; msg: string }> = {
        email_taken: { status: 409, msg: "A user with that email already exists" },
        pos_employees_missing: {
          status: 503,
          msg: "POS schema not applied. Run the POS migrations first.",
        },
        manager_role_missing: {
          status: 503,
          msg: "POS Manager role not seeded. Re-run migration 0057_pos_access.sql.",
        },
        location_invalid: { status: 400, msg: "Location not found for this tenant" },
      };
      const m = map[result.code];
      return NextResponse.json({ error: m.msg }, { status: m.status });
    }
    return NextResponse.json({ id: result.id }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Create failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[access/pos-users POST]", e);
    return NextResponse.json({ error: "Create failed" }, { status: 500 });
  }
}
