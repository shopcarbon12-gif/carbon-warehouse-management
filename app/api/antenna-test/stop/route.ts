import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import {
  endSession,
  getSession,
} from "@/lib/server/antenna-test-sessions";
import { publishAntennaTestLifecycle } from "@/lib/server/antenna-test-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ sessionId: z.string().uuid() });

export async function POST(req: Request) {
  const userSession = await getSessionFromRequest(req);
  if (!userSession) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  const s = getSession(parsed.data.sessionId);
  if (!s) {
    return NextResponse.json({ error: "Session not found or already ended" }, { status: 404 });
  }
  if (s.tenantId !== userSession.tid) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Persist test outcome to the antenna row. Pass = any reads captured;
  // Fail = zero reads. Hardware Config's antenna-online derivation honors
  // last_test_passed permanently (no time cap), so a passing test sticks
  // the dot green until a subsequent test fails or the operator re-tests.
  // This is the operator's "I tested it, it works" signal — wired here from
  // the operator-driven /antenna-test page (the agent's own auto-test
  // result endpoint was the only writer before; now both paths persist).
  //
  // rawMode (admin reader-raw-test) suppresses this write so a diagnostic
  // run never green-pins an antenna based on a test the operator wasn't
  // asserting "this antenna works" with.
  const passed = s.totalReadsCount > 0;
  const pool = getPool();
  if (pool && !s.rawMode) {
    try {
      await pool.query(
        `UPDATE devices SET
            last_test_at         = now(),
            last_test_passed     = $1::boolean,
            last_test_epc_count  = $2::int,
            test_pending_at      = NULL,
            updated_at           = now()
          WHERE id = $3::uuid`,
        [passed, s.totalReadsCount, s.antennaId],
      );
    } catch (e) {
      console.warn("[antenna-test/stop] failed to persist test outcome", e);
    }
  }

  endSession(s.id);
  publishAntennaTestLifecycle(s.id, "ended", "stopped_by_operator");
  return NextResponse.json({ ok: true, passed, observedEpcCount: s.totalReadsCount });
}
