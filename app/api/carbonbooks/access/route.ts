import { carbonBooksAdminCall } from "@/lib/carbonbooks";
import { getSession } from "@/lib/get-session";

/** GET /api/carbonbooks/access?user=<id> — one person's CarbonBooks access (CarbonBooks Admins only). */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = new URL(req.url).searchParams.get("user") ?? "";
  return carbonBooksAdminCall(`/api/wms/access?user=${encodeURIComponent(user)}`, session.sub);
}

/** PUT /api/carbonbooks/access — apply a change; needs the acting Admin's SMS code. */
export async function PUT(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return carbonBooksAdminCall("/api/wms/access", session.sub, { method: "PUT", body: await req.json().catch(() => ({})) });
}
