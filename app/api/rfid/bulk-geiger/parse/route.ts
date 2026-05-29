import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSessionFromRequest } from "@/lib/get-session-from-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bulk Geiger upload parser. Accepts a CSV or XLSX whose rows are an EPC list
 * (one EPC per row / first column) and returns the de-duplicated EPC strings,
 * verbatim (uppercased/trimmed). We do NOT drop malformed values here — the
 * UI keeps every uploaded value as a row and fills "N/A" when it doesn't
 * resolve to a catalog item. A literal "epc" header cell is skipped.
 */

const MAX_EPCS = 5000;
const HEADERish = new Set(["epc", "epcs", "tag", "rfid", "tagid", "tag id"]);

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "Expected multipart form with a file" }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: unknown) => {
    const v = String(raw ?? "").trim();
    if (!v) return;
    if (HEADERish.has(v.toLowerCase())) return;
    const up = v.toUpperCase();
    if (seen.has(up)) return;
    seen.add(up);
    if (out.length < MAX_EPCS) out.push(up);
  };

  try {
    if (name.endsWith(".csv") || file.type === "text/csv") {
      const text = buf.toString("utf8").replace(/^﻿/, "");
      for (const line of text.split(/\r?\n/)) {
        // First column only — files are an EPC list; ignore extra columns.
        const first = line.split(",")[0]?.replace(/^"|"$/g, "");
        push(first);
      }
    } else {
      const wb = new ExcelJS.Workbook();
      // Node 22's Buffer is generic (Buffer<ArrayBuffer>); ExcelJS's load()
      // wants the legacy Buffer type — cast to exactly its expected param.
      await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
      const ws = wb.worksheets[0];
      if (ws) {
        ws.eachRow((row) => {
          const cell = row.getCell(1);
          push(cell?.text ?? cell?.value);
        });
      }
    }
  } catch {
    return NextResponse.json({ error: "Could not read the file (CSV or XLSX expected)." }, { status: 400 });
  }

  return NextResponse.json(
    { epcs: out, count: out.length, truncated: out.length >= MAX_EPCS },
    { headers: { "Cache-Control": "no-store" } },
  );
}
