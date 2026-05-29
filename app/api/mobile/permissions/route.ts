import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { isSuperAdminRole } from "@/lib/auth/roles";
import { MOBILE_PERMISSION_PAGES } from "@/lib/settings/mobile-permission-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Effective WMS Mobile permissions for the signed-in handheld user.
 *
 * The Flutter app calls this right after login (same JWT it already sends on
 * every /api/* request) and uses `hiddenScreens` to hide/lock screens.
 *
 * Full-access rules (hiddenScreens = []):
 *   - tenant membership role is admin (the WMS Super Admin), OR
 *   - assigned mobile role's name is "Super Admin", OR
 *   - no mobile role assigned, OR
 *   - the role's permission map is empty.
 * Otherwise hiddenScreens lists every screen id explicitly set to "hide".
 *
 * Screen ids match lib/settings/mobile-permission-catalog.ts (and the Flutter
 * screen files minus `_screen.dart`). `login` and `device_lock` are never
 * listed — they must always be reachable.
 */

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session?.sub) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const r = await pool.query<{
    mobile_role_id: number | null;
    role_name: string | null;
    permissions: unknown;
    membership_role: string | null;
  }>(
    `SELECT u.mobile_role_id,
            mr.name        AS role_name,
            mr.permissions AS permissions,
            m.role         AS membership_role
       FROM users u
       LEFT JOIN user_roles mr ON mr.id = u.mobile_role_id AND mr.scope = 'mobile'
       LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2::uuid
      WHERE u.id = $1::uuid
      LIMIT 1`,
    [session.sub, session.tid],
  );
  const row = r.rows[0];

  const isSuperAdmin =
    isSuperAdminRole(row?.membership_role ?? "") ||
    (row?.role_name ?? "").trim().toLowerCase() === "super admin";

  const perm =
    row?.permissions && typeof row.permissions === "object"
      ? (row.permissions as Record<string, Record<string, "view" | "hide">>)
      : {};

  // A flat list of every screen id explicitly hidden. Empty for full-access.
  const hiddenScreens: string[] = [];
  if (!isSuperAdmin && row?.mobile_role_id != null) {
    for (const page of MOBILE_PERMISSION_PAGES) {
      for (const sec of page.sections) {
        if (perm[page.id]?.[sec.id] === "hide") hiddenScreens.push(sec.id);
      }
    }
  }

  return NextResponse.json(
    {
      role: row?.role_name ?? null,
      isSuperAdmin,
      hiddenScreens,
      permissions: perm,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
