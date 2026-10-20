import { NextResponse } from "next/server";
import type { Pool } from "pg";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import type { SessionPayload } from "@/lib/auth";

/** Shopify → Email Popup APIs are for admins, like the rest of the Shopify menu. */
export async function welcomeAdminGuard(
  req: Request,
): Promise<{ error: NextResponse } | { session: SessionPayload; pool: Pool }> {
  const session = await getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const pool = getPool();
  if (!pool) return { error: NextResponse.json({ error: "Database unavailable" }, { status: 503 }) };
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return { error: denied };
  return { session, pool };
}
