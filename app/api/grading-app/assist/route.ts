import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { gradingAppAgentConfig, measureWithAgent } from "@/lib/server/size-grading-agent";
import { PROFILE_BY_ID, type GradingProfileId } from "@/lib/size-grading/grading-app-profiles";

/**
 * CarbonGradingAI's AI assist. The phone sends its squared-up photo (scale
 * from the depth sensor) and the points it wants placed — by default only the
 * seam-based ones the outline cannot see (shoulder seams, crotch, sleeve
 * start, straps). The same close-up agent as the desktop Size Grading page
 * places them; lines come back in the photo's pixels.
 *
 * multipart: photo (JPEG), meta {"profile":"tee","pxPerCm":15.8,"keys":["shoulder","sleeveL"]}
 */
export const runtime = "nodejs";
export const maxDuration = 180;

const MAX_PHOTO = 12_000_000;

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cfg = gradingAppAgentConfig();
  if (!cfg) return NextResponse.json({ error: "AI assist is off on the server." }, { status: 503 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });
  }
  const photo = form.get("photo");
  const metaRaw = form.get("meta");
  if (!(photo instanceof Blob) || typeof metaRaw !== "string") {
    return NextResponse.json({ error: "photo and meta are required." }, { status: 400 });
  }
  if (photo.size > MAX_PHOTO) return NextResponse.json({ error: "Photo too large." }, { status: 413 });
  let meta: { profile?: string; pxPerCm?: number; keys?: string[] };
  try {
    meta = JSON.parse(metaRaw);
  } catch {
    return NextResponse.json({ error: "meta is not JSON." }, { status: 400 });
  }
  const profile = PROFILE_BY_ID[(meta.profile ?? "") as GradingProfileId];
  const pxPerCm = Number(meta.pxPerCm);
  if (!profile) return NextResponse.json({ error: "Unknown garment type." }, { status: 400 });
  if (!Number.isFinite(pxPerCm) || pxPerCm <= 0) return NextResponse.json({ error: "pxPerCm required." }, { status: 400 });
  const want = new Set(meta.keys?.length ? meta.keys : profile.points.filter((p) => p.hard).map((p) => p.key));
  const points = profile.points.filter((p) => want.has(p.key)).map((p) => ({ key: p.key, label: p.label, rule: p.rule }));
  if (!points.length) return NextResponse.json({ error: "No points to place." }, { status: 400 });

  try {
    const result = await measureWithAgent(
      { image: Buffer.from(await photo.arrayBuffer()), pxPerCm, type: profile.family, view: "front", keys: [], points, scale: "depth" },
      { provider: cfg.provider, model: cfg.model, maxRounds: cfg.maxRounds, thinkingBudget: cfg.thinkingBudget, effort: cfg.effort, deadlineMs: 140_000 },
    );
    return NextResponse.json({
      lines: result.lines, cm: result.cm, skipped: result.skipped, remarks: result.remarks,
      model: result.model, costUsd: Number.isFinite(result.costUsd) ? result.costUsd : null, ms: result.ms,
      rounds: result.rounds, zooms: result.zooms,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[grading-app/assist]", reason);
    return NextResponse.json({ error: `AI assist failed — ${reason}` }, { status: 502 });
  }
}

export const POST = withActivity("grading-app/assist", POST_handler);
