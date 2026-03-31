import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { listAppReleases } from "@/lib/queries/app-releases";
import { MobileUpdatesWorkspace } from "@/components/settings/mobile-updates-workspace";

export const dynamic = "force-dynamic";

export default async function MobileUpdatesPage() {
  const session = await getSession();
  if (!session) return null;

  const pool = getPool();
  const releases = pool ? await listAppReleases(pool, session.tid) : [];

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-[var(--wms-border)] pb-3 dark:border-[var(--wms-border)]">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Mobile OTA releases</h1>
        <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
          Upload an APK; the active row drives <code className="text-[var(--wms-fg)]/80">GET /api/mobile/status</code> hints on
          handhelds. If handhelds show “no OTA URL” but you already uploaded, use <strong>Set active</strong> below or redeploy
          so the API can fall back to the latest upload.
        </p>
      </div>
      <MobileUpdatesWorkspace initialReleases={releases} />
    </div>
  );
}
