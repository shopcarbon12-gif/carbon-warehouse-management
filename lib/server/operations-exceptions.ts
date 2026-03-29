import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { RfidExceptionAuditRow } from "@/lib/operations-exception-types";

export type { RfidExceptionAuditRow };
export { isExceptionOpen } from "@/lib/operations-exception-types";

function normalizeEpc(s: string): string {
  return s.replace(/\s/g, "").toUpperCase();
}

export type SessionPayload = {
  sub: string;
  tid: string;
  lid: string;
};

export async function listRfidExceptions(
  pool: Pool,
  tenantId: string,
): Promise<RfidExceptionAuditRow[]> {
  const r = await pool.query<{
    id: string;
    action: string;
    entity: string;
    metadata: unknown;
    created_at: Date;
  }>(
    `SELECT id::text, action, entity, metadata, created_at
     FROM audit_log
     WHERE tenant_id = $1::uuid
       AND action IN ('rfid_alarm', 'rfid_exception')
     ORDER BY created_at DESC
     LIMIT 200`,
    [tenantId],
  );

  return r.rows.map((row) => ({
    id: row.id,
    action: row.action,
    entity: row.entity,
    metadata:
      typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : null,
    created_at: row.created_at.toISOString(),
  }));
}

export async function simulateDockAlarm(
  client: PoolClient,
  session: SessionPayload,
): Promise<RfidExceptionAuditRow> {
  const pick = await client.query<{ epc: string }>(
    `SELECT i.epc
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     WHERE i.location_id = $2::uuid
       AND i.status = 'in-stock'
     ORDER BY random()
     LIMIT 3`,
    [session.tid, session.lid],
  );

  if (pick.rows.length === 0) {
    throw new Error("BAD_REQUEST:No in-stock items at this location to simulate");
  }

  const epcs = pick.rows.map((r) => normalizeEpc(r.epc));
  const meta = {
    state: "OPEN",
    kind: "dock_exit",
    source: "simulate",
    epcs,
    location_id: session.lid,
    triggered_at: new Date().toISOString(),
  };

  const ins = await client.query<{
    id: string;
    action: string;
    entity: string;
    metadata: unknown;
    created_at: Date;
  }>(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
     VALUES ($1::uuid, $2::uuid, 'rfid_alarm', 'items', $3::jsonb)
     RETURNING id::text, action, entity, metadata, created_at`,
    [session.tid, session.sub, JSON.stringify(meta)],
  );

  const row = ins.rows[0];
  if (!row) throw new Error("SERVER:Insert failed");

  return {
    id: row.id,
    action: row.action,
    entity: row.entity,
    metadata:
      typeof row.metadata === "object" && row.metadata !== null
        ? (row.metadata as Record<string, unknown>)
        : null,
    created_at: row.created_at.toISOString(),
  };
}

export const exceptionResolveSchema = z.object({
  auditLogId: z.string().uuid(),
  resolution: z.enum(["return_to_stock", "mark_missing"]),
});

export type ExceptionResolveBody = z.infer<typeof exceptionResolveSchema>;

export async function resolveRfidException(
  client: PoolClient,
  session: SessionPayload,
  body: ExceptionResolveBody,
): Promise<{ updated_items: number }> {
  const { auditLogId, resolution } = exceptionResolveSchema.parse(body);

  const row = await client.query<{
    id: string;
    action: string;
    metadata: unknown;
  }>(
    `SELECT id::text, action, metadata
     FROM audit_log
     WHERE id = $1::uuid AND tenant_id = $2::uuid
     LIMIT 1`,
    [auditLogId, session.tid],
  );

  const ar = row.rows[0];
  if (!ar) throw new Error("BAD_REQUEST:Audit row not found");
  if (ar.action !== "rfid_alarm" && ar.action !== "rfid_exception") {
    throw new Error("BAD_REQUEST:Not an RFID exception record");
  }

  const prev =
    typeof ar.metadata === "object" && ar.metadata !== null && !Array.isArray(ar.metadata)
      ? (ar.metadata as Record<string, unknown>)
      : {};

  const rawEpcs = prev.epcs;
  const epcs: string[] = Array.isArray(rawEpcs)
    ? rawEpcs.filter((x): x is string => typeof x === "string").map(normalizeEpc)
    : [];

  let updatedItems = 0;
  if (resolution === "mark_missing" && epcs.length > 0) {
    const u = await client.query(
      `UPDATE items i
       SET status = 'UNKNOWN'
       FROM locations l
       WHERE i.epc = ANY($1::text[])
         AND i.location_id = l.id
         AND l.tenant_id = $2::uuid`,
      [epcs, session.tid],
    );
    updatedItems = u.rowCount ?? 0;
  }

  const resolutionPatch = {
    state: "RESOLVED",
    resolved_at: new Date().toISOString(),
    resolved_by: session.sub,
    resolution_action: resolution,
  };

  await client.query(
    `UPDATE audit_log
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
     WHERE id = $2::uuid AND tenant_id = $3::uuid`,
    [JSON.stringify(resolutionPatch), auditLogId, session.tid],
  );

  return { updated_items: updatedItems };
}
