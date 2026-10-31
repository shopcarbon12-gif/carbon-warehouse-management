import { carbonBooksVisible } from "@/lib/carbonbooks";
import { getSession } from "@/lib/get-session";

/** GET /api/carbonbooks/visibility — should the sidebar show the CarbonBooks item to me? */
export async function GET() {
  const session = await getSession();
  const visible = session ? await carbonBooksVisible(session.sub) : false;
  return Response.json({ visible }, { headers: { "Cache-Control": "private, no-store" } });
}
