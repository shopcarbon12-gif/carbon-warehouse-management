import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { fmtET, type CountReport } from "@/lib/server/count-report";

/**
 * Excel + PDF for a count report (lib/server/count-report.ts). Page / sheet 1
 * is the summary; then every NEW Unknown tag with all its information, then
 * the defective tags. Times are Eastern (the warehouse's).
 */

type Col = { label: string; width: number; get: (r: Record<string, unknown>) => string };

const yes = (b: unknown) => (b ? "NEW in this count" : "Found earlier");

function summaryPairs(rep: CountReport): [string, string][] {
  const meta: [string, string][] = [
    ["Report", rep.title],
    ["Type", rep.activity],
  ];
  if (rep.location) meta.push(["Location", rep.location]);
  if (rep.startedAt) meta.push(["Started", fmtET(rep.startedAt)]);
  if (rep.endedAt) meta.push(["Ended", fmtET(rep.endedAt)]);
  if (rep.by.length) meta.push(["Counted by", rep.by.join(", ")]);
  if (rep.devices.length) meta.push(["Handhelds / readers", rep.devices.join(", ")]);
  meta.push(["Generated", fmtET(rep.generatedAt)]);
  return meta;
}

function totalPairs(rep: CountReport): [string, string][] {
  const t = rep.totals;
  if (rep.kind === "unverified") return [["New Unknown tags waiting to be verified", String(t.newUnknown)]];
  return [
    ["Tags read", String(t.read)],
    ["Live (known tags)", String(t.live)],
    ["Came back from Unknown → Live", String(t.cameBack)],
    ["NEW Unknown tags found in this count", String(t.newUnknown)],
    ["Unknown found in an earlier count, still not verified", String(t.earlierUnknown)],
    ["Defective (TAG KILLED)", String(t.defective)],
    ["Other (sold, damaged, …)", String(t.other)],
    ["   of which not in the WMS (count saved, never uploaded)", String(t.notInWms)],
  ];
}

const s = (v: unknown) => (v == null ? "" : String(v));

function unknownCols(rep: CountReport, full: boolean): Col[] {
  const inCount = rep.kind !== "unverified";
  const cols: Col[] = [
    { label: "EPC", width: full ? 28 : 128, get: (r) => s(r.epc) },
    { label: "Product", width: full ? 30 : 96, get: (r) => s(r.product) },
    { label: "Color", width: full ? 14 : 50, get: (r) => s(r.color) },
    { label: "Size", width: full ? 8 : 30, get: (r) => s(r.size) },
    { label: "SKU", width: full ? 16 : 72, get: (r) => s(r.sku) },
  ];
  if (full) {
    cols.push(
      { label: "UPC", width: 12, get: (r) => s(r.upc) },
      { label: "Price", width: 9, get: (r) => s(r.price) },
      { label: "Serial", width: 11, get: (r) => s(r.serial) },
    );
  }
  cols.push({ label: "Bin", width: full ? 9 : 36, get: (r) => s(r.bin) });
  if (inCount) {
    cols.push(
      { label: full ? "Read in this count (ET)" : "Read (ET)", width: full ? 22 : 70, get: (r) => fmtET(s(r.readAt) || null, full, full) },
      { label: "Read by", width: full ? 26 : 140, get: (r) => s(r.readBy) },
    );
    if (full) {
      cols.push(
        { label: "First found (ET)", width: 22, get: (r) => fmtET(s(r.firstFoundAt) || null, true) },
        { label: "First found by", width: 26, get: (r) => s(r.firstFoundBy) },
      );
    }
    cols.push({ label: full ? "Found in this count?" : "Found", width: full ? 18 : 42, get: (r) => (full ? yes(r.foundHere) : r.foundHere ? "NEW" : "Earlier") });
  } else {
    cols.push(
      { label: "First found (ET)", width: full ? 22 : 80, get: (r) => fmtET(s(r.firstFoundAt) || null, full, full) },
      { label: "First found by", width: full ? 26 : 148, get: (r) => s(r.firstFoundBy) },
      { label: "Last seen (ET)", width: full ? 22 : 80, get: (r) => fmtET(s(r.lastSeenAt) || null, full, full) },
    );
  }
  // PDF of the waiting list: every row is "Unknown — not verified" — no column.
  if (full || inCount) {
    cols.push({
      label: "Status now",
      width: full ? 34 : 50,
      // PDF: "Unknown" / "Live, verified Oct 18" — the full text is in Excel.
      get: (r) => (full ? s(r.statusNow) : s(r.statusNow).replace(" — not verified", "").replace(/ — verified (\w+ \d+).*/, " $1")),
    });
  }
  return cols;
}

const defectCols = (full: boolean): Col[] => [
  { label: "EPC", width: full ? 28 : 170, get: (r) => s(r.epc) },
  { label: "Reason", width: full ? 34 : 200, get: (r) => s(r.reason) },
  { label: "Read (ET)", width: full ? 22 : 120, get: (r) => fmtET(s(r.readAt) || null, full) },
  { label: "Read by", width: full ? 30 : 160, get: (r) => s(r.readBy) },
];

export async function countReportXlsx(rep: CountReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Carbon WMS";
  const sum = wb.addWorksheet("Summary");
  sum.columns = [{ width: 52 }, { width: 70 }];
  sum.addRow([rep.title]).font = { bold: true, size: 14 };
  sum.addRow([]);
  for (const [k, v] of summaryPairs(rep)) sum.addRow([k, v]).getCell(1).font = { bold: true };
  sum.addRow([]);
  sum.addRow(["Totals"]).font = { bold: true, size: 12 };
  for (const [k, v] of totalPairs(rep)) {
    const row = sum.addRow([k, Number(v)]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { horizontal: "left" };
  }

  const addTable = (name: string, cols: Col[], rows: Record<string, unknown>[]) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map((c) => ({ header: c.label, width: c.width }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEEE" } };
    for (const r of rows) ws.addRow(cols.map((c) => c.get(r)));
    ws.views = [{ state: "frozen", ySplit: 1 }];
    if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  };
  addTable("New Unknown tags", unknownCols(rep, true), rep.unknown as unknown as Record<string, unknown>[]);
  if (rep.kind !== "unverified") addTable("Defective", defectCols(true), rep.defective as unknown as Record<string, unknown>[]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── PDF ──────────────────────────────────────────────────────────────────────

/** Standard PDF fonts only draw WinAnsi; anything else becomes "?". */
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
function safe(text: string): string {
  return text
    .replace(/→/g, "->")
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .split("")
    .map((ch) => {
      const c = ch.charCodeAt(0);
      if (c === 9) return " ";
      if ((c >= 32 && c < 127) || (c >= 160 && c <= 255) || WIN_ANSI_EXTRA.includes(ch)) return ch;
      return "?";
    })
    .join("");
}

function fit(text: string, font: PDFFont, size: number, width: number): string {
  let t = safe(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1);
  return `${t}…`;
}

export async function countReportPdf(rep: CountReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(safe(rep.title));
  doc.setCreator("Carbon WMS");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 792, H = 612, M = 36;
  const ink = rgb(0.13, 0.15, 0.15), muted = rgb(0.42, 0.47, 0.47), band = rgb(0.91, 0.93, 0.93), line = rgb(0.8, 0.84, 0.84);

  // Page 1 — summary.
  let page = doc.addPage([W, H]);
  let y = H - M;
  page.drawText(fit(rep.title, bold, 18, W - 2 * M), { x: M, y: y - 18, size: 18, font: bold, color: ink });
  y -= 34;
  for (const [k, v] of summaryPairs(rep).slice(1)) {
    page.drawText(safe(k), { x: M, y: y - 11, size: 10, font: bold, color: muted });
    page.drawText(fit(v, font, 10, W - 2 * M - 160), { x: M + 160, y: y - 11, size: 10, font, color: ink });
    y -= 16;
  }
  y -= 14;
  page.drawText("Totals", { x: M, y: y - 13, size: 13, font: bold, color: ink });
  y -= 22;
  for (const [k, v] of totalPairs(rep)) {
    page.drawRectangle({ x: M, y: y - 22, width: 520, height: 22, borderColor: line, borderWidth: 0.6 });
    page.drawText(safe(k), { x: M + 8, y: y - 15, size: 11, font, color: ink });
    page.drawText(safe(v), { x: M + 450, y: y - 15, size: 12, font: bold, color: ink });
    y -= 22;
  }
  if (rep.unknown.length) {
    y -= 18;
    page.drawText(
      safe(`Next: check the ${rep.unknown.length} Unknown tag${rep.unknown.length === 1 ? "" : "s"} with Cloud + Geiger and change them to LIVE when found.`),
      { x: M, y: y - 11, size: 10, font, color: muted },
    );
  }

  const table = (title: string, cols: Col[], rows: Record<string, unknown>[]) => {
    const size = 8;
    const rowH = 14;
    const startPage = () => {
      page = doc.addPage([W, H]);
      y = H - M;
      page.drawText(safe(title), { x: M, y: y - 13, size: 13, font: bold, color: ink });
      y -= 24;
      header();
    };
    const header = () => {
      page.drawRectangle({ x: M, y: y - rowH, width: W - 2 * M, height: rowH, color: band });
      let x = M + 3;
      for (const c of cols) {
        page.drawText(fit(c.label, bold, size, c.width - 6), { x, y: y - rowH + 4, size, font: bold, color: ink });
        x += c.width;
      }
      y -= rowH;
    };
    startPage();
    if (rows.length === 0) {
      page.drawText("None.", { x: M + 3, y: y - rowH + 4, size: 9, font, color: muted });
      return;
    }
    for (const r of rows) {
      if (y - rowH < M + 18) {
        startPage();
      }
      let x = M + 3;
      for (const c of cols) {
        page.drawText(fit(c.get(r), font, size, c.width - 6), { x, y: y - rowH + 4, size, font, color: ink });
        x += c.width;
      }
      page.drawLine({ start: { x: M, y: y - rowH }, end: { x: W - M, y: y - rowH }, thickness: 0.4, color: line });
      y -= rowH;
    }
  };

  table(
    `${rep.kind === "unverified" ? "New Unknown tags — not verified" : "New Unknown tags"} (${rep.unknown.length})`,
    unknownCols(rep, false),
    rep.unknown as unknown as Record<string, unknown>[],
  );
  if (rep.kind !== "unverified") {
    table(`Defective tags — TAG KILLED (${rep.defective.length})`, defectCols(false), rep.defective as unknown as Record<string, unknown>[]);
  }

  const pages = doc.getPages();
  pages.forEach((p: PDFPage, i: number) => {
    p.drawText(fit(`Carbon WMS · ${rep.title} · page ${i + 1} of ${pages.length}`, font, 8, W - 2 * M), {
      x: M,
      y: M - 18,
      size: 8,
      font,
      color: muted,
    });
  });
  return doc.save();
}

/** Safe file name stem for downloads. */
export function reportFileStem(rep: CountReport): string {
  const stamp = fmtET(rep.endedAt ?? rep.generatedAt).replace(/[^0-9A-Za-z]+/g, "-");
  return `${rep.activity.toLowerCase().replace(/[^a-z0-9]+/g, "-")}_${stamp}`.replace(/-+/g, "-").replace(/^-|-$/g, "");
}
