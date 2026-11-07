import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/email/designs/<id>/package — upload an email package zip by hand
 * (email.html + images/ + optional manifest.json), handled exactly like the
 * one "Convert to email" gets from OpenAI.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { ingestPackage } from "@/lib/server/email/convert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  const d = await g.pool.query(`SELECT status FROM email_designs WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, g.session.tid]).catch(() => null);
  if (!d?.rows[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (d.rows[0].status === "converting") return NextResponse.json({ error: "This design is being converted right now" }, { status: 409 });
  const form = await req.formData().catch(() => null);
  const f = form?.get("file");
  if (!f || typeof f !== "object" || !("arrayBuffer" in f)) return NextResponse.json({ error: "Choose a .zip file" }, { status: 400 });
  if ((f as File).size > 30 * 1024 * 1024) return NextResponse.json({ error: "The zip is larger than 30 MB" }, { status: 400 });
  try {
    const r = await ingestPackage(g.pool, id, Buffer.from(await (f as File).arrayBuffer()));
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const POST = withActivity("email/designs/[id]/package", POST_handler);
