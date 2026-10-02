import OpenAI from "openai";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { updateStudioGenerationQa } from "@/lib/server/studio-generation-log";
import {
  claimRunQa,
  hasRunQa,
  isValidRunId,
  readRunContext,
  readRunPanels,
  releaseRunPanels,
  startRunQa,
} from "@/lib/server/run-qa-store";
import { runRunQa } from "@/lib/server/run-qa";

/**
 * Run-level QA: audit a whole generation run once, instead of each panel alone.
 *
 * POST { runId } — start the two judges on the panels cached for that run.
 *   Returns immediately with the id to poll; the images are already on the
 *   server, so the browser uploads nothing.
 * GET ?id=<runId> — collect the verdict.
 *
 * Why this exists rather than a judge per panel: see lib/server/run-qa.ts.
 */
export const dynamic = "force-dynamic";

const QA_TIMEOUT_MS = Math.max(
  30_000,
  Math.min(Number(process.env.OPENAI_IMAGE_TIMEOUT_MS) || 240_000, 120_000),
);

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const runId = String((body as Record<string, unknown>)?.runId ?? "").trim();
  if (!isValidRunId(runId)) return NextResponse.json({ error: "Invalid run id" }, { status: 400 });

  /* Started already — the operator hit regenerate twice, or a retry raced.
     Point them at the verdict in flight rather than paying for a second pair
     of judges on the same images. */
  if (hasRunQa(runId)) return NextResponse.json({ qaId: runId, pending: true, reused: true });

  const panels = readRunPanels(runId);
  if (!panels.length) {
    /* The container restarted, or the run aged out, between the last panel and
       this call. Say so — it is not a pass. */
    return NextResponse.json({ error: "No panels are held for this run." }, { status: 404 });
  }
  const context = readRunContext(runId);
  const apiKey = String(getOpenAiApiKey() || "").trim();
  if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
  const openai = new OpenAI({ apiKey });

  void startRunQa(runId, async () => {
    const verdict = await runRunQa({
      openai,
      panels,
      itemRefs: context?.itemRefs ?? [],
      itemRefViews: context?.itemRefViews,
      modelRefs: context?.modelRefs ?? [],
      itemSpec: context?.itemSpec,
      itemType: context?.itemType ?? "",
      colorName: context?.colorName ?? "",
      timeoutMs: QA_TIMEOUT_MS,
    });
    /* The images are the expensive thing to hold; the verdict is bytes. */
    releaseRunPanels(runId);
    if (verdict.findings.length) {
      console.warn(
        `[run-qa] ${runId}: ${verdict.findings.length} finding(s) — ` +
          verdict.findings.map((f) => `P${f.panel}${f.frame[0].toUpperCase()} ${f.text}`).join(" | "),
      );
    }
    /* Log each panel's own findings back onto its studio_generations row, so
       "what did the judge say" stays answerable from the database. */
    for (const p of panels) {
      if (!p.logId) continue;
      const mine = verdict.findings.filter((f) => f.panel === p.panel).map((f) => f.text);
      updateStudioGenerationQa(p.logId, {
        qaDecisive: !verdict.unavailable,
        qaPass: verdict.unavailable ? null : mine.length === 0,
        qaWarnings: mine.length,
        qaReasons: mine,
        qaNotes: verdict.notes,
        qaDropped: 0,
      });
    }
    return verdict;
  });

  return NextResponse.json({ qaId: runId, pending: true });
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!isValidRunId(id)) return NextResponse.json({ error: "Invalid run id" }, { status: 400 });

  const claimed = claimRunQa(id);
  if (claimed.status === "missing") {
    return NextResponse.json({ status: "missing" }, { status: 404 });
  }
  if (claimed.status === "running") {
    return NextResponse.json({ status: "running" }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(
    { status: "done", ...claimed.verdict },
    { headers: { "Cache-Control": "no-store" } },
  );
}
