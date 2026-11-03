import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/shopify/wholesale/[id] { action: "approve" | "decline" } — decide a
 * wholesale application. Approve creates the company and buyer in Shopify and
 * Shopify sends the buyer a customer account invite; decline only marks it
 * (no email). Admin only.
 */
import { NextResponse } from "next/server";
import { welcomeAdminGuard } from "@/lib/server/welcome/guard";
import { ApproveError, approveApplication, declineApplication } from "@/lib/server/wholesale/applications";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await welcomeAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!/^\d{1,18}$/.test(id)) return NextResponse.json({ error: "Bad application id" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  const by = g.session.email ?? null;
  try {
    if (body.action === "approve") {
      return NextResponse.json({ application: await approveApplication(g.pool, Number(id), by) });
    }
    if (body.action === "decline") {
      const application = await declineApplication(g.pool, Number(id), by);
      if (!application) return NextResponse.json({ error: "Application not found" }, { status: 404 });
      return NextResponse.json({ application });
    }
    return NextResponse.json({ error: "Choose approve or decline" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not update the application";
    return NextResponse.json({ error: msg }, { status: e instanceof ApproveError ? 422 : 500 });
  }
}

export const POST = withActivity("shopify/wholesale/[id]", POST_handler);
