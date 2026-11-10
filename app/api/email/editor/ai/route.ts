import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/email/editor/ai — AI inside the email editor (text only, never pictures):
 *   { action: "build", brief }                          → { id }  a new email written from the brief
 *   { action: "rewrite", html, how, instruction?, context? } → { options: html[] }
 *   { action: "subjects", doc, hint? }                  → { ideas: { subject, preheader }[] }
 *   { action: "check", doc, subject, preheader }        → { issues }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { createEditorEmail } from "@/lib/server/email/editor";
import { getKit } from "@/lib/server/email/library";
import { buildFromBrief, checkEmail, rewriteText, subjectLines } from "@/lib/server/email/editor-ai";
import { isDoc } from "@/lib/email-editor/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("build"), brief: z.string().trim().min(6).max(2000) }),
  z.object({
    action: z.literal("rewrite"),
    html: z.string().min(1).max(20000),
    how: z.enum(["shorter", "longer", "bolder", "warmer", "fix", "custom"]),
    instruction: z.string().max(500).optional(),
    context: z.string().max(6000).optional(),
  }),
  z.object({ action: z.literal("subjects"), doc: z.unknown(), hint: z.string().max(500).optional() }),
  z.object({ action: z.literal("check"), doc: z.unknown(), subject: z.string().max(300), preheader: z.string().max(300) }),
]);

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const p = schema.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const a = p.data;
  try {
    if (a.action === "build") {
      const built = await buildFromBrief(a.brief, await getKit(g.pool, g.session.tid));
      const id = await createEditorEmail(g.pool, g.session.tid, g.session.email ?? null, { title: built.title, built });
      return NextResponse.json({ id });
    }
    if (a.action === "rewrite") return NextResponse.json({ options: await rewriteText({ html: a.html, action: a.how, instruction: a.instruction, context: a.context }) });
    if (!isDoc(a.doc)) return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    if (a.action === "subjects") return NextResponse.json({ ideas: await subjectLines(a.doc, a.hint) });
    return NextResponse.json({ issues: await checkEmail(a.doc, a.subject, a.preheader) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = (e as { status?: number }).status;
    return NextResponse.json({ error: status ? `The AI service answered ${status}. Try again in a minute.` : msg }, { status: status ? 502 : 400 });
  }
}

export const POST = withActivity("email/editor/ai", POST_handler);
