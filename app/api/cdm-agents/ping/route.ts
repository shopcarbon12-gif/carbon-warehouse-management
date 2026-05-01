import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Trivial diagnostic — returns 200 with no auth, body is a string we can
 * grep for to confirm THIS route is being matched at runtime (vs the
 * sibling [id] dynamic route catching it).
 */
export function GET() {
  return NextResponse.json({ ok: true, route: "lookup-static-test" });
}
