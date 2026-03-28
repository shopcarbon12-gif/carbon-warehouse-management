import { withDb } from "@/lib/db";
import { listInventory } from "@/lib/queries/inventory";
import { listOrders } from "@/lib/queries/orders";
import { listRecentSyncRuns } from "@/lib/queries/sync";
import { emptyReportSummary, getReportSummary } from "@/lib/queries/reports";
import { WAREHOUSE, WAREHOUSE_ZONES } from "@/lib/zones";
import { IntegrationStatus } from "@/components/IntegrationStatus";
import { SyncTrigger } from "@/components/SyncTrigger";

export default async function Home() {
  const [inventory, orders, syncRuns, summary] = await Promise.all([
    withDb((p) => listInventory(p), []),
    withDb((p) => listOrders(p), []),
    withDb((p) => listRecentSyncRuns(p, 6), []),
    withDb((p) => getReportSummary(p), emptyReportSummary()),
  ]);

  const totalUnits = summary.unitsPerZone.reduce((a, z) => a + z.units, 0);

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-[var(--surface-border)] bg-[var(--surface)]/80 px-6 py-8 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl">
          <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-[var(--accent)]">
            Warehouse {WAREHOUSE.id}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--foreground)]">
            {WAREHOUSE.name}
          </h1>
          <p className="mt-2 max-w-2xl font-mono text-sm text-[var(--muted)]">{WAREHOUSE.city}</p>
          <p className="mt-4 max-w-2xl text-sm text-[var(--muted)]">
            Syncs Shopify ecommerce, Lightspeed POS, and Senitron RFID (
            <span className="font-mono text-[var(--accent)]">app.senitron.net</span>
            ). Zones cover bulk storage and pick faces across six aisles.
          </p>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-10 px-6 py-10">
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "SKUs tracked", value: String(new Set(inventory.map((i) => i.sku)).size) },
            { label: "Inventory rows", value: String(inventory.length) },
            { label: "Open orders (loaded)", value: String(orders.length) },
            { label: "Units (all zones)", value: String(totalUnits) },
          ].map((c) => (
            <div
              key={c.label}
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] p-4"
            >
              <p className="font-mono text-xs text-[var(--muted)]">{c.label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-[var(--foreground)]">
                {c.value}
              </p>
            </div>
          ))}
        </section>

        <section>
          <h2 className="mb-3 font-semibold text-[var(--foreground)]">Zones</h2>
          <div className="flex flex-wrap gap-2">
            {WAREHOUSE_ZONES.map((z) => (
              <span
                key={z}
                className="rounded-md border border-[var(--surface-border)] bg-[var(--background)] px-2.5 py-1 font-mono text-xs text-[var(--accent)]"
              >
                {z}
              </span>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 font-semibold text-[var(--foreground)]">Integrations</h2>
          <IntegrationStatus />
        </section>

        <section>
          <h2 className="mb-3 font-semibold text-[var(--foreground)]">Sync</h2>
          <p className="mb-3 max-w-xl text-sm text-[var(--muted)]">
            Run a connectivity check and log results to PostgreSQL. Configure credentials in{" "}
            <code className="rounded bg-[var(--surface)] px-1 font-mono text-[var(--accent)]">
              .env
            </code>{" "}
            (see <span className="font-mono">.env.example</span>).
          </p>
          <SyncTrigger />
        </section>

        <section>
          <h2 className="mb-3 font-semibold text-[var(--foreground)]">Recent sync runs</h2>
          {syncRuns.length === 0 ? (
            <p className="font-mono text-sm text-[var(--muted)]">
              No runs yet — start Postgres or set DATABASE_URL, then use Sync above.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--surface-border)] rounded-lg border border-[var(--surface-border)] bg-[var(--surface)]">
              {syncRuns.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3 font-mono text-xs">
                  <span className="text-[var(--accent)]">{r.provider}</span>
                  <span className="text-[var(--foreground)]">{r.status}</span>
                  <span className="text-[var(--muted)]">{r.message}</span>
                  <span className="ml-auto text-[var(--muted)]">{r.started_at}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
