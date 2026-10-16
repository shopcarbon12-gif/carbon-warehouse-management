import { NextResponse } from "next/server";
import type { CountReport } from "@/lib/server/count-report";
import { countReportPdf, countReportXlsx, reportFileStem } from "@/lib/server/count-report-export";

/** One count report as JSON, Excel (.xlsx) or PDF, by `?format=`. */
export async function countReportResponse(rep: CountReport, format: string | null): Promise<Response> {
  const f = (format ?? "json").toLowerCase();
  const stem = reportFileStem(rep);
  if (f === "xlsx") {
    const buf = await countReportXlsx(rep);
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${stem}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  }
  if (f === "pdf") {
    const bytes = await countReportPdf(rep);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${stem}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({ ...rep, fileStem: stem }, { headers: { "Cache-Control": "no-store" } });
}
