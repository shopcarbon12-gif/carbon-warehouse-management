import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES, isSuperAdminRole } from "@/lib/auth/roles";
import { getStatusLabelForWmsItemStatus } from "@/lib/queries/status-labels";

export const dynamic = "force-dynamic";

const ALLOWED_STATUS = new Set([
  "in-stock",
  "return",
  "damaged",
  "sold",
  "stolen",
  "tag_killed",
  "UNKNOWN",
  "pending_visibility",
  "in-transit",
  "pending_transaction",
]);

const bodySchema = z.object({
  epcs: z.array(z.string().min(4).max(64)).min(1),
  targetStatus: z.string().min(1).max(32),
  /** When true, allow risky transitions (e.g. sold → in-stock). Super Admin only. */
  override: z.boolean().optional(),
});

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
      if (!from) continue;

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
      const risky = (from === "sold" && to === "in-stock") || (from === "UNKNOWN" && to === "sold");
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
             tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id
           )
           VALUES ($1::uuid, 'STATUS_CHANGE', 'EPC', $2, $3, $4, 'bulk_status', NULL)`,
          [session.tid, e, from, to],
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
