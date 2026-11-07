import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/email/settings/ses — "Set up Amazon SES": adds the sending domain
 * (DKIM + MAIL FROM), the configuration set and the SNS event tracking, and
 * answers with the DNS records to add. Safe to press again.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { setupSes } from "@/lib/server/email/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  try {
    return NextResponse.json({ ses: await setupSes(g.pool, g.session.tid) });
  } catch (e) {
    return NextResponse.json({ error: `Amazon SES set-up failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}

export const POST = withActivity("email/settings/ses", POST_handler);
