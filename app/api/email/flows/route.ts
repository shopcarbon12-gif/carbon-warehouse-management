import { withActivity } from "@/lib/server/activity-log";
/**
 * GET  /api/email/flows — the automatic emails (flows), with their numbers.
 * POST /api/email/flows — a new flow: { kind: "welcome" | "abandoned" | "thanks" | "winback" | "birthday" | "custom" }
 *      (a ready-made one comes with its emails, made from the matching starters).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { createFlow, listFlows } from "@/lib/server/email/flows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  return NextResponse.json({ flows: await listFlows(g.pool, g.session.tid) });
}

const schema = z
  .object({
    kind: z.enum(["welcome", "abandoned", "thanks", "winback", "birthday", "custom"]),
  })
  .strict();

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const p = schema.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    return NextResponse.json({
      id: await createFlow(g.pool, g.session.tid, g.session.email ?? null, p.data.kind),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const POST = withActivity("email/flows", POST_handler);
