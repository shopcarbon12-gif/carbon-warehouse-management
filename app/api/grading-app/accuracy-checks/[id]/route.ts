import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { UUID_RE } from "@/lib/server/grading-app";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH {corners: [[x,y] ×4, TL TR BR BL], trueW?, trueH?} — corners (or the true
 * size) corrected on the desktop. Width, height and diagonal are worked out again
 * from the check's own scale, exactly as the phone does: each the mean of its two
 * opposite sides.
 */
const Pt = z.tuple([z.number().finite(), z.number().finite()]);
const Body = z.object({
  corners: z.array(Pt).length(4).optional(),
  trueW: z.number().positive().max(500).optional(),
  trueH: z.number().positive().max(500).optional(),
});

async function PATCH_handler(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  const cur = await pool.query<{ px_per_cm: string | null; corners: [number, number][] | null }>(
    `SELECT px_per_cm, corners FROM grading_accuracy_checks WHERE id = $1::uuid`, [id],
  );
  const row = cur.rows[0];
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const corners = parsed.data.corners ?? row.corners;
  let sizes: { w: number; h: number; d: number } | null = null;
  if (parsed.data.corners) {
    const ppc = Number(row.px_per_cm);
    if (!corners || !Number.isFinite(ppc) || ppc <= 0) return NextResponse.json({ error: "This check has no photo scale." }, { status: 409 });
    const d = (i: number, j: number) => Math.hypot(corners[j][0] - corners[i][0], corners[j][1] - corners[i][1]) / ppc;
    sizes = { w: (d(0, 1) + d(3, 2)) / 2, h: (d(0, 3) + d(1, 2)) / 2, d: (d(0, 2) + d(1, 3)) / 2 };
  }
  await pool.query(
    `UPDATE grading_accuracy_checks
        SET corners = COALESCE($2::jsonb, corners),
            measured_w_cm = COALESCE($3, measured_w_cm), measured_h_cm = COALESCE($4, measured_h_cm), measured_diag_cm = COALESCE($5, measured_diag_cm),
            true_w_cm = COALESCE($6, true_w_cm), true_h_cm = COALESCE($7, true_h_cm)
      WHERE id = $1::uuid`,
    [id, parsed.data.corners ? JSON.stringify(corners) : null, sizes?.w ?? null, sizes?.h ?? null, sizes?.d ?? null, parsed.data.trueW ?? null, parsed.data.trueH ?? null],
  );
  return NextResponse.json({ ok: true, measured: sizes });
}

export const PATCH = withActivity("grading-app/accuracy-checks/[id]", PATCH_handler);
