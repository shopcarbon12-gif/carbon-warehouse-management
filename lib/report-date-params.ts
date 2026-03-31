/** Strict YYYY-MM-DD for report filters (inclusive end date in SQL). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseReportDateParam(value: string | null): string | undefined {
  if (!value || !DATE_RE.test(value)) return undefined;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return value;
}

export function validateReportDateRange(
  from: string | undefined,
  to: string | undefined,
): { ok: true; dateFrom?: string; dateTo?: string } | { ok: false; error: string } {
  if (!from && !to) return { ok: true };
  if (from && to && from > to) {
    return { ok: false, error: "dateFrom must be on or before dateTo" };
  }
  return { ok: true, dateFrom: from, dateTo: to };
}
