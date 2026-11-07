/**
 * GET /api/email/designs/<id>/file?path=email/designs/<id>/… — a design's
 * pictures, attachments and package zip, for the signed-in admin.
 */
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { downloadStorageObject } from "@/lib/storageProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  const path = new URL(req.url).searchParams.get("path") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || !path.startsWith(`email/designs/${id}/`) || path.includes("..")) return new Response("Not found", { status: 404 });
  const d = await g.pool.query(`SELECT 1 FROM email_designs WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, g.session.tid]);
  if (!d.rowCount) return new Response("Not found", { status: 404 });
  try {
    const obj = await downloadStorageObject(path);
    const zip = path.endsWith(".zip");
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.contentType || (zip ? "application/zip" : "image/png"),
        "Cache-Control": "private, max-age=86400",
        ...(zip ? { "Content-Disposition": `attachment; filename="email-package.zip"` } : {}),
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
