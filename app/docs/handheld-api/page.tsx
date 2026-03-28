export default function HandheldApiDocPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10 font-mono text-sm text-[var(--foreground)]">
      <h1 className="text-lg font-semibold">Handheld batch API</h1>
      <p className="mt-2 text-[var(--muted)]">
        Authenticate with header <code className="text-[var(--accent)]">X-WMS-Device-Key</code>{" "}
        matching environment variable <code className="text-[var(--accent)]">WMS_DEVICE_KEY</code>{" "}
        (set in Coolify).
      </p>
      <h2 className="mt-8 font-semibold">POST /api/handheld/batches</h2>
      <p className="mt-2 text-[var(--muted)]">JSON body:</p>
      <ul className="mt-2 list-inside list-disc text-[var(--muted)]">
        <li>
          <code>batch_id</code> — string, unique per batch (idempotent retries)
        </li>
        <li>
          <code>location_id</code> — UUID of a <code>locations</code> row
        </li>
        <li>
          <code>epcs</code> — string array, 1–5000 EPCs
        </li>
      </ul>
      <p className="mt-4 text-[var(--muted)]">
        Response: <code>{"{ ok, duplicate?, accepted, batch_id }"}</code>. Inserts{" "}
        <code>handheld_batches</code> and enqueues <code>handheld_process</code> sync job with
        idempotency key <code>handheld:{"{batch_id}"}</code>.
      </p>
    </div>
  );
}
