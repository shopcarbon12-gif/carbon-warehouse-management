import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/email/designs/<id>/messages — the owner's chat message to the AI
 * Designer (multipart): text, target = both | desktop | mobile, mode = batch |
 * fast, directions = 1 for three different versions to pick from, and up to
 * 6 photos (file). The AI answers in the background.
 */
import { NextResponse } from "next/server";
import sharp from "sharp";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { addOwnerMessage, type Target } from "@/lib/server/email/designer";
import { uploadBytesToStorage } from "@/lib/storageProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_FILES = 6;
const MAX_BYTES = 25 * 1024 * 1024;

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const d = await g.pool.query(`SELECT status FROM email_designs WHERE id = $1::uuid AND tenant_id = $2::uuid AND archived_at IS NULL`, [id, g.session.tid]);
  if (!d.rows[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Send the message as a form" }, { status: 400 });
  }
  const text = String(form.get("text") ?? "").trim().slice(0, 6000);
  const targetRaw = String(form.get("target") ?? "both");
  const target: Target = targetRaw === "desktop" || targetRaw === "mobile" ? targetRaw : "both";
  const mode = String(form.get("mode") ?? "batch") === "fast" ? "fast" : "batch";
  const directions = String(form.get("directions") ?? "") === "1";
  const files = form.getAll("file").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f).slice(0, MAX_FILES);
  if (!text && !files.length) return NextResponse.json({ error: "Write (or say) what the email should be" }, { status: 400 });
  const attachments: { path: string; name: string }[] = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) return NextResponse.json({ error: `${f.name} is larger than 25 MB` }, { status: 400 });
    const buf = Buffer.from(await f.arrayBuffer());
    const jpg = await sharp(buf).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer().catch(() => null);
    if (!jpg) return NextResponse.json({ error: `${f.name} is not a picture` }, { status: 400 });
    const path = `email/designs/${id}/att/${Date.now()}-${attachments.length}.jpg`;
    await uploadBytesToStorage({ path, bytes: jpg, contentType: "image/jpeg" });
    attachments.push({ path, name: f.name.slice(0, 80) });
  }
  try {
    const r = await addOwnerMessage(g.pool, { designId: id, text: text || "Use these photos.", attachments, target, mode, by: g.session.email ?? null, directions });
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}

export const POST = withActivity("email/designs/[id]/messages", POST_handler);
