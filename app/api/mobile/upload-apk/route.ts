import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { deactivateAllReleases, insertAppRelease } from "@/lib/queries/app-releases";

export const dynamic = "force-dynamic";

function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form" }, { status: 400 });
  }

  const versionLabel = String(form.get("versionLabel") ?? form.get("version") ?? "").trim();
  const file = form.get("apk");
  if (!versionLabel) {
    return NextResponse.json({ error: "versionLabel required" }, { status: 400 });
  }
  if (!(file instanceof File) || file.size < 1) {
    return NextResponse.json({ error: "apk file required" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const root = process.cwd();
  const relDir = path.join("public", "uploads", "mobile-apk", session.tid);
  const absDir = path.join(root, relDir);
  await mkdir(absDir, { recursive: true });
  const fname = `${safeSegment(versionLabel)}.apk`;
  const absFile = path.join(absDir, fname);
  await writeFile(absFile, buf);

  const apkUrl = `/uploads/mobile-apk/${session.tid}/${fname}`;

  try {
    const id = await insertAppRelease(pool, session.tid, {
      version_label: versionLabel,
      apk_url: apkUrl,
      makeActive: true,
    });
    return NextResponse.json({ ok: true, id, apkUrl, versionLabel });
  } catch (e) {
    console.error("[mobile/upload-apk]", e);
    return NextResponse.json({ error: "Failed to save release row" }, { status: 500 });
  }
}
