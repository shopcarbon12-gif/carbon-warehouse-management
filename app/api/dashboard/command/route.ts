import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { getCommandCenterKpis } from "@/lib/queries/dashboard-command";
import { listActivity, type ActivityRow } from "@/lib/server/activity-feed";

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
    const activity = await listActivity(pool, session.tid, { limit: 150, changesOnly: true })
      .then((page) => groupRuns(page.rows).slice(0, 10))
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

/**
 * One line per burst: rows from the same person doing the same thing (same
 * action, same before → after, same source) within two minutes collapse into
 * one entry with a count — a 50-tag bulk status change is one line, not 50.
 * Every signed-in user sees the dashboard, so the full request record (IP,
 * body) is dropped; it stays on the manager-only Activity history page.
 */
function groupRuns(rows: ActivityRow[]): (ActivityRow & { groupCount: number })[] {
  const out: (ActivityRow & { groupCount: number })[] = [];
  const keyOf = (r: ActivityRow) =>
    [r.actor, r.module, r.action, r.change?.from, r.change?.to, r.change ? "" : r.summary, r.source, r.sourceDetail].join("|");
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && keyOf(last) === keyOf(r) && Date.parse(last.at) - Date.parse(r.at) <= 120_000) {
      last.groupCount += r.itemCount ?? 1;
      const a = last.item;
      const b = r.item;
      if (a && b && (a.product !== b.product || a.color !== b.color || a.size !== b.size)) {
        last.item = a.product && a.product === b.product ? { product: a.product } : null;
      } else if (a && b && a.epc !== b.epc) {
        last.item = { ...a, epc: null };
      }
      continue;
    }
    out.push({ ...r, details: {}, names: {}, groupCount: r.itemCount ?? 1 });
  }
  return out;
}
