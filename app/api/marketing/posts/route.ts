/**
 * GET /api/marketing/posts?from=ISO&to=ISO — the calendar: posts with their
 * pictures, product tags and per-channel results. Admin only.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { listPosts } from "@/lib/server/marketing/store";

export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  if ((from && !ISO.test(from)) || (to && !ISO.test(to))) return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  return NextResponse.json({ posts: await listPosts(g.pool, g.session.tid, { from, to }) });
}
