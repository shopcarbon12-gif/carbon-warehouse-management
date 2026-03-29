import { NextResponse } from "next/server";
import type { Pool } from "pg";
import type { SessionPayload } from "@/lib/auth";
import { hasAllScopes, scopesForMembershipRole, type AppScope } from "@/lib/auth/roles";
import { getMembershipRole } from "@/lib/queries/membership-role";

/**
 * Returns a 403 JSON response when the session’s membership role lacks scopes.
 * Returns `null` when OK.
 */
export async function requireSessionScopes(
  pool: Pool,
  session: SessionPayload,
  required: readonly AppScope[],
): Promise<NextResponse | null> {
  const role = (await getMembershipRole(pool, session.sub, session.tid)) ?? "member";
  const granted = scopesForMembershipRole(role);
  if (!hasAllScopes(granted, required)) {
    return NextResponse.json({ error: "Forbidden", required }, { status: 403 });
  }
  return null;
}
