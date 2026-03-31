import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listTenantLocationsWithBins } from "@/lib/server/overview-locations";
import { getPgErrorMeta, hintForPgCode } from "@/lib/server/pg-error";

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
    const locations = await listTenantLocationsWithBins(pool, session.tid);
    return NextResponse.json({ locations }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const meta = getPgErrorMeta(e);
    console.error("[overview/locations]", meta.code ?? "", meta.message, e);
    const expose = String(process.env.WMS_EXPOSE_DB_ERRORS ?? "").trim() === "1";
    return NextResponse.json(
      {
        error: "Query failed",
        hint: hintForPgCode(meta.code),
        ...(expose ? { db: { code: meta.code ?? null, message: meta.message.slice(0, 800) } } : {}),
      },
      { status: 500 },
    );
  }
}
