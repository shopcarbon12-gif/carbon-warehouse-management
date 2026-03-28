import { ExceptionsClient } from "./exceptions-client";

export const dynamic = "force-dynamic";

export default function AlertsPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">
        Alerts &amp; exceptions
      </h1>
      <p className="mt-1 font-mono text-sm text-[var(--muted)]">
        Resolve or ignore items; each change writes an audit row.
      </p>
      <ExceptionsClient />
    </div>
  );
}
