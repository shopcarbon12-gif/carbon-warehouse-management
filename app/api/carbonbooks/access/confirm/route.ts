import { carbonBooksAdminCall } from "@/lib/carbonbooks";
import { getSession } from "@/lib/get-session";

/** POST /api/carbonbooks/access/confirm — CarbonBooks texts the acting Admin a confirmation code. */
export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return carbonBooksAdminCall("/api/wms/access/confirm", session.sub, { method: "POST" });
}
