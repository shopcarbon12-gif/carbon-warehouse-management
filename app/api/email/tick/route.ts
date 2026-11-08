/**
 * POST /api/email/tick — CarbonWMS Email background work, called by the
 * worker every minute while anything is due (scripts/worker.ts):
 * campaign sends, AI Designer turns, conversions, code-use results, and the
 * brand media library (Shopify Files described for the designer).
 * Answers at once and works in the background. Machine traffic: not in
 * Activity history (the owner's actions that start the work are).
 */
import { NextResponse, after } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { refreshResults, runEmailSends } from "@/lib/server/email/campaigns";
import { runDesignTurns } from "@/lib/server/email/designer";
import { runConversions } from "@/lib/server/email/convert";
import { runMediaSync } from "@/lib/server/email/brand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const pool = g.pool;
  const err = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });
  after(async () => {
    const [sends, turns, conv, results, media] = await Promise.all([
      runEmailSends(pool).catch(err),
      runDesignTurns(pool).catch(err),
      runConversions(pool).catch(err),
      refreshResults(pool).catch(err),
      runMediaSync(pool).catch(err),
    ]);
    console.log(`[email] tick sends=${JSON.stringify(sends)} turns=${JSON.stringify(turns)} conversions=${JSON.stringify(conv)} results=${JSON.stringify(results)} media=${JSON.stringify(media)}`);
  });
  return NextResponse.json({ started: true }, { status: 202 });
}
