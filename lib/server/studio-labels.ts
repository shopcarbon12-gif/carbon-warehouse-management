import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { tryGetStoragePathFromUrl } from "@/lib/storageProvider";

/** Session + pool for the jeans-label routes (Studio admins only). */
export async function studioLabelsAuth(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const pool = getPool();
  if (!pool) return { error: NextResponse.json({ error: "Database unavailable" }, { status: 503 }) };
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return { error: denied };
  return { session, pool };
}

/** Only a photo uploaded through the Studio itself: its upload, or the phone
 *  camera hand-off (those objects are kept; see /api/image-handoff). */
export function isStudioUpload(url: string, tid: string): boolean {
  const path = url ? tryGetStoragePathFromUrl(url) : "";
  return Boolean(path && (path.startsWith(`carbon-studio/item-refs/${tid}/`) || path.startsWith("carbon-studio/handoff/")));
}
