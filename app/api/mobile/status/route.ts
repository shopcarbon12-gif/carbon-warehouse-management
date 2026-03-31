import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { getActiveRelease, getLatestAppRelease } from "@/lib/queries/app-releases";
import { findDeviceByAndroidId } from "@/lib/queries/enterprise-devices";
import { toAbsolutePublicUrl } from "@/lib/server/resolve-public-origin";

export const dynamic = "force-dynamic";

/** Compare semver-ish labels: strips leading `v`, ignores build +metadata for availability hint. */
function normalizeVersionLabel(v: string): string {
  return v
    .trim()
    .replace(/^v+/i, "")
    .split("+")[0]
    .trim();
}

/**
 * Pre-login device gate + OTA hints. Optional session cookie for Super Admin bypass (`bdl`).
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const androidId = searchParams.get("androidId")?.trim() ?? "";
  const currentVersion = searchParams.get("version")?.trim() ?? "";

  const session = await getSessionFromRequest(req);
  if (session?.bypassDeviceLock) {
    const pool = getPool();
    let latestVersion: string | null = null;
    let downloadUrl: string | null = null;
    if (pool) {
      const rel =
        (await getActiveRelease(pool, session.tid)) ?? (await getLatestAppRelease(pool, session.tid));
      if (rel) {
        latestVersion = rel.version_label;
        downloadUrl = toAbsolutePublicUrl(req, rel.apk_url);
      }
    }
    const lv = latestVersion ?? "";
    const cv = currentVersion ?? "";
    const updateAvailable =
      Boolean(lv) && Boolean(cv) && normalizeVersionLabel(lv) !== normalizeVersionLabel(cv);
    return NextResponse.json({
      authorized: true,
      bypassDeviceLock: true,
      latestVersion,
      downloadUrl,
      updateAvailable,
    });
  }

  if (!androidId) {
    return NextResponse.json(
      { error: "androidId query parameter required (unless Super Admin session)" },
      { status: 400 },
    );
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const dev = await findDeviceByAndroidId(pool, androidId);
  if (!dev) {
    return NextResponse.json({
      registered: false,
      authorized: false,
      latestVersion: null,
      downloadUrl: null,
      updateAvailable: false,
    });
  }

  if (!dev.is_authorized) {
    return NextResponse.json({
      registered: true,
      authorized: false,
      latestVersion: null,
      downloadUrl: null,
      updateAvailable: false,
    });
  }

  const rel =
    (await getActiveRelease(pool, dev.tenant_id)) ?? (await getLatestAppRelease(pool, dev.tenant_id));
  const latestVersion = rel?.version_label ?? null;
  const downloadUrl = rel ? toAbsolutePublicUrl(req, rel.apk_url) : null;
  const lv = latestVersion ?? "";
  const cv = currentVersion ?? "";
  const updateAvailable =
    Boolean(lv) && Boolean(cv) && normalizeVersionLabel(lv) !== normalizeVersionLabel(cv);

  return NextResponse.json({
    registered: true,
    authorized: true,
    latestVersion,
    downloadUrl,
    updateAvailable,
  });
}
