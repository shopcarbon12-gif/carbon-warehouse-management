import { NextResponse } from "next/server";
import { z } from "zod";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { importCatalogCsvRows } from "@/lib/server/catalog-manual";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  csvText: z.string().min(1).max(2_000_000),
});

export async function POST(req: Request) {
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

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  try {
    const { created, results } = await importCatalogCsvRows(pool, parsed.data.csvText);
    const failed = results.filter((r) => !r.ok);
    return NextResponse.json({
      ok: true,
      rowsCreated: created,
      rowResults: results,
      errorsPreview: failed.slice(0, 25),
    });
  } catch (e) {
    console.error("[catalog/import-csv POST]", e);
    return NextResponse.json({ error: "Import failed" }, { status: 500 });
  }
}
