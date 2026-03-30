import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { listPhysicalEpcCountsBySku } from "@/lib/queries/sync-compare";
import { resolveLightspeedInventoryForCompare } from "@/lib/services/lightspeed";

export type SyncCompareRow = {
  sku: string;
  description: string;
  lsCount: number;
  physicalCount: number;
  variance: number;
};

export type SyncComparePayload = {
  lsLocationId: string;
  /** `live_catalog` when Lightspeed HTTP catalog returned rows; else `simulated` demo. */
  lsInventorySource: "live_catalog" | "simulated";
  lsInventoryDetail?: string;
  over: SyncCompareRow[];
  short: SyncCompareRow[];
  matched: SyncCompareRow[];
};

function buildRow(
  sku: string,
  description: string,
  lsCount: number,
  physicalCount: number,
): SyncCompareRow {
  return {
    sku,
    description,
    lsCount,
    physicalCount,
    variance: physicalCount - lsCount,
  };
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  let lsLocationId = "mock";
  try {
    const loc = await pool.query<{ lightspeed_location_id: string | null }>(
      `SELECT lightspeed_location_id FROM locations WHERE id = $1::uuid LIMIT 1`,
      [session.lid],
    );
    const raw = loc.rows[0]?.lightspeed_location_id?.trim();
    if (raw) lsLocationId = raw;
  } catch {
    // keep mock id
  }

  let lsLines: { sku: string; quantity: number }[] = [];
  let lsInventorySource: "live_catalog" | "simulated" = "simulated";
  let lsInventoryDetail: string | undefined;
  try {
    const resolved = await resolveLightspeedInventoryForCompare(pool, session.tid, lsLocationId);
    lsLines = resolved.lines;
    lsInventorySource = resolved.source;
    lsInventoryDetail = resolved.detail;
  } catch (e) {
    console.error("[sync/compare] Lightspeed inventory resolve failed", e);
    return NextResponse.json({ error: "Lightspeed fetch failed" }, { status: 502 });
  }

  let physicalRows: Awaited<ReturnType<typeof listPhysicalEpcCountsBySku>> = [];
  try {
    physicalRows = await listPhysicalEpcCountsBySku(pool, session.lid);
  } catch (e) {
    console.error("[sync/compare] physical query failed", e);
    return NextResponse.json({ error: "Database query failed" }, { status: 500 });
  }

  const lsMap = new Map<string, number>();
  for (const line of lsLines) {
    lsMap.set(line.sku.trim(), line.quantity);
  }

  const phyMap = new Map<string, { description: string; count: number }>();
  for (const row of physicalRows) {
    phyMap.set(row.sku.trim(), {
      description: row.matrix_description,
      count: row.physical_count,
    });
  }

  const skus = new Set<string>([...lsMap.keys(), ...phyMap.keys()]);

  const over: SyncCompareRow[] = [];
  const short: SyncCompareRow[] = [];
  const matched: SyncCompareRow[] = [];

  for (const sku of skus) {
    const lsCount = lsMap.get(sku) ?? 0;
    const phy = phyMap.get(sku);
    const physicalCount = phy?.count ?? 0;
    const description = phy?.description ?? "— (not in Carbon catalog)";

    const row = buildRow(sku, description, lsCount, physicalCount);
    if (physicalCount > lsCount) over.push(row);
    else if (physicalCount < lsCount) short.push(row);
    else matched.push(row);
  }

  const sortBySku = (a: SyncCompareRow, b: SyncCompareRow) =>
    a.sku.localeCompare(b.sku);
  over.sort(sortBySku);
  short.sort(sortBySku);
  matched.sort(sortBySku);

  const payload: SyncComparePayload = {
    lsLocationId,
    lsInventorySource,
    lsInventoryDetail,
    over,
    short,
    matched,
  };

  return NextResponse.json(payload);
}
