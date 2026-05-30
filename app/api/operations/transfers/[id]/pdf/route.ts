import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { getTransferDetail } from "@/lib/server/operations-transfers";
import { shortName } from "@/lib/format-name";

/**
 * GET /api/operations/transfers/<uuid>/pdf — return a printable HTML page
 * sized to US Letter with @media print rules and an `?autoprint=1` flag that
 * fires window.print() on load. The browser's print dialog lets the operator
 * "Save as PDF" — bypasses the OS PDF viewer entirely (the link can be
 * opened in a new tab via a regular `<a target="_blank">`).
 *
 * We render HTML rather than emit a binary PDF so we can pull in matrix /
 * sku data on every render, no PDF lib dependency, and the slip stays in
 * sync if the underlying transfer record later updates.
 */
function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

  const { searchParams } = new URL(req.url);
  const autoprint = searchParams.get("autoprint") === "1";

  // Aggregate rows per SKU (RFID + Manual combined) — matches the Senitron
  // slip's "Transfer Asset(s) Details" table.
  type Row = { sku: string; upc: string | null; name: string | null; price: string | null; sent: number; received: number };
  const map = new Map<string, Row>();
  for (const r of detail.rfid) {
    const cur = map.get(r.custom_sku_id) ?? {
      sku: r.sku, upc: r.upc, name: r.name, price: r.retail_price, sent: 0, received: 0,
    };
    cur.sent += 1;
    if (r.received) cur.received += 1;
    map.set(r.custom_sku_id, cur);
  }
  for (const m of detail.manual) {
    const cur = map.get(m.custom_sku_id) ?? {
      sku: m.sku, upc: m.upc, name: m.name, price: m.retail_price, sent: 0, received: 0,
    };
    cur.sent += m.qty;
    if (m.state === "settled") cur.received += m.qty;
    map.set(m.custom_sku_id, cur);
  }
  const rows = [...map.values()];
  const totalEpcs = detail.rfid.length;
  const totalManual = detail.manual.reduce((acc, m) => acc + m.qty, 0);
  const totalSent = totalEpcs + totalManual;
  const slipNumber = detail.slip_number ?? "—";
  const dateCreated = (() => {
    if (!detail.created_at) return "—";
    const d = new Date(detail.created_at);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-US");
  })();
  const stateLabel =
    detail.state === "in-transit" ? "Pending"
      : detail.state === "partially_received" ? "Partial"
        : detail.state === "received" ? "Received"
          : detail.state === "cancelled" ? "Cancelled" : detail.state;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Slip ${escapeHtml(slipNumber)} — ${escapeHtml(detail.source_location_code)} → ${escapeHtml(detail.destination_location_code)}</title>
<style>
  @page { size: Letter; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; margin: 0; padding: 24px; font-size: 12px; line-height: 1.4; }
  .topbar { display: grid; grid-template-columns: 80px 1fr 1fr; gap: 24px; align-items: center; margin-bottom: 24px; }
  .logo { width: 80px; height: 80px; background: #111; color: #fff; display:flex; align-items:center; justify-content:center; border-radius: 4px; letter-spacing: .12em; font-weight: 700; font-size: 18px; }
  .ship { background: #f1f1f1; padding: 10px 12px; border-radius: 3px; font-weight: 600; }
  .ship .body { font-weight: 400; padding-top: 4px; }
  h2 { font-size: 14px; margin: 18px 0 6px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #ddd; vertical-align: middle; }
  th { background: #f7f7f7; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #555; }
  .meta th { font-size: 11px; color: #555; }
  .meta td { font-weight: 600; }
  .right { text-align: right; }
  .center { text-align: center; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 600; background: #e9e9e9; }
  .badge.received { background: #cdebd0; color: #1d6b2c; }
  .badge.partial { background: #fde68a; color: #8a6700; }
  .badge.pending { background: #e9e9e9; color: #444; }
  .comments { border: 1px solid #ddd; min-height: 60px; padding: 8px 10px; border-radius: 3px; }
  .footline { margin-top: 24px; font-size: 11px; color: #444; }
  .sig { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-top: 8px; }
  .sig div { border-bottom: 1px solid #555; padding-bottom: 2px; height: 18px; }
</style>
${autoprint ? "<script>window.addEventListener('load', () => setTimeout(() => window.print(), 200));</script>" : ""}
</head>
<body>
  <div class="topbar">
    <div class="logo">CARBON</div>
    <div class="ship">
      SHIP FROM:
      <div class="body">${escapeHtml(detail.source_location_name)}<br/>Carbon Jeans</div>
    </div>
    <div class="ship">
      SHIP TO:
      <div class="body">${escapeHtml(detail.destination_location_name)}<br/>Carbon Jeans</div>
    </div>
  </div>

  <h2>Transfer Details</h2>
  <table class="meta">
    <thead>
      <tr>
        <th>SLIP #</th>
        <th>DATE CREATED</th>
        <th>CREATED BY</th>
        <th class="right">SENT QTY</th>
        <th class="right">TOTAL EPC's</th>
        <th class="right">TOTAL MANUAL</th>
        <th class="center">STATUS</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>${escapeHtml(slipNumber)}</td>
        <td>${escapeHtml(dateCreated)}</td>
        <td>${escapeHtml(shortName(detail.created_by_first, detail.created_by_last, detail.created_by_email))}</td>
        <td class="right">${totalSent}</td>
        <td class="right">${totalEpcs}</td>
        <td class="right">${totalManual}</td>
        <td class="center"><span class="badge ${detail.state === "received" ? "received" : detail.state === "partially_received" ? "partial" : "pending"}">${escapeHtml(stateLabel)}</span></td>
      </tr>
    </tbody>
  </table>

  <h2>Transfer Asset(s) Details</h2>
  <table>
    <thead>
      <tr>
        <th>Custom SKU</th>
        <th>UPC</th>
        <th>Item Description</th>
        <th class="right">Sent</th>
        <th class="right">Received</th>
        <th class="right">Missing</th>
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (r) => `
        <tr>
          <td>${escapeHtml(r.sku)}</td>
          <td>${escapeHtml(r.upc ?? "")}</td>
          <td>${escapeHtml(r.name ?? "")}</td>
          <td class="right">${r.sent}</td>
          <td class="right">${r.received}</td>
          <td class="right">${Math.max(0, r.sent - r.received)}</td>
        </tr>`,
        )
        .join("")}
    </tbody>
  </table>

  <h2>Comments</h2>
  <div class="comments"></div>

  <div class="footline">
    <div class="sig">
      <div></div><div></div><div></div>
    </div>
    <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-top: 4px; font-size: 10px;">
      <div>Receiver Person's Name</div>
      <div>Signature</div>
      <div>Date</div>
    </div>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
