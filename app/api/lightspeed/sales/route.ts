import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import {
  credentialsLookUsableForRSeries,
  getLightspeedCredentialsForSync,
} from "@/lib/server/infrastructure-settings-table";
import { rseriesGetJson } from "@/lib/server/lightspeed-rseries-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

/**
 * Recent Lightspeed R-Series sales (read-only). Query: `limit` (default 25, max 100), `offset`.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "25", 10) || 25));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);

  const creds = await getLightspeedCredentialsForSync(pool, session.tid);
  if (!credentialsLookUsableForRSeries(creds)) {
    return NextResponse.json(
      {
        error:
          "R-Series credentials incomplete. Set LS_ACCOUNT_ID and OAuth env vars (or use Connect Lightspeed).",
      },
      { status: 400 },
    );
  }

  const result = await rseriesGetJson(creds, "Sale", {
    limit,
    offset,
    load_relations: '["SaleLines"]',
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: "Lightspeed Sale request failed", status: result.status, body: result.body },
      { status: 502 },
    );
  }

  const body = result.body as Record<string, unknown>;
  const raw = body.Sale;
  const sales = toArray(raw as Record<string, unknown> | Record<string, unknown>[] | undefined);

  const rows = sales.map((s) => ({
    saleID: String(s.saleID ?? ""),
    timeStamp: String(s.timeStamp ?? s.createTime ?? ""),
    calcTotal: String(s.calcTotal ?? s.total ?? ""),
    completed: String(s.completed ?? ""),
    voided: String(s.voided ?? ""),
    referenceNumber: String(s.referenceNumber ?? ""),
    shopID: String(s.shopID ?? ""),
    customerID: String(s.customerID ?? ""),
  }));

  const attrs = body["@attributes"] as Record<string, unknown> | undefined;
  const totalCount = Number.parseInt(String(attrs?.count ?? ""), 10);

  return NextResponse.json({
    ok: true,
    limit,
    offset,
    totalCount: Number.isFinite(totalCount) ? totalCount : rows.length,
    sales: rows,
  });
}
