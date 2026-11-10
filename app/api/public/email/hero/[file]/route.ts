/**
 * GET /api/public/email/hero/<key>.jpg?n=<first name> — a personal hero picture (the member card with
 * the person's own name), drawn the first time that name is asked for, then served from storage.
 * Public: inboxes load it. Unknown heroes answer 404.
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { personalHero } from "@/lib/server/email/text-pics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const key = /^([0-9a-f]{16})\.jpg$/.exec(file)?.[1];
  if (!key) return new NextResponse("not found", { status: 404 });
  const pool = getPool();
  if (!pool) return new NextResponse("unavailable", { status: 503 });
  const url = await personalHero(pool, key, new URL(req.url).searchParams.get("n")).catch(() => null);
  if (!url) return new NextResponse("not found", { status: 404 });
  // The stored picture never changes for this hero and name: inboxes may keep it.
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "public, max-age=86400" } });
}
