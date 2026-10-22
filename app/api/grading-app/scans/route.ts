import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listScans, saveScan, UUID_RE, type ScanMeta } from "@/lib/server/grading-app";
import { PROFILE_BY_ID } from "@/lib/size-grading/grading-app-profiles";

/**
 * POST (multipart: meta JSON + photo JPEG [+ crotchPhoto JPEG for bottoms]) — a measurement from CarbonGradingAI.
 *   Saved as a scan (photo in R2, copy to the owner's Dropbox folder) and as
 *   size_grading_measurements rows on every colour of the size and every
 *   product of its cut group. Returns where it was applied and the size check.
 * GET ?status=flagged|saved|approved|redo|all&limit=50 — the review list.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const Line = z.object({
  pts: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2).max(4),
  source: z.enum(["outline", "ai", "manual"]),
  moved: z.boolean().optional(),
});

const Meta = z.object({
  id: z.string().regex(UUID_RE),
  customSkuId: z.string().regex(UUID_RE),
  profile: z.string().refine((p) => p in PROFILE_BY_ID, "Unknown garment type"),
  view: z.enum(["front", "back"]).optional(),
  pointsCm: z.record(z.string(), z.number().finite().positive().max(400)),
  lines: z.record(z.string(), Line),
  aiLines: z.record(z.string(), z.unknown()).nullish(),
  outlineLines: z.record(z.string(), z.unknown()).nullish(),
  pxPerCm: z.number().finite().positive(),
  photoW: z.number().int().positive().optional(),
  photoH: z.number().int().positive().optional(),
  depth: z.record(z.string(), z.unknown()).nullish(),
  device: z.record(z.string(), z.unknown()).nullish(),
  appVersion: z.string().max(40).optional(),
  aiModel: z.string().max(80).nullish(),
  aiCostUsd: z.number().finite().nullish(),
  capturedAt: z.string().max(40).nullish(),
  flags: z.array(z.string().max(200)).max(30).optional(),
  /** Re-scan: the scan this one replaces. */
  replaces: z.string().regex(UUID_RE).nullish(),
  crotch: z
    .object({
      pxPerCm: z.number().finite().positive(),
      photoW: z.number().int().positive().optional(),
      photoH: z.number().int().positive().optional(),
      lines: z.record(z.string(), Line),
      aiLines: z.record(z.string(), z.unknown()).nullish(),
      outlineLines: z.record(z.string(), z.unknown()).nullish(),
      depth: z.record(z.string(), z.unknown()).nullish(),
    })
    .nullish(),
});

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });
  }
  const metaRaw = form.get("meta");
  const photo = form.get("photo");
  if (typeof metaRaw !== "string") return NextResponse.json({ error: "meta is required." }, { status: 400 });
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(metaRaw);
  } catch {
    return NextResponse.json({ error: "meta is not JSON." }, { status: 400 });
  }
  const parsed = Meta.safeParse(parsedJson);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json({ error: `${i?.path.join(".") || "meta"}: ${i?.message ?? "invalid"}` }, { status: 400 });
  }
  if (!Object.keys(parsed.data.pointsCm).length) return NextResponse.json({ error: "No measurements to save." }, { status: 400 });
  const bytes = photo instanceof Blob && photo.size ? Buffer.from(await photo.arrayBuffer()) : null;
  const crotch = form.get("crotchPhoto");
  const crotchBytes = crotch instanceof Blob && crotch.size ? Buffer.from(await crotch.arrayBuffer()) : null;
  try {
    const out = await saveScan(pool, session.sub ?? null, parsed.data as ScanMeta, bytes, crotchBytes);
    return NextResponse.json(out);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[grading-app/scans] save failed:", reason);
    return NextResponse.json({ error: `Could not save — ${reason}` }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const sp = new URL(req.url).searchParams;
  const cutGroupId = sp.get("cutGroupId") ?? undefined;
  const matrixId = sp.get("matrixId") ?? undefined;
  if ((cutGroupId && !UUID_RE.test(cutGroupId)) || (matrixId && !UUID_RE.test(matrixId))) {
    return NextResponse.json({ error: "Bad id" }, { status: 400 });
  }
  const rows = await listScans(pool, { status: sp.get("status") ?? "all", limit: Number(sp.get("limit") || 50), cutGroupId, matrixId });
  return NextResponse.json({ scans: rows });
}

export const POST = withActivity("grading-app/scans", POST_handler);
