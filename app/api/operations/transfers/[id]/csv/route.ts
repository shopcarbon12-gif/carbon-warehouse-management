import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { getTransferDetail } from "@/lib/server/operations-transfers";

/**
 * GET /api/operations/transfers/<uuid>/csv — download a transfer slip as CSV.
 * Schema mirrors the existing Senitron export the warehouse staff already
 * recognise: Index, Custom Sku, UPC, Item Description, Price, Sent, Received,
 * Missed, Slip #, Date created.
 */
function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid transfer id" }, { status: 400 });
  }
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const detail = await getTransferDetail(pool, session.tid, id);
  if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Group RFID rows by SKU for the row-per-SKU layout (each row's Sent count
  // is the EPC group size). Manual lines append after.
  const skuMap = new Map<string, {
    sku: string;
    upc: string | null;
    name: string | null;
    price: string | null;
    sent: number;
    received: number;
  }>();
  for (const r of detail.rfid) {
    const cur = skuMap.get(r.custom_sku_id) ?? {
      sku: r.sku,
      upc: r.upc,
      name: r.name,
      price: r.retail_price,
      sent: 0,
      received: 0,
    };
    cur.sent += 1;
    if (r.received) cur.received += 1;
    skuMap.set(r.custom_sku_id, cur);
  }
  for (const m of detail.manual) {
    const cur = skuMap.get(m.custom_sku_id) ?? {
      sku: m.sku,
      upc: m.upc,
      name: m.name,
      price: m.retail_price,
      sent: 0,
      received: 0,
    };
    cur.sent += m.qty;
    if (m.state === "settled") cur.received += m.qty;
    skuMap.set(m.custom_sku_id, cur);
  }

  const slipNumber = detail.slip_number ?? "";
  const dateCreated = (() => {
    if (!detail.created_at) return "";
    const d = new Date(detail.created_at);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  })();

  const header = [
    "Index",
    "Custom Sku",
    "UPC",
    "Item Description",
    "Price",
    "Sent",
    "Received",
    "Missed",
    "Slip #",
    "Date created",
  ];
  const rows: string[] = [header.map(csvCell).join(",")];
  let i = 1;
  for (const v of skuMap.values()) {
    const missed = Math.max(0, v.sent - v.received);
    rows.push(
      [
        i,
        v.sku,
        v.upc ?? "",
        v.name ?? "",
        v.price ?? "",
        v.sent,
        v.received,
        missed,
        slipNumber,
        dateCreated,
      ]
        .map(csvCell)
        .join(","),
    );
    i++;
  }

  const fname = `Slip_${slipNumber || id}_${detail.source_location_code}_${dateCreated.replace(/-/g, "")}.csv`;
  return new NextResponse(rows.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fname}"`,
      "Cache-Control": "no-store",
    },
  });
}
