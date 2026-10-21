import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

/**
 * Accuracy checks from CarbonGradingAI: a rigid object of known width and
 * height measured corner to corner on the phone. Diagnostic only — nothing
 * here changes how scans are scaled.
 *
 *   GET   the latest checks (newest first, up to 100)
 *   POST  {trueW, trueH, measuredW, measuredH, measuredDiag, depth?, appVersion?, deviceModel?, note?}
 */
const cm = z.number().positive().max(500);
const Body = z.object({
  trueW: cm,
  trueH: cm,
  measuredW: cm,
  measuredH: cm,
  measuredDiag: cm,
  depth: z.record(z.string(), z.unknown()).nullish(),
  appVersion: z.string().trim().max(40).nullish(),
  deviceModel: z.string().trim().max(80).nullish(),
  note: z.string().trim().max(500).nullish(),
});

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { rows } = await pool.query(
    `SELECT c.id, c.true_w_cm::float8 AS true_w_cm, c.true_h_cm::float8 AS true_h_cm,
            c.measured_w_cm::float8 AS measured_w_cm, c.measured_h_cm::float8 AS measured_h_cm,
            c.measured_diag_cm::float8 AS measured_diag_cm, c.depth, c.app_version, c.device_model, c.note,
            c.created_at, u.email AS by_email
       FROM grading_accuracy_checks c
       LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.created_at DESC
      LIMIT 100`,
  );
  return NextResponse.json({ checks: rows });
}

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  const b = parsed.data;
  const { rows } = await pool.query(
    `INSERT INTO grading_accuracy_checks
       (true_w_cm, true_h_cm, measured_w_cm, measured_h_cm, measured_diag_cm, depth, app_version, device_model, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     RETURNING id`,
    [
      b.trueW, b.trueH, b.measuredW, b.measuredH, b.measuredDiag,
      b.depth ? JSON.stringify(b.depth) : null, b.appVersion ?? null, b.deviceModel ?? null, b.note ?? null,
      session.sub ?? null,
    ],
  );
  return NextResponse.json({ ok: true, id: rows[0]?.id });
}

export const POST = withActivity("grading-app/accuracy-checks", POST_handler);
