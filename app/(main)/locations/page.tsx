import { getSession } from "@/lib/get-session";
import { withDb } from "@/lib/db";
import { listLocationsForTenant } from "@/lib/queries/locations";

export const dynamic = "force-dynamic";

export default async function LocationsPage() {
  const session = await getSession();
  if (!session) return null;
  const locs = await withDb((sql) => listLocationsForTenant(sql, session.tid), []);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">Locations</h1>
      <p className="mt-1 font-mono text-sm text-[var(--muted)]">
        Switch active location from the sidebar. All KPIs and lists use the selected site.
      </p>
      <div className="mt-6 overflow-x-auto rounded-lg border border-[var(--surface-border)]">
        <table className="w-full min-w-[480px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--surface-border)] bg-[var(--surface)] font-mono text-xs uppercase text-[var(--muted)]">
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Active</th>
            </tr>
          </thead>
          <tbody>
            {locs.map((l) => (
              <tr
                key={l.id}
                className="border-b border-[var(--surface-border)]/60 hover:bg-[var(--surface)]/40"
              >
                <td className="px-4 py-2.5 font-mono text-[var(--accent)]">{l.code}</td>
                <td className="px-4 py-2.5">{l.name}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-[var(--muted)]">
                  {l.id === session.lid ? "yes" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
