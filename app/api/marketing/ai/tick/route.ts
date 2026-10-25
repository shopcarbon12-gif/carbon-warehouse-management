/**
 * POST /api/marketing/ai/tick — Social's "Ask for changes" AI: carry out queued
 * notes and collect pictures back from the OpenAI batch
 * (lib/server/marketing/ai-changes.ts). The worker calls it every minute while
 * anything is queued or out; it answers at once and works in the background.
 * Machine traffic: not in Activity history (asking for changes itself is).
 */
import { NextResponse, after } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { runMarketingAi } from "@/lib/server/marketing/ai-changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const pool = g.pool;
  after(async () => {
    const r = await runMarketingAi(pool).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    console.log(`[social-ai] tick ${JSON.stringify(r)}`);
  });
  return NextResponse.json({ started: true }, { status: 202 });
}
