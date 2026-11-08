/**
 * GET /api/shopify/wholesale/[id]/certificate — the resale certificate an
 * applicant uploaded with the Wholesale form. Admin only (it carries tax IDs);
 * shown inline so the owner can read it in the browser, never cached.
 */
import { NextResponse } from "next/server";
import { welcomeAdminGuard } from "@/lib/server/welcome/guard";
import { getCertificate } from "@/lib/server/wholesale/applications";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const g = await welcomeAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!/^\d{1,18}$/.test(id)) return NextResponse.json({ error: "Bad application id" }, { status: 400 });
  const file = await getCertificate(g.pool, Number(id));
  if (!file) return NextResponse.json({ error: "No certificate on this application" }, { status: 404 });
  const download = new URL(req.url).searchParams.get("download") === "1";
  const safe = file.filename.replace(/["\\\r\n]/g, "_");
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safe}"`,
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
