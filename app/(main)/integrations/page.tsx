import { getSession } from "@/lib/get-session";
import { withDb } from "@/lib/db";
import { listIntegrations } from "@/lib/queries/integrations";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const session = await getSession();
  if (!session) return null;
  const rows = await withDb(
    (sql) => listIntegrations(sql, session.tid, session.lid),
    [],
  );

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">Integrations</h1>
      <p className="mt-1 font-mono text-sm text-[var(--muted)]">
        Read-only: every <code className="text-[var(--accent)]">integration_connections</code> row for this
        tenant. Location is the linked warehouse code,
        or <code className="text-[var(--accent)]">tenant</code> when <code className="text-[var(--accent)]">location_id</code>{" "}
        is null.
      </p>
      <div className="mt-6 overflow-x-auto rounded-lg border border-[var(--surface-border)]">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--surface-border)] bg-[var(--surface)] font-mono text-xs uppercase text-[var(--muted)]">
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Location</th>
              <th className="px-4 py-3">Last OK</th>
              <th className="px-4 py-3">Last job</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center font-mono text-[var(--muted)]">
                  No integration rows — connect Lightspeed or seed data.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-[var(--surface-border)]/60 hover:bg-[var(--surface)]/40"
                >
                  <td className="px-4 py-2 font-mono text-xs capitalize">{r.provider}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.status}</td>
                  <td className="px-4 py-2 font-mono text-xs text-[var(--muted)]">
                    {r.location_code ?? "tenant"}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-[var(--muted)]">
                    {r.last_ok_at?.slice(0, 19) ?? "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-[var(--muted)]">
                    {r.last_job_at?.slice(0, 19) ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
