"use client";

import { useState } from "react";

const sampleLines = [
  { sku: "C125311010701", name: "AVA MINI DRESS BLACK S", rfid_qty: 2, ext_qty: 2 },
  { sku: "—", name: "ISLA KNIT BLACK OS", rfid_qty: 24, ext_qty: 0 },
];

export function CompareRunner() {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run() {
    setMsg(null);
    setPending(true);
    try {
      const res = await fetch("/api/compare/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: sampleLines }),
      });
      const data = (await res.json()) as { runId?: string; exceptionsCreated?: number; error?: string };
      if (!res.ok) {
        setMsg(data.error ?? "Failed");
        setPending(false);
        return;
      }
      setMsg(
        `Run ${data.runId?.slice(0, 8)}… created; ${data.exceptionsCreated ?? 0} new exception(s).`,
      );
      setPending(false);
    } catch {
      setMsg("Network error");
      setPending(false);
    }
  }

  return (
    <div className="mt-6 space-y-4 rounded-lg border border-[var(--surface-border)] bg-[var(--surface)]/50 p-5">
      <pre className="overflow-x-auto font-mono text-xs text-[var(--muted)]">
        {JSON.stringify(sampleLines, null, 2)}
      </pre>
      <button
        type="button"
        disabled={pending}
        onClick={() => void run()}
        className="rounded-md bg-[var(--accent)] px-4 py-2 font-mono text-sm font-semibold text-[var(--background)] disabled:opacity-50"
      >
        {pending ? "Running…" : "Run compare (POST /api/compare/runs)"}
      </button>
      {msg ? (
        <p className="font-mono text-sm text-[var(--accent)]" role="status">
          {msg}
        </p>
      ) : null}
    </div>
  );
}
