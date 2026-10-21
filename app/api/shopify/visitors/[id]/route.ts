import { withActivity } from "@/lib/server/activity-log";
/**
 * /api/shopify/visitors/[id] — one visitor on Shopify → Visitors.
 *  GET   → who they are, every page / cart add / checkout / signup / order.
 *  PATCH → the owner's nickname and private note ({ nickname, note }).
 * Admin only.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { welcomeAdminGuard } from "@/lib/server/welcome/guard";
import { getVisitor } from "@/lib/server/visitors/report";
import { cleanLabel } from "@/lib/server/visitors/rules";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const g = await welcomeAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await ctx.params;
  const v = await getVisitor(g.pool, decodeURIComponent(id).slice(0, 64));
  if (!v) return NextResponse.json({ error: "Visitor not found" }, { status: 404 });
  return NextResponse.json(v, { headers: { "Cache-Control": "no-store" } });
}

const schema = z.object({ nickname: z.string().max(200).nullable(), note: z.string().max(4000).nullable() }).partial().strict();

async function PATCH_handler(req: Request, ctx: Ctx) {
  const g = await welcomeAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid nickname or note" }, { status: 400 });
  const sets: string[] = [];
  const vals: unknown[] = [decodeURIComponent(id).slice(0, 64)];
  if ("nickname" in parsed.data) {
    vals.push(cleanLabel(parsed.data.nickname, 60));
    sets.push(`nickname = $${vals.length}`);
  }
  if ("note" in parsed.data) {
    const note = typeof parsed.data.note === "string" ? parsed.data.note.trim().slice(0, 1000) : "";
    vals.push(note || null);
    sets.push(`note = $${vals.length}`);
  }
  if (!sets.length) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  vals.push(g.session.email ?? null);
  const r = await g.pool.query(
    `UPDATE visitors SET ${sets.join(", ")}, labelled_at = now(), labelled_by_email = $${vals.length} WHERE visitor_id = $1`,
    vals,
  );
  if (!r.rowCount) return NextResponse.json({ error: "Visitor not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const PATCH = withActivity("shopify/visitors/[id]", PATCH_handler);
