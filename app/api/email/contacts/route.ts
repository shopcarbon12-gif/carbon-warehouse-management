import { withActivity } from "@/lib/server/activity-log";
/**
 * GET  /api/email/contacts                 — the list in numbers.
 * GET  /api/email/contacts?audience=<json> — how many people an audience reaches.
 * POST /api/email/contacts                 — "Sync contacts": Rewards + Shopify → email_contacts.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { audienceCount, contactSummary, syncContacts, type Audience } from "@/lib/server/email/contacts";
import { parseAudience } from "@/lib/server/email/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const raw = new URL(req.url).searchParams.get("audience");
  if (raw) {
    let a: Audience | null = null;
    try {
      a = parseAudience(JSON.parse(raw));
    } catch {
      a = null;
    }
    if (!a) return NextResponse.json({ error: "Invalid audience" }, { status: 400 });
    return NextResponse.json({ count: await audienceCount(g.pool, g.session.tid, a) });
  }
  return NextResponse.json({ summary: await contactSummary(g.pool, g.session.tid) });
}

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  try {
    const result = await syncContacts(g.pool, g.session.tid);
    return NextResponse.json({ result, summary: await contactSummary(g.pool, g.session.tid) });
  } catch (e) {
    return NextResponse.json({ error: `Sync failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}

export const POST = withActivity("email/contacts", POST_handler);
