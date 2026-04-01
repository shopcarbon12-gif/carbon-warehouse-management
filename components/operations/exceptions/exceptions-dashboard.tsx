"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { BellRing, RefreshCw } from "lucide-react";
import { isExceptionOpen } from "@/lib/operations-exception-types";
import type { RfidExceptionAuditRow } from "@/lib/operations-exception-types";
import { ExceptionResolutionModal } from "./exception-resolution-modal";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

type Filter = "OPEN" | "RESOLVED" | "ALL";

export function ExceptionsDashboard() {
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [selected, setSelected] = useState<RfidExceptionAuditRow | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const { data, error, mutate, isValidating } = useSWR<{ rows: RfidExceptionAuditRow[] }>(
    "/api/operations/exceptions",
    fetcher,
    { refreshInterval: 10_000, revalidateOnFocus: true },
  );

  const rows = data?.rows ?? [];

  const filtered = useMemo(() => {
    if (filter === "ALL") return rows;
    return rows.filter((r) =>
      filter === "OPEN" ? isExceptionOpen(r.metadata) : !isExceptionOpen(r.metadata),
    );
  }, [rows, filter]);

  const simulate = async () => {
    setSimBusy(true);
    setToast(null);
    try {
      const res = await fetch("/api/operations/exceptions/simulate", { method: "POST" });
      const j = (await res.json()) as { error?: string; alarm?: RfidExceptionAuditRow };
      if (!res.ok) throw new Error(j.error ?? "Simulate failed");
      setToast(`Simulated dock alarm · ${j.alarm?.id?.slice(0, 8) ?? "ok"}…`);
      await mutate();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Simulate failed");
    } finally {
      setSimBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(["OPEN", "RESOLVED", "ALL"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded-md border px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide ${
              filter === f
                ? "border-red-500/50 bg-red-950/30 text-red-200"
                : "border-[var(--wms-border)] text-[var(--wms-muted)] hover:border-[var(--wms-border)]"
            }`}
          >
            {f}
          </button>
        ))}
        <button
          type="button"
          disabled={simBusy}
          onClick={() => void simulate()}
          className="ml-auto inline-flex items-center gap-2 rounded-lg border border-red-600/40 bg-red-950/20 px-3 py-2 font-mono text-xs text-red-200/90 hover:bg-red-950/35 disabled:opacity-50"
        >
          <BellRing className="h-4 w-4" />
          {simBusy ? "Simulating…" : "Simulate dock alarm"}
        </button>
        <button
          type="button"
          onClick={() => void mutate()}
          disabled={isValidating}
          className="inline-flex items-center gap-1 rounded-lg border border-[var(--wms-border)] px-3 py-2 font-mono text-xs text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isValidating ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Load failed"}
        </p>
      ) : null}
      {toast ? <p className="font-mono text-xs text-[var(--wms-muted)]">{toast}</p> : null}

      <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
        Inbox auto-refreshes every 10s (SWR). Records are{" "}
        <code className="text-[var(--wms-muted)]">audit_log</code> rows with{" "}
        <code className="text-[var(--wms-muted)]">rfid_alarm</code> /{" "}
        <code className="text-[var(--wms-muted)]">rfid_exception</code>.
      </p>

      <ul className="space-y-2">
        {filtered.map((r) => {
          const open = isExceptionOpen(r.metadata);
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setSelected(r)}
                className="w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 px-4 py-3 text-left font-mono text-xs transition-colors hover:border-[var(--wms-border)]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span
                    className={
                      open ? "font-semibold text-red-300/90" : "text-[var(--wms-muted)] line-through"
                    }
                  >
                    {r.action}
                  </span>
                  <span className="text-[0.6rem] text-[var(--wms-muted)]">
                    {new Date(r.created_at).toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 text-[0.6rem] text-[var(--wms-muted)]">
                  {open ? "OPEN" : "RESOLVED"} · {r.entity} · {r.id.slice(0, 8)}…
                </div>
              </button>
            </li>
          );
        })}
      </ul>

      {filtered.length === 0 && !error ? (
        <p className="py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
          No {filter === "ALL" ? "" : filter.toLowerCase()} exceptions.
        </p>
      ) : null}

      <ExceptionResolutionModal
        row={selected}
        onClose={() => setSelected(null)}
        onResolved={() => void mutate()}
      />
    </div>
  );
}
