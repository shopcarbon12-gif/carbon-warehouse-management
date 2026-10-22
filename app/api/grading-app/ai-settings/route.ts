import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { gradingAppAgentConfig } from "@/lib/server/size-grading-agent";
import { AI_AREAS, AI_AREA_LABEL, areaCosts, getAiSettings, gradingAiBatchOn, saveAiSettings, type AiSettings } from "@/lib/server/grading-app-ai";

export const dynamic = "force-dynamic";

/**
 * CarbonGradingAI's AI switch (the app's Settings → AI): GET → the switch, the
 * model and each area's cost per size; PUT {enabled, areas} → save it. Every
 * phone follows it on its next start (the app also reloads its config after a save).
 */
async function view(pool: NonNullable<ReturnType<typeof getPool>>, tenantId: string | null | undefined) {
  const model = gradingAppAgentConfig();
  const settings = await getAiSettings(pool, tenantId);
  const costs = await areaCosts(pool, model?.model ?? null);
  return {
    settings,
    model: model?.model ?? null,
    batch: gradingAiBatchOn(),
    areas: AI_AREAS.map((a) => ({ id: a, label: AI_AREA_LABEL[a], on: settings.areas[a], ...costs[a] })),
  };
}

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  return NextResponse.json(await view(pool, session.tid));
}

const Body = z.object({
  enabled: z.boolean(),
  areas: z.object({ sleeves: z.boolean(), crotch: z.boolean(), chest: z.boolean(), other: z.boolean() }),
});

async function PUT_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = (session.role ?? "").trim().toLowerCase();
  if (role !== "admin" && role !== "manager") {
    return NextResponse.json({ error: "Only an admin or manager can change the AI switch." }, { status: 403 });
  }
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  if (!session.tid) return NextResponse.json({ error: "No tenant on this session" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "enabled and areas {sleeves, crotch, chest, other} are required" }, { status: 400 });
  await saveAiSettings(pool, session.tid, parsed.data as AiSettings, session.sub ?? null);
  return NextResponse.json({ ok: true, ...(await view(pool, session.tid)) });
}

export const PUT = withActivity("grading-app/ai-settings", PUT_handler);
