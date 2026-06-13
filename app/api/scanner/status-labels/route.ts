import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { isSuperAdminRole } from "@/lib/auth/roles";
import { listStatusLabels } from "@/lib/queries/status-labels";

/**
 * Operator-facing status labels for the handheld Status Change screen.
 *
 * Differs from `/api/settings/status-labels` (which is admin-only) by
 * scoping to scanner-visible rows and stamping each with whether the
 * requesting user is *allowed* to apply it. Mirrors the gates in the
 * `/api/inventory/bulk-status` POST handler so the picker only shows
 * statuses the user could actually commit.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  try {
    const all = await listStatusLabels(pool);
    const superAdmin = isSuperAdminRole(session.role);
    const rows = all
      // Change-status TARGET list = every operator-settable status, i.e. NOT
      // the system-workflow ones (in-transit / pending_transaction /
      // pending_visibility). Deliberately decoupled from is_visible_to_scanner:
      // that flag governs whether tags ALREADY IN a status are ghost-filtered
      // during inventory scans (stolen / tag-killed stay ignored there) — it
      // must NOT stop an operator from SETTING a tag to that status. Per-status
      // permission is still enforced below (applicable) and again on commit by
      // /api/inventory/bulk-status (super-admin locks, risky transitions).
      .filter((r) => !r.is_system_only)
      .map((r) => ({
        id: r.id,
        legacy_id: r.legacy_id,
        name: r.name,
        display_label: r.display_label || r.name,
        is_sellable: r.is_sellable,
        is_system_only: r.is_system_only,
        super_admin_locked: r.super_admin_locked,
        // True when the *requesting* user can pick this status as a target
        // in the Status Change flow. System-only and super-admin-locked
        // targets are only applicable by Super Admins.
        applicable: superAdmin || (!r.is_system_only && !r.super_admin_locked),
      }));
    return NextResponse.json(
      { rows, super_admin: superAdmin },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[scanner/status-labels GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
