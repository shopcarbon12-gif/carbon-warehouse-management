import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { listActivity, type ActivityRow } from "@/lib/server/activity-feed";

export const dynamic = "force-dynamic";

/**
 * GET /api/reports/activity — the Activity history feed.
 *   ?limit &cursor=<ts>|<id> &from &to (ISO) &user &module &source &q
 *   &readers=1 (include reader zone moves) &failed=1 &format=csv
 *   ?facets=1 → the tenant's users, for the filter.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.MANAGER]);
  if (denied) return denied;

  const sp = new URL(req.url).searchParams;

  if (sp.get("facets") === "1") {
    const r = await pool.query<{ id: string; email: string; name: string | null }>(
      `SELECT u.id::text, u.email,
              nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS name
       FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE m.tenant_id = $1::uuid
       ORDER BY coalesce(nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), ''), u.email)`,
      [session.tid],
    );
    return NextResponse.json({ users: r.rows }, { headers: { "Cache-Control": "no-store" } });
  }

  const csv = sp.get("format") === "csv";
  const cursorRaw = sp.get("cursor");
  const sep = cursorRaw?.lastIndexOf("|") ?? -1;
  const uuidOk = (v: string | null) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : null);

  try {
    const filters = {
      limit: csv ? 300 : Number.parseInt(sp.get("limit") ?? "100", 10) || 100,
      cursor: cursorRaw && sep > 0 ? { ts: cursorRaw.slice(0, sep), id: cursorRaw.slice(sep + 1) } : null,
      from: sp.get("from"),
      to: sp.get("to"),
      userId: uuidOk(sp.get("user")),
      module: sp.get("module"),
      source: sp.get("source"),
      q: sp.get("q"),
      readers: sp.get("readers") === "1",
      failedOnly: sp.get("failed") === "1",
    };

    if (!csv) {
      const page = await listActivity(pool, session.tid, filters);
      return NextResponse.json(
        { rows: page.rows, nextCursor: page.nextCursor ? `${page.nextCursor.ts}|${page.nextCursor.id}` : null },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // CSV: walk pages up to 5,000 rows.
    const all: ActivityRow[] = [];
    let cursor = filters.cursor;
    for (let i = 0; i < 17 && all.length < 5000; i++) {
      const page = await listActivity(pool, session.tid, { ...filters, cursor });
      all.push(...page.rows);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return new Response(toCsv(all), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("[reports/activity]", e);
    const msg = e instanceof Error && /statement timeout/i.test(e.message)
      ? "This search took too long. Narrow the dates or turn off reader movements."
      : "Could not load activity";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function cell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: ActivityRow[]): string {
  const head = ["When (UTC)", "User", "Email", "Module", "Action", "Change / summary", "EPC", "SKU", "Product", "Colour", "Size", "Items", "Source", "Source detail", "Outcome", "HTTP status", "Error", "Reason"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.at,
        r.actor,
        r.user?.email ?? "",
        r.module,
        r.action,
        r.summary ?? "",
        r.item?.epc ?? "",
        r.item?.sku ?? "",
        r.item?.product ?? "",
        r.item?.color ?? "",
        r.item?.size ?? "",
        r.itemCount ?? "",
        r.source,
        r.sourceDetail ?? "",
        r.outcome,
        r.status ?? "",
        r.error ?? "",
        r.reason ?? "",
      ].map(cell).join(","),
    );
  }
  return "﻿" + lines.join("\n") + "\n";
}
