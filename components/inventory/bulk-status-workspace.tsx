"use client";

import { useState } from "react";

const STATUSES = [
  "in-stock",
  "sold",
  "in-transit",
  "missing",
  "damaged",
  "INCOMPLETE",
  "UNKNOWN",
  "COMMISSIONED",
] as const;

export function BulkStatusWorkspace() {
  const [raw, setRaw] = useState("");
  const [target, setTarget] = useState<string>("in-stock");
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async () => {
    const epcs = raw
      .split(/[\s,;\n]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (!epcs.length) {
      setMsg("Paste or upload EPCs (one per line or separated by spaces).");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/inventory/bulk-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epcs, targetStatus: target, override }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; updated?: number };
      if (!res.ok) throw new Error(j.error ?? "Request failed");
      setMsg(`Updated ${j.updated ?? 0} EPC(s) at the active location.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <p className="font-mono text-xs text-[var(--wms-muted)]">
        Changes apply to the <strong className="text-[var(--wms-fg)]">current location</strong> from the sidebar. Risky
        transitions (for example sold → in-stock) require the override checkbox.
      </p>
      <label className="font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
        Target status
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="mt-1 w-full max-w-xs rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 font-mono text-xs text-[var(--wms-muted)]">
        <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
        Allow override for blocked transitions
      </label>
      <label className="font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
        EPC list
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={12}
          placeholder="E280..."
          className="mt-1 w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs"
        />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="w-fit rounded-lg bg-[var(--wms-accent)] px-4 py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] disabled:opacity-50"
      >
        {busy ? "Applying…" : "Apply status"}
      </button>
      {msg ? <p className="font-mono text-xs text-[var(--wms-muted)]">{msg}</p> : null}
    </div>
  );
}
