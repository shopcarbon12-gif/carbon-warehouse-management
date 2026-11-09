import { withActivity } from "@/lib/server/activity-log";
/**
 * GET  /api/email/designs — AI Designer: every design (newest first) with its latest pictures.
 * POST /api/email/designs — a new, empty design (the first chat message draws it).
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const r = await g.pool.query(
    `SELECT d.id, d.title, d.status, d.updated_at, d.created_by, d.html IS NOT NULL AS has_html,
            (SELECT m.id FROM email_design_messages m WHERE m.design_id = d.id AND m.role = 'ai' AND m.status = 'done' ORDER BY m.created_at DESC LIMIT 1) AS latest,
            (SELECT count(*) FROM email_design_messages m WHERE m.design_id = d.id AND m.role = 'ai' AND m.status = 'done')::int AS versions,
            EXISTS (SELECT 1 FROM email_design_messages m WHERE m.design_id = d.id AND m.status IN ('queued','planning','generating','approved','approved-planning')) AS working,
            EXISTS (SELECT 1 FROM email_design_messages m WHERE m.design_id = d.id AND m.status = 'review') AS waiting
       FROM email_designs d WHERE d.tenant_id = $1::uuid AND d.archived_at IS NULL AND d.editor_doc IS NULL ORDER BY d.updated_at DESC LIMIT 100`,
    [g.session.tid],
  );
  return NextResponse.json({ designs: r.rows });
}

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const b = (await req.json().catch(() => ({}))) as { title?: unknown };
  const title = typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 80) : "New email";
  const r = await g.pool.query<{ id: string }>(`INSERT INTO email_designs (tenant_id, title, created_by) VALUES ($1::uuid, $2, $3) RETURNING id`, [g.session.tid, title, g.session.email ?? null]);
  return NextResponse.json({ id: r.rows[0].id });
}

export const POST = withActivity("email/designs", POST_handler);
