"use client";

import { useState } from "react";

type Provider = "shopify" | "lightspeed" | "senitron";

export function SyncTrigger() {
  const [busy, setBusy] = useState<Provider | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(p: Provider) {
    setBusy(p);
    setMsg(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: p }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      setMsg(data.message ?? data.error ?? (res.ok ? "Done" : `HTTP ${res.status}`));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  const btn =
    "rounded-md border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 font-mono text-xs font-medium text-[var(--foreground)] transition-colors hover:border-[var(--accent-dim)] hover:text-[var(--accent)] disabled:opacity-50";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {(["shopify", "lightspeed", "senitron"] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={btn}
            disabled={busy !== null}
            onClick={() => run(p)}
          >
            {busy === p ? "…" : `Sync ${p}`}
          </button>
        ))}
      </div>
      {msg ? <p className="font-mono text-xs text-[var(--muted)]">{msg}</p> : null}
    </div>
  );
}
