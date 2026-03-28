export default function Home() {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-[var(--background)]">
      <header className="border-b border-[var(--surface-border)] bg-[var(--surface)]/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-[var(--accent)]">
              WMS
            </span>
            <h1 className="text-lg font-semibold tracking-tight text-[var(--foreground)]">
              Carbon Warehouse
            </h1>
          </div>
          <span className="font-mono text-xs text-[var(--muted)]">
            carbon-warehouse-management
          </span>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
        <div>
          <p className="font-mono text-sm text-[var(--accent)]">Environment</p>
          <p className="mt-1 max-w-xl text-[var(--muted)]">
            Warehouse management UI and APIs live in this service only.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { label: "Inventory", hint: "SKUs, locations, quantities" },
            { label: "Inbound / outbound", hint: "Shipments & transfers" },
            { label: "Reporting", hint: "Lots, carbon, compliance" },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] p-5 transition-colors hover:border-[var(--accent-dim)]"
            >
              <h2 className="font-semibold text-[var(--foreground)]">
                {card.label}
              </h2>
              <p className="mt-2 font-mono text-xs text-[var(--muted)]">
                {card.hint}
              </p>
            </div>
          ))}
        </div>

        <p className="font-mono text-xs text-[var(--muted)]">
          Local dev:{" "}
          <code className="rounded bg-[var(--surface)] px-1.5 py-0.5 text-[var(--accent)]">
            npm run dev
          </code>{" "}
          →{" "}
          <code className="rounded bg-[var(--surface)] px-1.5 py-0.5 text-[var(--accent)]">
            http://localhost:3040
          </code>
        </p>
      </main>
    </div>
  );
}
