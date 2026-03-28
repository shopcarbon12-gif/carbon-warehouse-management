import type { Pool } from "pg";
import { inventoryTotalsByZone } from "./inventory";
import { ordersCountByStatus } from "./orders";
import { WAREHOUSE_ZONES } from "@/lib/zones";

export type ReportSummary = {
  unitsPerZone: { zone: string; units: number }[];
  ordersByStatus: { status: string; count: number }[];
};

export async function getReportSummary(pool: Pool): Promise<ReportSummary> {
  const byZone = await inventoryTotalsByZone(pool);
  const byStatus = await ordersCountByStatus(pool);
  const zoneMap = Object.fromEntries(byZone.map((z) => [z.zone_code, z.total]));
  const unitsPerZone = WAREHOUSE_ZONES.map((code) => ({
    zone: code,
    units: zoneMap[code] ?? 0,
  }));
  return { unitsPerZone, ordersByStatus: byStatus };
}

export function emptyReportSummary(): ReportSummary {
  return {
    unitsPerZone: WAREHOUSE_ZONES.map((zone) => ({ zone, units: 0 })),
    ordersByStatus: [],
  };
}
