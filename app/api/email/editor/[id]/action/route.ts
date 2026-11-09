import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/email/editor/<id>/action
 *   { action: "test", to }   — send a test (sample name and code) through Amazon SES
 *   { action: "translate" }  — make the Spanish and Portuguese copies (runs in the background)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { sendDesignTest } from "@/lib/server/email/campaigns";
import { translateDesign } from "@/lib/server/email/translate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({ action: z.enum(["test", "translate"]), to: z.string().trim().max(1000).optional() }).strict();

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  const p = schema.safeParse(await req.json().catch(() => ({})));
  if (!p.success || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const own = await g.pool.query(`SELECT 1 FROM email_designs WHERE id = $1::uuid AND tenant_id = $2::uuid AND editor_doc IS NOT NULL`, [id, g.session.tid]);
  if (!own.rowCount) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    if (p.data.action === "test") {
      const list = (p.data.to || g.session.email || "")
        .split(/[,\s;]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      if (!list.length) return NextResponse.json({ error: "Type an address for the test" }, { status: 400 });
      if (list.length > 5 || list.some((x) => !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(x))) return NextResponse.json({ error: "Up to 5 valid addresses, separated by commas" }, { status: 400 });
      for (const to of list) await sendDesignTest(g.pool, g.session.tid, { designId: id, to });
      return NextResponse.json({ ok: true, to: list });
    }
    await g.pool.query(`UPDATE email_designs SET translate_status = 'running' WHERE id = $1::uuid`, [id]);
    void translateDesign(g.pool, id).catch(() => g.pool.query(`UPDATE email_designs SET translate_status = 'failed' WHERE id = $1::uuid`, [id]));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}

export const POST = withActivity("email/editor/[id]/action", POST_handler);
