import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { isR2StorageConfigured, uploadBytesToStorage } from "@/lib/storageProvider";

/**
 * Accuracy checks from CarbonGradingAI: a rigid object of known width and
 * height measured corner to corner on the phone. Diagnostic only — nothing
 * here changes how scans are scaled.
 *
 *   GET   the latest checks (newest first, up to 100)
 *   POST  {trueW, trueH, measuredW, measuredH, measuredDiag, depth?, appVersion?, deviceModel?, note?,
 *          corners?, pxPerCm?, photoW?, photoH?} — as JSON, or multipart (meta + photo) so the
 *          corners can be checked and moved on the desktop (PATCH /accuracy-checks/[id]).
 */
export const runtime = "nodejs";
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
  corners: z.array(z.tuple([z.number().finite(), z.number().finite()])).length(4).nullish(),
  pxPerCm: z.number().finite().positive().nullish(),
  photoW: z.number().int().positive().nullish(),
  photoH: z.number().int().positive().nullish(),
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
            c.corners, c.px_per_cm::float8 AS px_per_cm, c.photo_w, c.photo_h, (c.photo_key IS NOT NULL) AS has_photo,
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
  let raw: unknown = {};
  let photo: Buffer | null = null;
  if ((req.headers.get("content-type") ?? "").startsWith("multipart/")) {
    const form = await req.formData().catch(() => null);
    const meta = form?.get("meta");
    try { raw = typeof meta === "string" ? JSON.parse(meta) : {}; } catch { raw = {}; }
    const p = form?.get("photo");
    if (p instanceof Blob && p.size && p.size < 12_000_000) photo = Buffer.from(await p.arrayBuffer());
  } else {
    raw = await req.json().catch(() => ({}));
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  const b = parsed.data;
  const id = crypto.randomUUID();
  let photoKey: string | null = null;
  if (photo && isR2StorageConfigured()) {
    const d = new Date();
    photoKey = `grading-checks/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${id}.jpg`;
    await uploadBytesToStorage({ path: photoKey, bytes: new Uint8Array(photo), contentType: "image/jpeg" });
  }
  const { rows } = await pool.query(
    `INSERT INTO grading_accuracy_checks
       (id, true_w_cm, true_h_cm, measured_w_cm, measured_h_cm, measured_diag_cm, depth, app_version, device_model, note, created_by,
        photo_key, corners, px_per_cm, photo_w, photo_h)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16)
     RETURNING id`,
    [
      id, b.trueW, b.trueH, b.measuredW, b.measuredH, b.measuredDiag,
      b.depth ? JSON.stringify(b.depth) : null, b.appVersion ?? null, b.deviceModel ?? null, b.note ?? null,
      session.sub ?? null, photoKey, b.corners ? JSON.stringify(b.corners) : null, b.pxPerCm ?? null, b.photoW ?? null, b.photoH ?? null,
    ],
  );
  return NextResponse.json({ ok: true, id: rows[0]?.id });
}

export const POST = withActivity("grading-app/accuracy-checks", POST_handler);
