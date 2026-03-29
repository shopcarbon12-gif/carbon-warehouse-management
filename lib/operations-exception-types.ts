/** Audit inbox row for RFID exceptions (client-safe). */

export type RfidExceptionAuditRow = {
  id: string;
  action: string;
  entity: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export function isExceptionOpen(meta: Record<string, unknown> | null): boolean {
  if (!meta) return true;
  if (meta.state === "RESOLVED") return false;
  if (typeof meta.resolved_at === "string") return false;
  return true;
}
