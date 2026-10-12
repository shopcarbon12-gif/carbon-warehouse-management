import { withActivity } from "@/lib/server/activity-log";
/**
 * Size Grading — the AI measures the garment (lib/server/size-grading-agent.ts).
 *
 * The phone sends the squared-up picture and its exact scale; the AI places
 * every measurement's end points, looking closer as often as it needs, and the
 * lengths come back in centimetres with what the reading cost.
 *
 * Provider and model: SIZE_GRADING_PROVIDER (claude | openai; default Claude
 * when its key exists), SIZE_GRADING_CLAUDE_MODEL (default claude-opus-5-5),
 * SIZE_GRADING_OPENAI_MODEL (default gpt-5.5), SIZE_GRADING_ROUNDS (close-up
 * rounds, default 5). 503 when no key is configured — the phone then falls back
 * to its own cut-out.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { ALL_POMS } from "@/lib/size-grading/garment";
import { agentConfig, measureWithAgent } from "@/lib/server/size-grading-agent";

export const runtime = "nodejs";
export const maxDuration = 180;

/** A 1400 px JPEG is ~300–600 kB as a data URL; this refuses anything silly. */
const MAX_DATA_URL = 12_000_000;

const Body = z.object({
  image: z.string().startsWith("data:image/").max(MAX_DATA_URL),
  pxPerCm: z.number().positive().max(200),
  type: z.enum(["top", "trousers", "shorts", "dress", "skirt", "onepiece"]).nullable().optional(),
  view: z.enum(["front", "back"]).default("front"),
  keys: z.array(z.enum(ALL_POMS)).max(ALL_POMS.length).default([]),
});

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const cfg = agentConfig();
  if (!cfg) return NextResponse.json({ error: "The AI is not configured on this server." }, { status: 503 });
  const { image, pxPerCm, type, view, keys } = parsed.data;
  const b64 = image.slice(image.indexOf(",") + 1);
  try {
    const result = await measureWithAgent(
      { image: Buffer.from(b64, "base64"), pxPerCm, type: type ?? null, view, keys },
      { provider: cfg.provider, model: cfg.model, maxRounds: cfg.maxRounds, thinkingBudget: cfg.thinkingBudget, effort: cfg.effort },
    );
    console.info(
      `[size-grading] ${cfg.provider}:${cfg.model} measured ${Object.keys(result.lines).length} points in ${(result.ms / 1000).toFixed(0)} s, ` +
        `${result.zooms} close-ups, $${result.costUsd.toFixed(4)}`,
    );
    return NextResponse.json({ result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "The AI request failed.";
    const aborted = e instanceof Error && e.name === "AbortError";
    return NextResponse.json({ error: aborted ? "The AI took too long to answer." : msg }, { status: aborted ? 504 : 502 });
  }
}

export const POST = withActivity("inventory/size-grading/ai-measure", POST_handler);
