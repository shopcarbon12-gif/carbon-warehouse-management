import { withActivity } from "@/lib/server/activity-log";
/**
 * GET  /api/email/editor — the emails made in the drag-and-drop editor.
 * POST /api/email/editor — a new one: { title?, starter? } or a copy { fromId }.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { createEditorEmail } from "@/lib/server/email/editor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const r = await g.pool.query(
    `SELECT id::text, title, subject_hint AS subject, updated_at, created_by, translate_status, html_es IS NOT NULL AS has_es, html_pt IS NOT NULL AS has_pt,
            (SELECT count(*) FROM email_campaigns c WHERE c.design_id = d.id)::int AS campaigns
       FROM email_designs d WHERE tenant_id = $1::uuid AND editor_doc IS NOT NULL AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 200`,
    [g.session.tid],
  );
  return NextResponse.json({ emails: r.rows });
}

const schema = z.object({ title: z.string().trim().max(80).optional(), starter: z.string().max(40).optional(), fromId: z.string().uuid().optional() }).strict();

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const p = schema.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  try {
    const id = await createEditorEmail(g.pool, g.session.tid, g.session.email ?? null, p.data);
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const POST = withActivity("email/editor", POST_handler);
