import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

/** Placeholder: wire LS Retail inventory API + map into `custom_skus.ls_on_hand_total`. */
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
      "Lightspeed pull is not wired to the LS API in this build. Next step: use shop credentials + inventory endpoints, then UPDATE custom_skus.ls_on_hand_total.",
  });
}
