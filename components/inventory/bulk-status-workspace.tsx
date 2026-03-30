"use client";

import { useState } from "react";

import { bulkStatusOptionsForUi } from "@/lib/inventory/bulk-wms-status-options";

export function BulkStatusWorkspace({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [raw, setRaw] = useState("");
  const options = bulkStatusOptionsForUi(isSuperAdmin);
  const [target, setTarget] = useState<string>(options[0]?.value ?? "in-stock");
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
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        updated?: number;
        code?: string;
      };
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
        {!isSuperAdmin
          ? "System workflow targets (in transit, pending visibility, pending transaction) are hidden — Super Admin only. Items in Super Admin–locked statuses cannot be changed here."
          : "Super Admin: all Clean 10 targets are available; use Override for risky transitions."}
      </p>
      <label className="flex flex-col gap-2 font-mono text-xs text-[var(--wms-muted)]">
        Target status
        <select
          className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 font-mono text-xs text-[var(--wms-muted)]">
        <input
          type="checkbox"
          checked={override}
          onChange={(e) => setOverride(e.target.checked)}
          disabled={!isSuperAdmin}
        />
        Allow risky transitions (Super Admin only)
      </label>
      <textarea
        className="min-h-[180px] rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3 font-mono text-sm text-[var(--wms-fg)]"
        placeholder="EPCs…"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="rounded-md bg-emerald-600 px-4 py-2 font-mono text-sm font-semibold text-white disabled:opacity-50"
      >
        {busy ? "Working…" : "Apply bulk status"}
      </button>
      {msg ? <p className="font-mono text-sm text-[var(--wms-fg)]">{msg}</p> : null}
    </div>
  );
}
