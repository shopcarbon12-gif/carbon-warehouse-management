import Link from "next/link";

export default function HandheldDocsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">Handheld API</h1>
      <p className="mt-1 font-mono text-sm text-[var(--muted)]">
        Idempotent batch upload for Android clients. Set{" "}
        <code className="text-[var(--accent)]">WMS_DEVICE_KEY</code> in Coolify.
      </p>
      <p className="mt-4 font-mono text-sm text-[var(--foreground)]">
        Full contract:{" "}
        <Link href="/docs/handheld-api" className="text-[var(--accent)] hover:underline">
          docs/handheld-api
        </Link>
      </p>
      <pre className="mt-6 overflow-x-auto rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] p-4 font-mono text-xs text-[var(--muted)]">
        {`curl -X POST "$ORIGIN/api/handheld/batches" \\
  -H "Content-Type: application/json" \\
  -H "X-WMS-Device-Key: $WMS_DEVICE_KEY" \\
  -d '{"batch_id":"b-2001","location_id":"<uuid>","epcs":["E280...","E280..."]}'`}
      </pre>
    </div>
  );
}
