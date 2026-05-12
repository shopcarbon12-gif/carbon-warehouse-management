import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import {
  classifyVarianceLive,
  formatScanDuration,
  getSession,
  totalScanDurationMs,
  type LiveVariance,
  type SessionDetail,
} from "@/lib/server/rfid-cycle-count-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await params;
  const client = await pool.connect();
  try {
    const detail = await getSession(client, session.tid, id);
    if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const variance = await classifyVarianceLive(
      client,
      session.tid,
      detail.expected,
      detail.scanned_epcs,
      detail.location_id,
    );

    const buf = await renderWorkbook(detail, variance);
    const safeName = (detail.name || `session-${id}`).replace(/[^A-Za-z0-9._-]/g, "_");
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="cycle-count_${safeName}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } finally {
    client.release();
  }
}

async function renderWorkbook(
  detail: SessionDetail,
  variance: LiveVariance,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Carbon WMS";
  wb.created = new Date();

  // Summary
  const sum = wb.addWorksheet("Summary");
  sum.columns = [
    { header: "Field", key: "k", width: 22 },
    { header: "Value", key: "v", width: 56 },
  ];
  const totalMs = totalScanDurationMs(detail.scan_periods);
  sum.addRows([
    { k: "Session #", v: detail.name },
    { k: "Location", v: `${detail.location_code} — ${detail.location_name}` },
    { k: "Bin", v: detail.bin_code ?? "(all bins at location)" },
    { k: "Status", v: detail.status },
    { k: "Session created", v: detail.started_at },
    { k: "Started by", v: detail.started_by_email ?? "" },
    { k: "Completed", v: detail.completed_at ?? "" },
    { k: "Scan periods", v: detail.scan_periods.length },
    { k: "Total active scan time", v: formatScanDuration(totalMs) },
    { k: "Notes", v: detail.notes ?? "" },
    { k: "Expected", v: detail.expected.length },
    { k: "Scanned (unique)", v: detail.scanned_epcs.length },
    { k: "Matched", v: variance.matched.length },
    { k: "Missing", v: variance.missing.length },
    { k: "Added here (live)", v: variance.added_here.length },
    { k: "Defective (live)", v: variance.defective.length },
    { k: "Locked (Super Admin)", v: variance.locked.length },
  ]);
  sum.getRow(1).font = { bold: true };

  // Scan periods — one row per Start/Pause cycle.
  const periods = wb.addWorksheet("Scan periods");
  periods.columns = [
    { header: "#", key: "n", width: 6 },
    { header: "Started", key: "started", width: 28 },
    { header: "Ended", key: "ended", width: 28 },
    { header: "Duration", key: "duration", width: 16 },
  ];
  periods.getRow(1).font = { bold: true };
  detail.scan_periods.forEach((p, i) => {
    const start = Date.parse(p.started_at);
    const end = p.ended_at ? Date.parse(p.ended_at) : Date.now();
    const dur =
      Number.isFinite(start) && Number.isFinite(end)
        ? formatScanDuration(Math.max(0, end - start))
        : "—";
    periods.addRow({
      n: i + 1,
      started: p.started_at,
      ended: p.ended_at ?? "(still open)",
      duration: dur,
    });
  });

  // Matched / Missing — same columns (from expected snapshot)
  const expectedCols = [
    { header: "EPC", key: "epc", width: 30 },
    { header: "SKU", key: "sku", width: 18 },
    { header: "Description", key: "description", width: 36 },
    { header: "UPC", key: "upc", width: 16 },
    { header: "Color", key: "color", width: 12 },
    { header: "Size", key: "size", width: 8 },
    { header: "Expected bin", key: "bin", width: 14 },
  ];

  const matched = wb.addWorksheet("Matched");
  matched.columns = expectedCols;
  matched.getRow(1).font = { bold: true };
  for (const r of variance.matched) {
    matched.addRow({
      epc: r.epc,
      sku: r.sku,
      description: r.description ?? "",
      upc: r.upc ?? "",
      color: r.color ?? "",
      size: r.size ?? "",
      bin: r.bin_code ?? "",
    });
  }

  const missing = wb.addWorksheet("Missing");
  missing.columns = expectedCols;
  missing.getRow(1).font = { bold: true };
  for (const r of variance.missing) {
    missing.addRow({
      epc: r.epc,
      sku: r.sku,
      description: r.description ?? "",
      upc: r.upc ?? "",
      color: r.color ?? "",
      size: r.size ?? "",
      bin: r.bin_code ?? "",
    });
  }

  // Live buckets — added_here / defective / locked share a shape
  const liveCols = [
    { header: "EPC", key: "epc", width: 30 },
    { header: "SKU", key: "sku", width: 18 },
    { header: "Description", key: "description", width: 36 },
    { header: "UPC", key: "upc", width: 16 },
    { header: "Color", key: "color", width: 12 },
    { header: "Size", key: "size", width: 8 },
    { header: "Current bin", key: "bin", width: 14 },
    { header: "Current status", key: "current_status", width: 14 },
    { header: "Current location", key: "loc", width: 14 },
  ];

  const added = wb.addWorksheet("Added here");
  added.columns = liveCols;
  added.getRow(1).font = { bold: true };
  for (const r of variance.added_here) {
    added.addRow({
      epc: r.epc,
      sku: r.sku ?? "",
      description: r.description ?? "",
      upc: r.upc ?? "",
      color: r.color ?? "",
      size: r.size ?? "",
      bin: r.bin_code ?? "",
      current_status: r.current_status,
      loc: r.current_location_code ?? "",
    });
  }

  const defective = wb.addWorksheet("Defective");
  defective.columns = liveCols;
  defective.getRow(1).font = { bold: true };
  for (const r of variance.defective) {
    defective.addRow({
      epc: r.epc,
      sku: r.sku ?? "",
      description: r.description ?? "",
      upc: r.upc ?? "",
      color: r.color ?? "",
      size: r.size ?? "",
      bin: r.bin_code ?? "",
      current_status: r.current_status,
      loc: r.current_location_code ?? "",
    });
  }

  const locked = wb.addWorksheet("Locked");
  locked.columns = liveCols;
  locked.getRow(1).font = { bold: true };
  for (const r of variance.locked) {
    locked.addRow({
      epc: r.epc,
      sku: r.sku ?? "",
      description: r.description ?? "",
      upc: r.upc ?? "",
      color: r.color ?? "",
      size: r.size ?? "",
      bin: r.bin_code ?? "",
      current_status: r.current_status,
      loc: r.current_location_code ?? "",
    });
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
