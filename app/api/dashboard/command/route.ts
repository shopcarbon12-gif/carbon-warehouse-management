import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { getCommandCenterKpis } from "@/lib/queries/dashboard-command";
import { listActivity } from "@/lib/server/activity-feed";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const kpis = await getCommandCenterKpis(pool, session.lid, session.tid);
    // Same feed as Reports → Activity history: people's actions in plain
    // English, reader zone moves left out. A feed failure must not blank
    // the KPIs, so it degrades to an empty list.
    const activity = await listActivity(pool, session.tid, { limit: 15 })
      // Every signed-in user sees the dashboard; the full request record
      // (IP, body) stays on the manager-only Activity history page.
      .then((page) => page.rows.slice(0, 10).map((r) => ({ ...r, details: {}, names: {} })))
      .catch((e) => {
        console.error("[dashboard/command] activity", e);
        return [];
      });
    return NextResponse.json(
      { kpis, activity },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[dashboard/command]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 503 });
  }
}
