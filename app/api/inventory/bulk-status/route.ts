import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES, isSuperAdminRole } from "@/lib/auth/roles";
import { getStatusLabelForWmsItemStatus } from "@/lib/queries/status-labels";
import { decodeEpc } from "@/lib/server/epc-decode";
import { legacyEpcSystemId, legacyEpcSerial } from "@/lib/server/legacy-epc-catalog";
import { loadEpcConfig } from "@/lib/server/epc-ingress";
import type { PoolClient } from "pg";

export const dynamic = "force-dynamic";

const ALLOWED_STATUS = new Set([
  "in-stock",
  "return",
  "damaged",
  "sold",
  "stolen",
  "tag_killed",
  "unknown",
  "pending_visibility",
  "in-transit",
  "pending_transaction",
]);

const bodySchema = z.object({
  epcs: z.array(z.string().min(4).max(64)).min(1),
  targetStatus: z.string().min(1).max(32),
  /** When true, allow risky transitions (e.g. sold → in-stock). Super Admin only. */
  override: z.boolean().optional(),
  /** Optional device id stamped on the audit row when the change originates from a handheld. */
  deviceId: z.string().min(1).max(256).optional(),
  /** Optional free-form reason; defaults to 'bulk_status'. */
  reason: z.string().min(1).max(128).optional(),
  /**
   * When true, an EPC that does not yet exist in `items` is CREATED at the
   * session location with the target status (decoding for SKU/serial when
   * possible, else custom_sku_id=null / serial 0). Used by the handheld
   * Status Change flow so an operator can ghost a foreign / uncommissioned
   * tag (TAG KILLED) — the row must exist for the status to stick and for
   * future cycle counts to ghost-drop it instead of routing to defective.
   * Other callers (encode / re-encode) leave this off and only mutate
   * already-present rows.
   */
  createIfAbsent: z.boolean().optional(),
});

/**
 * Resolve a catalog SKU + serial for an EPC the same way the cycle-count
 * scan does: primary Carbon formula first, then the LEGACY catalog-entrance
 * fallback. Returns nulls when neither formula places the tag (foreign tag).
 */
async function resolveCatalog(
  client: PoolClient,
  epc: string,
  tenantId: string,
): Promise<{ customSkuId: string | null; serial: bigint | null }> {
  const config = await loadEpcConfig(client, tenantId);
  const decoded = config ? decodeEpc(epc, config) : null;
  let customSkuId: string | null = null;
  let serial: bigint | null = null;
  if (decoded && decoded.valid) {
    const r = await client.query<{ id: string }>(
      `SELECT id::text FROM custom_skus WHERE ls_system_id = $1::bigint LIMIT 1`,
      [decoded.systemId!.toString()],
    );
    if (r.rowCount && r.rows[0]) customSkuId = r.rows[0].id;
    serial = decoded.serial;
  }
  if (!customSkuId) {
    const legacySystemId = legacyEpcSystemId(epc);
    if (legacySystemId !== null) {
      const r = await client.query<{ id: string }>(
        `SELECT id::text FROM custom_skus WHERE ls_system_id = $1::bigint LIMIT 1`,
        [legacySystemId.toString()],
      );
      if (r.rowCount && r.rows[0]) {
        customSkuId = r.rows[0].id;
        serial = (decoded && decoded.valid ? decoded.serial : null) ?? legacyEpcSerial(epc);
      }
    }
  }
  return { customSkuId, serial };
}

/**
 * Bulk status change — Clean 10 WMS vocabulary.
 * Super Admin (`admin` role) bypasses status locks; other staff cannot change super-admin-locked rows or set system-only targets.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.MANAGER]);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (!ALLOWED_STATUS.has(parsed.data.targetStatus)) {
    return NextResponse.json({ error: "Invalid targetStatus" }, { status: 400 });
  }

  const superAdmin = isSuperAdminRole(session.role);
  const toLabel = await getStatusLabelForWmsItemStatus(pool, parsed.data.targetStatus);
  if (!superAdmin && toLabel?.is_system_only) {
    return NextResponse.json(
      { error: "Forbidden: system workflow statuses require Super Admin.", code: "SYSTEM_STATUS_FORBIDDEN" },
      { status: 403 },
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let updated = 0;
    for (const epc of parsed.data.epcs) {
      const e = epc.trim();
      if (!e) continue;
      const cur = await client.query<{ status: string }>(
        `SELECT status FROM items i
         INNER JOIN locations l ON l.id = i.location_id
         WHERE i.epc = $1 AND l.tenant_id = $2::uuid AND l.id = $3::uuid
         LIMIT 1`,
        [e, session.tid, session.lid],
      );
      const from = cur.rows[0]?.status;
      if (!from) {
        // Not present at this location. If the caller opted in, create the
        // row so the status sticks (foreign / uncommissioned tags). We only
        // create when the EPC is absent tenant-wide — an EPC living at
        // another location of the tenant is left to the existing
        // location-scoped no-op (we never silently relocate it here).
        if (!parsed.data.createIfAbsent) continue;
        const elsewhere = await client.query(
          `SELECT 1 FROM items i
           INNER JOIN locations l ON l.id = i.location_id
           WHERE i.epc = $1 AND l.tenant_id = $2::uuid
           LIMIT 1`,
          [e, session.tid],
        );
        if ((elsewhere.rowCount ?? 0) > 0) continue;

        const { customSkuId, serial } = await resolveCatalog(client, e, session.tid);
        const serialText = serial !== null ? serial.toString() : "0";
        const ins = await client.query<{ id: string }>(
          `INSERT INTO items (
             epc, serial_number, custom_sku_id, location_id,
             status, last_seen_at, first_scanned_at,
             source, source_device_label
           ) VALUES (
             $1, $2::bigint, $3::uuid, $4::uuid,
             $5, now(), now(),
             'status_change', 'status-change-handheld'
           )
           ON CONFLICT (epc) DO NOTHING
           RETURNING id::text`,
          [e, serialText, customSkuId, session.lid, parsed.data.targetStatus],
        );
        if ((ins.rowCount ?? 0) > 0) {
          updated += 1;
          await client.query(
            `INSERT INTO inventory_audit_logs (
               tenant_id, log_type, entity_type, entity_reference, old_value, new_value,
               reason, user_id, user_uuid, device_id
             )
             VALUES ($1::uuid, 'STATUS_CHANGE', 'EPC', $2, NULL, $3, $4, NULL, $5::uuid, $6)`,
            [
              session.tid,
              e,
              parsed.data.targetStatus,
              parsed.data.reason?.trim() || "bulk_status_create",
              session.sub,
              parsed.data.deviceId?.trim() || null,
            ],
          );
        }
        continue;
      }

      const fromLabel = await getStatusLabelForWmsItemStatus(client, from);
      if (!superAdmin && fromLabel?.super_admin_locked) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          {
            error: `Forbidden: item ${e} is in a Super Admin–locked status (${fromLabel?.name ?? from}).`,
            code: "SUPER_ADMIN_LOCKED",
            epc: e,
            currentStatus: from,
          },
          { status: 403 },
        );
      }

      const to = parsed.data.targetStatus;
      if (from === to) continue;
      const risky = (from === "sold" && to === "in-stock") || (from === "tag_killed" && to === "sold");
      if (risky && !parsed.data.override) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: `Blocked ${from} → ${to} without override for EPC ${e}` },
          { status: 409 },
        );
      }
      if (risky && !superAdmin) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: `Super Admin override required for ${from} → ${to} (EPC ${e})` },
          { status: 403 },
        );
      }

      const u = await client.query(
        `UPDATE items i
         SET status = $2
         FROM locations l
         WHERE i.epc = $1 AND i.location_id = l.id AND l.tenant_id = $3::uuid AND l.id = $4::uuid`,
        [e, to, session.tid, session.lid],
      );
      updated += u.rowCount ?? 0;
      if ((u.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO inventory_audit_logs (
             tenant_id, log_type, entity_type, entity_reference, old_value, new_value,
             reason, user_id, user_uuid, device_id
           )
           VALUES ($1::uuid, 'STATUS_CHANGE', 'EPC', $2, $3, $4, $5, NULL, $6::uuid, $7)`,
          [
            session.tid,
            e,
            from,
            to,
            parsed.data.reason?.trim() || "bulk_status",
            session.sub,
            parsed.data.deviceId?.trim() || null,
          ],
        );
      }
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, updated });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[inventory/bulk-status]", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  } finally {
    client.release();
  }
}
