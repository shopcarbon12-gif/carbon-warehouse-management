import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { UUID_RE } from "@/lib/server/grading-app";
import { downloadStorageObject } from "@/lib/storageProvider";

type Ctx = { params: Promise<{ id: string }> };

/** GET → the scan's squared-up photo (the picture its lines are drawn on). */
export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const r = await pool.query<{ photo_key: string | null }>(`SELECT photo_key FROM size_grading_scans WHERE id = $1::uuid`, [id]);
  const key = r.rows[0]?.photo_key;
  if (!key) return NextResponse.json({ error: "No photo" }, { status: 404 });
  try {
    const obj = await downloadStorageObject(key);
    return new Response(obj.body, { headers: { "Content-Type": obj.contentType || "image/jpeg", "Cache-Control": "private, max-age=86400" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Photo unavailable" }, { status: 502 });
  }
}
