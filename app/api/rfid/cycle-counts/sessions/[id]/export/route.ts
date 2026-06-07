import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { shortName } from "@/lib/format-name";
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
    {
      k: "Started by",
      v: shortName(
        detail.started_by_first,
        detail.started_by_last,
        detail.started_by_email,
      ),
    },
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

  // ───────────── Per-EPC sheets ─────────────
  // First-sighting reader + antenna for each EPC, split out of the source map
  // (names look like "Aisle 3-4/1 · A2"). The source map is already
  // first-sighting-wins, so this is the reader+antenna that saw the tag FIRST
  // — never a duplicate. Mobile sources show the device name, blank antenna.
  const sources = detail.scanned_epc_sources ?? {};
  const srcFor = (epc: string): { reader: string; antenna: string } => {
    const s = sources[epc.toUpperCase()];
    if (!s) return { reader: "", antenna: "" };
    if (s.kind === "mobile") return { reader: s.name || "mobile", antenna: "" };
    const m = s.name.match(/^(.*?)\s*·\s*A(\d+)\s*$/);
    return m ? { reader: m[1], antenna: m[2] } : { reader: s.name, antenna: "" };
  };
  // Requested column order (2026-06-07): SKU, UPC, Description, Color, Size,
  // Expected bin, Reader, Antenna, EPC. "Expected bin" stays a SINGLE column
  // (the item's home/expected bin) — same as before, just reordered.
  const scannedCols = [
    { header: "SKU", key: "sku", width: 18 },
    { header: "UPC", key: "upc", width: 16 },
    { header: "Description", key: "description", width: 36 },
    { header: "Color", key: "color", width: 12 },
    { header: "Size", key: "size", width: 8 },
    { header: "Expected bin", key: "bin", width: 14 },
    { header: "Reader", key: "reader", width: 18 },
    { header: "Antenna", key: "antenna", width: 9 },
    { header: "EPC", key: "epc", width: 30 },
  ];
  // Live buckets show the item's CURRENT bin + status/location.
  const liveCols = [
    { header: "SKU", key: "sku", width: 18 },
    { header: "UPC", key: "upc", width: 16 },
    { header: "Description", key: "description", width: 36 },
    { header: "Color", key: "color", width: 12 },
    { header: "Size", key: "size", width: 8 },
    { header: "Current bin", key: "bin", width: 14 },
    { header: "Reader", key: "reader", width: 18 },
    { header: "Antenna", key: "antenna", width: 9 },
    { header: "EPC", key: "epc", width: 30 },
    { header: "Current status", key: "current_status", width: 14 },
    { header: "Current location", key: "loc", width: 16 },
  ];
  // Missing items were never scanned → no reader/antenna.
  const missingCols = [
    { header: "SKU", key: "sku", width: 18 },
    { header: "UPC", key: "upc", width: 16 },
    { header: "Description", key: "description", width: 36 },
    { header: "Color", key: "color", width: 12 },
    { header: "Size", key: "size", width: 8 },
    { header: "Expected bin", key: "bin", width: 14 },
    { header: "EPC", key: "epc", width: 30 },
  ];

  const matched = wb.addWorksheet("Matched");
  matched.columns = scannedCols;
  matched.getRow(1).font = { bold: true };
  for (const r of variance.matched) {
    const s = srcFor(r.epc);
    matched.addRow({
      sku: r.sku ?? "",
      upc: r.upc ?? "",
      description: r.description ?? "",
      color: r.color ?? "",
      size: r.size ?? "",
      bin: r.bin_code ?? "",
      reader: s.reader,
      antenna: s.antenna,
      epc: r.epc,
    });
  }

  const missing = wb.addWorksheet("Missing");
  missing.columns = missingCols;
  missing.getRow(1).font = { bold: true };
  for (const r of variance.missing) {
    missing.addRow({
      sku: r.sku ?? "",
      upc: r.upc ?? "",
      description: r.description ?? "",
      color: r.color ?? "",
      size: r.size ?? "",
      bin: r.bin_code ?? "",
      epc: r.epc,
    });
  }

  const addLiveSheet = (
    title: string,
    rows: LiveVariance["added_here"],
  ): void => {
    const ws = wb.addWorksheet(title);
    ws.columns = liveCols;
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      const s = srcFor(r.epc);
      ws.addRow({
        sku: r.sku ?? "",
        upc: r.upc ?? "",
        description: r.description ?? "",
        color: r.color ?? "",
        size: r.size ?? "",
        bin: r.bin_code ?? "",
        reader: s.reader,
        antenna: s.antenna,
        epc: r.epc,
        current_status: r.current_status,
        loc: r.current_location_code ?? "",
      });
    }
  };
  addLiveSheet("Added here", variance.added_here);
  addLiveSheet("Defective", variance.defective);
  addLiveSheet("Locked", variance.locked);

  // ───────────── All scanned items — one row per EPC, deduped ─────────────
  // Every unique scanned EPC, attributed to the reader+antenna that saw it
  // FIRST. detail.scanned_epcs is already de-duplicated, so no EPC repeats.
  type CatRow = {
    sku?: string | null;
    upc?: string | null;
    description?: string | null;
    color?: string | null;
    size?: string | null;
    bin_code?: string | null;
  };
  const catalog = new Map<string, CatRow>();
  for (const r of [
    ...variance.matched,
    ...variance.added_here,
    ...variance.defective,
    ...variance.locked,
    ...variance.missing,
  ]) {
    const k = r.epc.toUpperCase();
    if (!catalog.has(k)) catalog.set(k, r);
  }
  const allScanned = wb.addWorksheet("All scanned");
  allScanned.columns = scannedCols;
  allScanned.getRow(1).font = { bold: true };
  for (const epc of detail.scanned_epcs) {
    const c = catalog.get(epc.toUpperCase());
    const s = srcFor(epc);
    allScanned.addRow({
      sku: c?.sku ?? "",
      upc: c?.upc ?? "",
      description: c?.description ?? "",
      color: c?.color ?? "",
      size: c?.size ?? "",
      bin: c?.bin_code ?? "",
      reader: s.reader,
      antenna: s.antenna,
      epc,
    });
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
