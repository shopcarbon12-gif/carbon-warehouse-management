"use client";

import { memo, useId, useState } from "react";
import useSWR from "swr";
import { RefreshCw } from "lucide-react";
import { SyncEngine } from "@/components/sync/sync-engine";
import { SyncHistoryLog } from "./sync-history-log";
import { SyncPanel } from "./sync-panel";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

type TabId = "engine" | "compare";

const TABS: { id: TabId; label: string }[] = [
  { id: "engine", label: "Sync engine" },
  { id: "compare", label: "Live compare" },
];

/**
 * Isolated from parent tab state: when only `activeTab` changes in SyncDashboard,
 * React.memo skips re-rendering this subtree (including SyncHistoryLog).
 */
const SyncEngineTabBody = memo(function SyncEngineTabBody() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const { data, error, mutate } = useSWR<{
    last_success_at: string | null;
    total_catalog_skus: number;
  }>("/api/inventory/sync/status", fetcher, { refreshInterval: 20_000 });

  const trigger = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/inventory/sync/trigger", { method: "POST" });
      const j = (await res.json()) as {
        error?: string;
        message?: string;
        records_updated?: number;
        source?: string;
        warnings?: string[];
      };
      if (!res.ok) throw new Error(j.error ?? "Trigger failed");
      const parts = [j.message ?? "Sync finished."];
      if (typeof j.records_updated === "number") {
        parts.push(`${j.records_updated} SKU row(s) updated.`);
      }
      if (j.source) parts.push(`Source: ${j.source}.`);
      if (j.warnings?.length) {
        parts.push(`${j.warnings.length} warning(s) — see sync history payload.`);
      }
      setMsg(parts.join(" "));
      await mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="rounded-xl border border-slate-800 bg-zinc-950/80 p-6">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-wide text-slate-500">
          Catalog sync
        </h2>
        {error ? (
          <p className="mt-2 font-mono text-xs text-red-400/90">
            {error instanceof Error ? error.message : "Status unavailable"}
          </p>
        ) : null}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-800 bg-zinc-900/40 p-4">
            <div className="font-mono text-[0.6rem] uppercase text-slate-500">Last success</div>
            <div className="mt-1 font-mono text-sm text-teal-400/90">
              {data?.last_success_at
                ? new Date(data.last_success_at).toLocaleString()
                : "—"}
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-zinc-900/40 p-4">
            <div className="font-mono text-[0.6rem] uppercase text-slate-500">
              Synchronized SKUs
            </div>
            <div className="mt-1 font-mono text-2xl tabular-nums text-slate-200">
              {data?.total_catalog_skus ?? "—"}
            </div>
            <p className="mt-2 font-mono text-[0.55rem] text-slate-600">
              Total <code className="text-slate-500">custom_skus</code> rows in the matrix catalog.
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void trigger()}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-violet-600/45 bg-violet-950/25 py-3 font-mono text-sm font-medium text-violet-200 hover:bg-violet-900/20 disabled:opacity-50 sm:w-auto sm:px-10"
        >
          <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
          {busy ? "Syncing…" : "Trigger manual sync"}
        </button>
        {msg ? (
          <p className="mt-3 font-mono text-xs text-slate-500">{msg}</p>
        ) : null}
      </div>

      <SyncHistoryLog />
    </div>
  );
});

const LiveCompareTabBody = memo(function LiveCompareTabBody() {
  return (
    <div className="space-y-10">
      <div>
        <p className="font-mono text-xs text-slate-500">
          Compare POS on-hand (mock) to RFID in-stock EPC counts at the active location.
        </p>
        <div className="mt-4">
          <SyncEngine />
        </div>
      </div>

      <section className="border-t border-slate-800 pt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Background jobs
        </h2>
        <p className="mt-1 font-mono text-xs text-slate-500">
          Queue jobs in Postgres; run{" "}
          <code className="text-teal-500/90">npm run worker</code> (or a second Coolify service) to
          process them.
        </p>
        <SyncPanel />
      </section>
    </div>
  );
});

export function SyncDashboard() {
  const [activeTab, setActiveTab] = useState<TabId>("engine");
  const baseId = useId();

  return (
    <div className="space-y-6">
      <div
        role="tablist"
        aria-label="Sync dashboard sections"
        className="flex flex-wrap gap-2 border-b border-slate-800 pb-2"
      >
        {TABS.map((t) => {
          const selected = activeTab === t.id;
          const tabId = `${baseId}-tab-${t.id}`;
          const panelId = `${baseId}-panel-${t.id}`;
          return (
            <button
              key={t.id}
              id={tabId}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveTab(t.id)}
              className={`rounded-t-md px-4 py-2 font-mono text-xs uppercase tracking-wide transition-colors ${
                selected
                  ? "border border-b-0 border-slate-700 bg-zinc-900 text-teal-300/90"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="relative min-h-[12rem]">
        {TABS.map((t) => {
          const hidden = activeTab !== t.id;
          const tabId = `${baseId}-tab-${t.id}`;
          const panelId = `${baseId}-panel-${t.id}`;
          return (
            <div
              key={t.id}
              id={panelId}
              role="tabpanel"
              aria-labelledby={tabId}
              hidden={hidden}
            >
              {t.id === "engine" ? <SyncEngineTabBody /> : <LiveCompareTabBody />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
