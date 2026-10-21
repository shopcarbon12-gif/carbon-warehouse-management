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
 * multipart: photo (JPEG), meta {"profile":"tee","pxPerCm":15.8,"keys":["shoulder","sleeveL"],"repeat":2}
 *
 * repeat 2 (the crotch photo): two independent placements run side by side.
 * When they agree the ends are averaged; when they are more than 1.5 cm apart
 * a third runs and the closest pair is kept. `spreadCm` says how far apart the
 * kept pair landed, so the phone can still flag a crotch the AI is unsure of
 * (owner, 2026-10-20: scan 1 put the crotch 5.6 cm too high).
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
  let meta: { profile?: string; pxPerCm?: number; keys?: string[]; repeat?: number };
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
    const image = Buffer.from(await photo.arrayBuffer());
    const run = () => measureWithAgent(
      { image, pxPerCm, type: profile.family, view: "front", keys: [], points, scale: "depth" },
      { provider: cfg.provider, model: cfg.model, maxRounds: cfg.maxRounds, thinkingBudget: cfg.thinkingBudget, effort: cfg.effort, deadlineMs: 140_000 },
    );
    if (meta.repeat === 2) {
      const [a, b] = await Promise.all([run(), run().catch(() => null)]);
      let runs = [a, ...(b ? [b] : [])];
      let pick = mergeRuns(a.lines as Lines, (b?.lines ?? {}) as Lines, pxPerCm);
      /* Two answers far apart: averaging them gives a point neither chose
         (owner's scan 2026-10-21: 6 cm apart, the mean landed 3 cm too high).
         A third placement breaks the tie and the two that agree are kept. */
      if (b && Math.max(0, ...Object.values(pick.spreadCm)) > 1.5) {
        const c3 = await run().catch(() => null);
        if (c3) {
          runs = [a, b, c3];
          const pairs: [number, number][] = [[0, 1], [0, 2], [1, 2]];
          const merged = pairs.map(([i, j]) => mergeRuns(runs[i].lines as Lines, runs[j].lines as Lines, pxPerCm));
          const worst = (m: ReturnType<typeof mergeRuns>) => Math.max(0, ...Object.values(m.spreadCm));
          pick = merged.reduce((best, m) => (worst(m) < worst(best) ? m : best));
        }
      }
      const cost = runs.reduce((s, r) => s + (Number.isFinite(r.costUsd) ? r.costUsd : 0), 0);
      return NextResponse.json({
        lines: pick.lines, cm: a.cm, skipped: a.skipped, remarks: a.remarks, model: a.model, costUsd: cost || null,
        ms: Math.max(...runs.map((r) => r.ms)), rounds: a.rounds, zooms: a.zooms, spreadCm: pick.spreadCm, runs: runs.length,
      });
    }
    const result = await run();
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

type XY = { x: number; y: number };
type Lines = Record<string, { a: XY; b: XY }>;

/** Two placements of the same points: averaged ends, and how far apart the two runs put each point (cm). */
function mergeRuns(a: Lines, b: Lines, pxPerCm: number): { lines: Lines; spreadCm: Record<string, number> } {
  const lines: Lines = {};
  const spreadCm: Record<string, number> = {};
  const d = (p: XY, q: XY) => Math.hypot(p.x - q.x, p.y - q.y);
  const mid = (p: XY, q: XY) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  for (const [k, la] of Object.entries(a)) {
    const lb = b[k];
    if (!lb) { lines[k] = la; continue; }
    // The second run may have drawn the line the other way round.
    const flip = d(la.a, lb.b) + d(la.b, lb.a) < d(la.a, lb.a) + d(la.b, lb.b);
    const ob = flip ? { a: lb.b, b: lb.a } : lb;
    spreadCm[k] = Math.round((Math.max(d(la.a, ob.a), d(la.b, ob.b)) / pxPerCm) * 10) / 10;
    lines[k] = { a: mid(la.a, ob.a), b: mid(la.b, ob.b) };
  }
  return { lines, spreadCm };
}

export const POST = withActivity("grading-app/assist", POST_handler);
