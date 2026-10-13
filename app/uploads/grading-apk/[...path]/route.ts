import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

/**
 * CarbonGradingAI update downloads — same as app/uploads/mobile-apk: files written at runtime under `public/uploads/grading-apk/`
 * Next standalone + static `public` handling can 404 those bytes even when the path is correct;
 * this route always reads from disk (written by `POST /api/grading-app/releases`).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function gradingApkRoot(): string {
  return path.join(process.cwd(), "public", "uploads", "grading-apk");
}

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await ctx.params;
  if (!segments?.length) {
    return new NextResponse("Not found", { status: 404 });
  }
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("/") || s.includes("\\"))) {
    return new NextResponse("Bad path", { status: 400 });
  }

  const root = path.resolve(gradingApkRoot());
  const abs = path.resolve(root, ...segments);
  if (!abs.startsWith(root + path.sep)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  try {
    const st = await stat(abs);
    if (!st.isFile()) {
      return new NextResponse("Not found", { status: 404 });
    }
  } catch {
    console.warn("[uploads/grading-apk] missing on disk:", abs);
    return new NextResponse("Not found", { status: 404 });
  }

  const buf = await readFile(abs);
  const base = segments[segments.length - 1] ?? "release.apk";
  const isApk = base.toLowerCase().endsWith(".apk");

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": isApk ? "application/vnd.android.package-archive" : "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(base)}"`,
      "Cache-Control": "no-store",
    },
  });
}
