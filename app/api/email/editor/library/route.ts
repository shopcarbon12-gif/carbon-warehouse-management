import { withActivity } from "@/lib/server/activity-log";
/**
 * Email editor library (phase 2): the store's saved templates and saved sections.
 *   GET    /api/email/editor/library            → { templates, sections }
 *   POST   /api/email/editor/library            { kind: "template" | "section", name, data } → { id }
 *   PATCH  /api/email/editor/library?id=<uuid>  { name }  (rename)
 *   DELETE /api/email/editor/library?id=<uuid>
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { deleteItem, listSaved, renameItem, saveItem } from "@/lib/server/email/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID_RE = /^[0-9a-f-]{36}$/i;

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const all = await listSaved(g.pool, g.session.tid);
  return NextResponse.json({ templates: all.filter((x) => x.kind === "template"), sections: all.filter((x) => x.kind === "section") });
}

const postSchema = z.object({ kind: z.enum(["template", "section"]), name: z.string().trim().min(1).max(80), data: z.unknown() }).strict();

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const p = postSchema.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "Give it a name" }, { status: 400 });
  try {
    const id = await saveItem(g.pool, g.session.tid, g.session.email ?? null, p.data);
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

async function PATCH_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const b = (await req.json().catch(() => ({}))) as { name?: unknown };
  if (!UUID_RE.test(id) || typeof b.name !== "string") return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const ok = await renameItem(g.pool, g.session.tid, id, b.name);
    return ok ? NextResponse.json({ ok }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

async function DELETE_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const ok = await deleteItem(g.pool, g.session.tid, id);
  return ok ? NextResponse.json({ ok }) : NextResponse.json({ error: "Not found" }, { status: 404 });
}

export const POST = withActivity("email/editor/library", POST_handler);
export const PATCH = withActivity("email/editor/library", PATCH_handler);
export const DELETE = withActivity("email/editor/library", DELETE_handler);
