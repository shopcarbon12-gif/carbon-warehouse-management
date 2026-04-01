import { NextResponse } from "next/server";
import { z } from "zod";
import { SCOPES } from "@/lib/auth/roles";
import { getPool } from "@/lib/db";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { generateOrlandoWarehouseBinCodes } from "@/lib/server/orlando-bin-grid";

const bodySchema = z.object({
  locationCode: z.string().trim().min(1).max(32).optional(),
});

/**
 * Admin: insert the same Orlando bin grid as local seed (`ON CONFLICT DO NOTHING`).
 * POST body optional: `{ "locationCode": "001" }` (default 001).
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let locationCode = "001";
  const text = await req.text();
  if (text.trim()) {
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
    }
    if (parsed.data.locationCode) locationCode = parsed.data.locationCode;
  }

  const loc = await pool.query<{ id: string; code: string; name: string }>(
    `SELECT id::text, code, name FROM locations WHERE tenant_id = $1::uuid AND code = $2 LIMIT 1`,
    [session.tid, locationCode],
  );
  if (!loc.rows[0]) {
    return NextResponse.json({ error: `Location not found for tenant: ${locationCode}` }, { status: 404 });
  }

  const locationId = loc.rows[0].id;

  const before = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM bins WHERE location_id = $1::uuid AND archived_at IS NULL`,
    [locationId],
  );
  const nBefore = Number(before.rows[0]?.n ?? 0);

  const codes = generateOrlandoWarehouseBinCodes();
  await pool.query(
    `INSERT INTO bins (location_id, code)
     SELECT $1::uuid, unnest($2::text[])
     ON CONFLICT (location_id, code) DO NOTHING`,
    [locationId, codes],
  );

  const after = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM bins WHERE location_id = $1::uuid AND archived_at IS NULL`,
    [locationId],
  );
  const nAfter = Number(after.rows[0]?.n ?? 0);

  return NextResponse.json({
    ok: true,
    location: { code: loc.rows[0].code, name: loc.rows[0].name },
    codesInGrid: codes.length,
    binsBefore: nBefore,
    binsAfter: nAfter,
    inserted: nAfter - nBefore,
  });
}
