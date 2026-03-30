import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

/** Placeholder: push selected SKU variance corrections to Lightspeed. */
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  return NextResponse.json({
    ok: true,
    stub: true,
    message:
      "Lightspeed push stub. Implement inventory adjustment / transfer completion calls against your LS account.",
  });
}
