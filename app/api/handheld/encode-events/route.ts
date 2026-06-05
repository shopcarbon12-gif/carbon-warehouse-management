import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import { shortName } from "@/lib/format-name";

/**
 * Phase 3 — Re-encode reports for the handheld Inventory → Reports tile.
 *
 * Returns the operator's recent encode_events for the active session
 * tenant + location, newest first. The mobile screen wraps each row as
 * a card showing old EPC, new EPC, SKU, system id, serial, status
 * (`ok`, `write_failed`, `not_found`, …), and the timestamp.
 *
 * Auth: dual via [resolveTenantOrError] (session JWT OR edge key). Scope
 * is taken from the session's active location (`session.lid`) — the
 * `encode_events.warehouse_id` column stores `session.lid` per the
 * existing `encode-claim` and `/api/v1/rfid/encode-events` writers.
 *
 * Query params:
 *   ?limit=1..500     (default: 200)
 *   ?status=ok        (optional filter; default: any)
 *   ?deviceId=...     (passes through to resolveTenantOrError for the
 *                      edge-key path; ignored on session auth)
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const url = new URL(req.url);
  const deviceId = url.searchParams.get("deviceId") ?? undefined;
  const auth = await resolveTenantOrError(req, pool, deviceId);
  if (auth instanceof Response) return auth;

  const limit = Math.min(
    500,
    Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200),
  );
  const statusFilter = url.searchParams.get("status")?.trim().toLowerCase();

  // The encode_events table doesn't store tenant_id directly; warehouse_id
  // (location uuid as text) is the scope. We resolve `session.lid` from
  // the JWT via [resolveTenantOrError] and only return rows tagged with
  // that location. Cross-tenant containment also enforced by the
  // `EXISTS` join against locations.tenant_id.
  try {
    const params: unknown[] = [auth.tenantId];
    const filters: string[] = [
      `EXISTS (
         SELECT 1 FROM locations l
          WHERE l.id::text = ee.warehouse_id
            AND l.tenant_id = $1::uuid
       )`,
    ];
    if (statusFilter) {
      params.push(statusFilter);
      filters.push(`LOWER(ee.status) = $${params.length}::text`);
    }
    params.push(limit);
    const rows = await pool.query<{
      id: string;
      old_epc: string | null;
      new_epc: string | null;
      system_id: string | null;
      serial: string | null;
      custom_sku: string | null;
      warehouse_id: string | null;
      device_id: string | null;
      status: string;
      encoded_at: Date | null;
      created_at: Date;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>(
      `SELECT ee.id::text,
              ee.old_epc,
              ee.new_epc,
              ee.system_id::text AS system_id,
              ee.serial::text AS serial,
              ee.custom_sku,
              ee.warehouse_id,
              ee.device_id,
              ee.status,
              ee.encoded_at,
              ee.created_at,
              u.first_name, u.last_name, u.email
         FROM encode_events ee
         LEFT JOIN users u ON u.id = ee.created_by
        WHERE ${filters.join(" AND ")}
        ORDER BY COALESCE(ee.encoded_at, ee.created_at) DESC NULLS LAST
        LIMIT $${params.length}::int`,
      params,
    );

    return NextResponse.json(
      {
        rows: rows.rows.map((r) => ({
          id: r.id,
          oldEpc: r.old_epc,
          newEpc: r.new_epc,
          systemId: r.system_id,
          serial: r.serial,
          customSku: r.custom_sku,
          warehouseId: r.warehouse_id,
          deviceId: r.device_id,
          status: r.status,
          encodedAt: r.encoded_at?.toISOString() ?? null,
          createdAt: r.created_at.toISOString(),
          by: shortName(r.first_name, r.last_name, r.email),
        })),
        count: rows.rowCount ?? 0,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[handheld/encode-events GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
