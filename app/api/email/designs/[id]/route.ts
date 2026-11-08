import { withActivity } from "@/lib/server/activity-log";
/**
 * GET   /api/email/designs/<id> — the design, its chat (with picture links) and its email HTML.
 * PATCH /api/email/designs/<id> — rename, hand-edit the converted HTML, or archive.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { listMessages } from "@/lib/server/email/designer";
import { sanitizeEmailHtml } from "@/lib/server/email/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f-]{36}$/i;

export async function GET(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const d = await g.pool.query(`SELECT * FROM email_designs WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, g.session.tid]);
  if (!d.rows[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const file = (p: string | null) => (p ? `/api/email/designs/${id}/file?path=${encodeURIComponent(p)}` : null);
  const messages = (await listMessages(g.pool, id)).map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    target: m.target,
    mode: m.mode,
    status: m.status,
    error: m.error,
    created_at: m.created_at,
    attachments: (m.attachments ?? []).map((a) => ({ name: a.name, url: file(a.path) })),
    desktop: file(m.desktop_path),
    mobile: file(m.mobile_path),
    products: m.products ?? [],
    media: (m.media ?? []).map((x: { id: string; url: string; description: string }) => ({ id: x.id, url: x.url, description: x.description })),
    step: m.concept ?? null,
    hasMobileTop: !!m.mobile_top_path,
    needsReview: m.needs_review ?? null,
    engine: m.engine,
    hasEmail: !!m.html,
    direction: m.direction ?? null,
    variantGroup: m.variant_group ?? null,
    variantNo: m.variant_no ?? null,
    picked: m.picked ?? null,
    banners: (m.banners ?? []).map((b: { id: string; url?: string | null; qa?: string | null; error?: string | null; text?: string | null }) => ({ id: b.id, url: b.url ?? null, qa: b.qa ?? null, error: b.error ?? null, text: b.text ?? null })),
  }));
  const row = d.rows[0];
  return NextResponse.json({
    design: { ...row, package_url: file(row.package_path) },
    messages,
  });
}

const schema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    html: z.string().max(400_000).optional(),
    archived: z.boolean().optional(),
  })
  .strict();

async function PATCH_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  const p = schema.safeParse(await req.json().catch(() => ({})));
  if (!p.success || !UUID_RE.test(id)) return NextResponse.json({ error: p.success ? "Not found" : p.error.issues[0]?.message }, { status: 400 });
  const b = p.data;
  const r = await g.pool.query(
    `UPDATE email_designs SET title = COALESCE($3, title), html = COALESCE($4, html),
            archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN now() ELSE NULL END, updated_at = now()
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND status <> 'converting'`,
    [id, g.session.tid, b.title ?? null, b.html !== undefined ? sanitizeEmailHtml(b.html) : null, b.archived ?? null],
  );
  if (!r.rowCount) return NextResponse.json({ error: "Not found, or it is being converted right now" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const PATCH = withActivity("email/designs/[id]", PATCH_handler);
