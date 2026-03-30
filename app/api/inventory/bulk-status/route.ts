import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const ALLOWED_STATUS = new Set([
  "in-stock",
  "sold",
  "in-transit",
  "missing",
  "damaged",
  "INCOMPLETE",
  "UNKNOWN",
  "COMMISSIONED",
]);

const bodySchema = z.object({
  epcs: z.array(z.string().min(4).max(64)).min(1),
  targetStatus: z.string().min(1).max(32),
  /** When true, allow risky transitions (e.g. sold → in-stock). */
  override: z.boolean().optional(),
});

/**
 * Bulk status change with a minimal state machine. Full rules TBD per tenant policy.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
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
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (!ALLOWED_STATUS.has(parsed.data.targetStatus)) {
    return NextResponse.json({ error: "Invalid targetStatus" }, { status: 400 });
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
      const to = parsed.data.targetStatus as
        | "in-stock"
        | "sold"
        | "in-transit"
        | "missing"
        | "damaged"
        | "INCOMPLETE"
        | "UNKNOWN"
        | "COMMISSIONED";
      if (from === to) continue;
      const risky = (from === "sold" && to === "in-stock") || (from === "missing" && to === "sold");
      if (risky && !parsed.data.override) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: `Blocked ${from} → ${to} without override for EPC ${e}` },
          { status: 409 },
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
