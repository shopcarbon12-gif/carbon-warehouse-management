import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { adjustScan, getScan, reviewScan, UUID_RE, type ScanLine } from "@/lib/server/grading-app";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET → one scan with its lines.
 * PATCH {action: approve|redo|flag, note?} → review it.
 * PATCH {action: "adjust", lines, crotchLines?} → lines moved on the desktop; the
 *   numbers are worked out again and replace the scan's readings on its items.
 */
export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const scan = await getScan(pool, id);
  if (!scan) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ scan });
}

const Body = z.object({ action: z.enum(["approve", "redo", "flag"]), note: z.string().max(500).optional() });

const Line = z.object({
  pts: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2).max(4),
  source: z.enum(["outline", "ai", "manual"]),
  moved: z.boolean().optional(),
});
const Adjust = z.object({
  action: z.literal("adjust"),
  lines: z.record(z.string(), Line),
  crotchLines: z.record(z.string(), Line).nullish(),
});

async function PATCH_handler(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  if ((body as { action?: string }).action === "adjust") {
    const adj = Adjust.safeParse(body);
    if (!adj.success) return NextResponse.json({ error: adj.error.issues[0]?.message ?? "Invalid lines" }, { status: 400 });
    const out = await adjustScan(pool, id, adj.data.lines as Record<string, ScanLine>, (adj.data.crotchLines ?? null) as Record<string, ScanLine> | null, session.sub ?? null);
    if (!out) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if ("refused" in out) {
      return NextResponse.json({ error: "This scan was redone — its readings were removed. Measure the garment again." }, { status: 409 });
    }
    return NextResponse.json({ ok: true, ...out });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "action must be approve, redo or flag" }, { status: 400 });
  const out = await reviewScan(pool, id, parsed.data.action, parsed.data.note ?? null, session.sub ?? null);
  if (!out) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if ("refused" in out) {
    return NextResponse.json({ error: "This scan was redone — its readings were removed. Measure the garment again." }, { status: 409 });
  }
  return NextResponse.json({ ok: true, ...out });
}

export const PATCH = withActivity("grading-app/scans/[id]", PATCH_handler);
