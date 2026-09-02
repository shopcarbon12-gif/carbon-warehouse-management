import { NextResponse } from "next/server";
import { z } from "zod";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { decodeEpc, formatSystemId, type EpcConfig } from "@/lib/server/epc-decode";
import { labelNameForWmsStatus } from "@/lib/server/wms-status-to-label-name";
import { DEFECTIVE_SCOPE_CTE, DEFECTIVE_SCOPE_WHERE } from "@/lib/server/defective-epc-scope";

/**
 * GET → List of items in `tag_killed` status that haven't been dismissed
 *       OR have been re-scanned since being dismissed (so they re-appear).
 *       For the Defective EPC's modal under /inventory/catalog → More.
 *
 * POST /dismiss → Sets `defective_acknowledged_at = now()` for the given
 *       EPCs. Pure UI gesture — does NOT change the tag's status. If the
 *       same EPC is scanned again and is still defective, the popup brings
 *       it back automatically (because `last_seen_at > defective_acknowledged_at`).
 *
 * Both endpoints are admin-scope only.
 */

type DefectiveEpcRow = {
  epc: string;
  system_id_raw: string | null;
  system_id_padded: string;
  serial_raw: string | null;
  decode_reason: string | null;
  first_scanned_at: string | null;
  last_seen_at: string | null;
  source: string | null;
  source_device_label: string | null;
  status: string;
  status_label: string;
};

const MAX_ROWS = 1000;

async function loadEpcConfig(
  pool: NonNullable<ReturnType<typeof getPool>>,
  tenantId: string,
): Promise<EpcConfig | null> {
  const r = await pool.query<{
    prefix_hex: string;
    prefix_bits: number;
    asset_bits: number;
    serial_bits: number;
    asset_padding_digits: number;
  }>(
    `SELECT prefix_hex, prefix_bits, asset_bits, serial_bits, asset_padding_digits
       FROM tenant_epc_config WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  if (r.rowCount === 0 || !r.rows[0]) return null;
  const row = r.rows[0];
  return {
    prefixHex: row.prefix_hex,
    prefixBits: row.prefix_bits,
    assetBits: row.asset_bits,
    serialBits: row.serial_bits,
    assetPaddingDigits: row.asset_padding_digits,
  };
}

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const config = await loadEpcConfig(pool, session.tid);

  // Tag-killed items at the user's *active location*. Matches the dashboard
  // KPI scope so the modal count and the dashboard tile agree.
  const r = await pool.query<{
    epc: string;
    serial_number: string;
    status: string;
    first_scanned_at: string | null;
    last_seen_at: string | null;
    source: string | null;
    source_device_label: string | null;
  }>(
    `WITH ${DEFECTIVE_SCOPE_CTE}
     SELECT i.epc,
            i.serial_number::text AS serial_number,
            i.status,
            i.first_scanned_at,
            i.last_seen_at,
            i.source,
            i.source_device_label
       FROM items i
       INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
       WHERE ${DEFECTIVE_SCOPE_WHERE}
       ORDER BY i.first_scanned_at DESC NULLS LAST, i.last_seen_at DESC NULLS LAST
       LIMIT $3::int`,
    [session.tid, session.lid, MAX_ROWS],
  );

  const rows: DefectiveEpcRow[] = r.rows.map((row) => {
    const decoded = config ? decodeEpc(row.epc, config) : null;
    return {
      epc: row.epc,
      system_id_raw: decoded?.valid ? decoded.systemId!.toString() : null,
      system_id_padded: decoded && config
        ? formatSystemId(decoded.valid ? decoded.systemId : null, config)
        : "—",
      serial_raw: decoded?.valid ? decoded.serial!.toString() : row.serial_number,
      decode_reason: decoded && !decoded.valid ? (decoded.reason ?? "invalid") : null,
      first_scanned_at: row.first_scanned_at,
      last_seen_at: row.last_seen_at,
      source: row.source,
      source_device_label: row.source_device_label,
      status: row.status,
      status_label: labelNameForWmsStatus(row.status),
    };
  });

  return NextResponse.json(
    { rows, count: rows.length, capped: rows.length === MAX_ROWS },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const dismissSchema = z.object({
  epcs: z.array(z.string().regex(/^[0-9A-Fa-f]{24}$/, "Invalid EPC")).min(1).max(1000),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = dismissSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }
  const epcs = parsed.data.epcs.map((e) => e.toUpperCase());

  // Location-scoped UPDATE — only modifies rows at the user's active site.
  // Status is intentionally NOT changed; only the dismissal timestamp.
  const r = await pool.query(
    `UPDATE items i
        SET defective_acknowledged_at = now()
       FROM locations l
      WHERE i.location_id = l.id
        AND l.tenant_id = $1::uuid
        AND i.location_id = $2::uuid
        AND i.epc = ANY($3::text[])
        AND i.status = 'tag_killed'`,
    [session.tid, session.lid, epcs],
  );

  return NextResponse.json({ dismissed: r.rowCount ?? 0 });
}
