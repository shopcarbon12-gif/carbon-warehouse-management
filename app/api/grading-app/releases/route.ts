import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { latestRelease } from "@/lib/server/grading-app";
import { toAbsolutePublicUrl } from "@/lib/server/resolve-public-origin";

/**
 * CarbonGradingAI APK releases. The phone checks GET on start and offers the
 * update; an admin POSTs a new build (multipart: version, apk, notes?). Files
 * live next to the handheld's APKs on the uploads volume.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const rel = await latestRelease(pool);
  return NextResponse.json({ release: rel ? { ...rel, downloadUrl: toAbsolutePublicUrl(req, rel.apkUrl) } : null });
}

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });
  }
  const version = String(form.get("version") ?? "").trim();
  const notes = String(form.get("notes") ?? "").trim() || null;
  const file = form.get("apk");
  if (!/^\d+\.\d+\.\d+$/.test(version)) return NextResponse.json({ error: "version must be X.Y.Z" }, { status: 400 });
  if (!(file instanceof File) || file.size < 1) return NextResponse.json({ error: "apk file required" }, { status: 400 });
  const buf = Buffer.from(await file.arrayBuffer());
  const fname = `carbongradingai-v${version}.apk`;
  const absDir = path.join(process.cwd(), "public", "uploads", "grading-apk");
  try {
    await mkdir(absDir, { recursive: true });
    await writeFile(path.join(absDir, fname), buf);
  } catch (e) {
    return NextResponse.json({ error: `Cannot write the APK: ${e instanceof Error ? e.message : e}` }, { status: 500 });
  }
  const sha1 = createHash("sha1").update(buf).digest("hex");
  const apkUrl = `/uploads/grading-apk/${fname}`;
  await pool.query(
    `INSERT INTO grading_app_releases (version, apk_url, sha1, notes, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [version, apkUrl, sha1, notes, session.sub ?? null],
  );
  return NextResponse.json({ ok: true, version, sha1, downloadUrl: toAbsolutePublicUrl(req, apkUrl) });
}

export const POST = withActivity("grading-app/releases", POST_handler);
