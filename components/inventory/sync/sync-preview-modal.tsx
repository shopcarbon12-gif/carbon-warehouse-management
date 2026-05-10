"use client";

/**
 * Lightspeed sync preview modal — opens when the operator clicks
 * "Sync Lightspeed". Shows what will change BEFORE anything writes.
 *
 * Two phases:
 *   1. Loading — fetches /api/inventory/sync/preview (10–30s, depends on
 *      catalog size). Spinner with a status message.
 *   2. Review — three tabs (All / Gained / Lost), summary counts at top,
 *      Cancel + Confirm buttons. Confirm POSTs the apply endpoint and
 *      hands the job_id off to the global progress bar (sessionStorage).
 *
 * The diff payload itself can be 5–10MB for a 7,000-item catalog. The
 * tables are rendered with a virtualised slice (first 500 rows + a "show
 * all" override) so the modal stays responsive on lower-end laptops.
 */

import { useEffect, useMemo, useState } from "react";
import { X, Download, AlertTriangle, ArrowDown, ArrowUp, RefreshCw } from "lucide-react";

type DiffRow = {
  ls_system_id: string;
  sku: string;
  name: string | null;
  color: string | null;
  size: string | null;
  upc: string | null;
  vendor: string | null;
  retail_price: string | null;
  archived: boolean;
};

type PreviewResponse = {
  token: string;
  job_id: string;
  summary: {
    lightspeed_total_variants: number;
    lightspeed_total_matrices: number;
    lightspeed_archived_count: number;
    lightspeed_regular_count: number;
    wms_total_before: number;
    wms_total_after: number;
  };
  gained: DiffRow[];
  lost: DiffRow[];
  unchanged_count: number;
};

const ROWS_INITIAL_SLICE = 500;

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called with job_id when the operator clicks Confirm and the apply was queued. */
  onConfirmed: (jobId: string) => void;
};

export function SyncPreviewModal({ open, onClose, onConfirmed }: Props) {
  const [phase, setPhase] = useState<"loading" | "review" | "applying" | "error">("loading");
  const [data, setData] = useState<PreviewResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<"all" | "gained" | "lost">("all");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase("loading");
    setData(null);
    setErrorMsg(null);
    setTab("all");
    setShowAll(false);
    void (async () => {
      try {
        const res = await fetch("/api/inventory/sync/preview", { method: "POST" });
        const j = (await res.json()) as PreviewResponse | { error?: string };
        if (cancelled) return;
        if (!res.ok || !("token" in j)) {
          setErrorMsg("error" in j ? (j.error ?? "Preview failed") : "Preview failed");
          setPhase("error");
          return;
        }
        setData(j);
        setPhase("review");
      } catch (e) {
        if (cancelled) return;
        setErrorMsg(e instanceof Error ? e.message : "Network error");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const allRows = useMemo(() => {
    if (!data) return [] as DiffRow[];
    if (tab === "gained") return data.gained;
    if (tab === "lost") return data.lost;
    return [...data.gained, ...data.lost];
  }, [data, tab]);

  const visibleRows = showAll ? allRows : allRows.slice(0, ROWS_INITIAL_SLICE);

  const onConfirm = async () => {
    if (!data) return;
    setPhase("applying");
    try {
      const res = await fetch(`/api/inventory/sync/preview/${encodeURIComponent(data.token)}/apply`, {
        method: "POST",
      });
      const j = (await res.json()) as { ok?: boolean; job_id?: string; error?: string };
      if (!res.ok || !j.job_id) {
        setErrorMsg(j.error ?? "Apply failed");
        setPhase("error");
        return;
      }
      onConfirmed(j.job_id);
      onClose();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Network error");
      setPhase("error");
    }
  };

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Close preview"
        onClick={phase === "applying" ? undefined : onClose}
        className="fixed inset-0 z-[80] bg-black/60"
      />
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          className="flex w-full max-w-5xl max-h-[90vh] flex-col rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-3">
            <h2 className="font-mono text-sm font-semibold uppercase tracking-wider text-[var(--wms-fg)]">
              Lightspeed sync — preview
            </h2>
            <button
              type="button"
              onClick={phase === "applying" ? undefined : onClose}
              className="rounded p-1 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-30"
              disabled={phase === "applying"}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {phase === "loading" || phase === "applying" ? (
            <div className="flex flex-1 items-center justify-center gap-3 px-6 py-16 font-mono text-xs text-[var(--wms-muted)]">
              <RefreshCw className="h-4 w-4 animate-spin" />
              {phase === "loading"
                ? "Pulling Lightspeed catalog and computing diff…"
                : "Queueing apply…"}
            </div>
          ) : null}

          {phase === "error" ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 font-mono text-xs">
              <AlertTriangle className="h-6 w-6 text-amber-400" />
              <p className="text-[var(--wms-fg)]">Preview failed</p>
              <p className="text-[var(--wms-muted)]">{errorMsg}</p>
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-1.5 text-[var(--wms-fg)]"
              >
                Close
              </button>
            </div>
          ) : null}

          {phase === "review" && data ? (
            <>
              <div className="grid gap-3 border-b border-[var(--wms-border)] px-4 py-3 sm:grid-cols-3 lg:grid-cols-6">
                <SummaryStat label="LS items total" n={data.summary.lightspeed_total_variants} />
                <SummaryStat label="LS matrices" n={data.summary.lightspeed_total_matrices} />
                <SummaryStat label="LS regular" n={data.summary.lightspeed_regular_count} />
                <SummaryStat label="LS archived" n={data.summary.lightspeed_archived_count} />
                <SummaryStat label="WMS now" n={data.summary.wms_total_before} />
                <SummaryStat label="After sync" n={data.summary.wms_total_after} />
              </div>

              <div className="flex items-center gap-2 border-b border-[var(--wms-border)] px-4 py-2">
                <TabBtn active={tab === "all"} onClick={() => { setTab("all"); setShowAll(false); }}>
                  All ({data.gained.length + data.lost.length})
                </TabBtn>
                <TabBtn active={tab === "gained"} onClick={() => { setTab("gained"); setShowAll(false); }}>
                  <ArrowUp className="h-3 w-3" /> Gained ({data.gained.length})
                </TabBtn>
                <TabBtn active={tab === "lost"} onClick={() => { setTab("lost"); setShowAll(false); }}>
                  <ArrowDown className="h-3 w-3" /> Lost ({data.lost.length})
                </TabBtn>
                <span className="ml-auto font-mono text-[0.6rem] text-[var(--wms-muted)]">
                  {data.unchanged_count.toLocaleString()} unchanged
                </span>
                <a
                  href={`/api/inventory/sync/preview/${encodeURIComponent(data.token)}/xlsx`}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex items-center gap-1 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-mono text-[0.6rem] text-[var(--wms-fg)] hover:bg-[var(--wms-surface)]"
                  title="Download full diff as Excel (3 sheets: Catalog, Gained, Lost)"
                >
                  <Download className="h-3 w-3" /> Excel
                </a>
              </div>

              <div className="flex-1 overflow-auto">
                <table className="w-full border-collapse text-left font-mono text-[0.65rem]">
                  <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] uppercase tracking-wider text-[var(--wms-muted)]">
                    <tr className="border-b border-[var(--wms-border)]">
                      <th className="px-2 py-1.5">change</th>
                      <th className="px-2 py-1.5">system_id</th>
                      <th className="px-2 py-1.5">name</th>
                      <th className="px-2 py-1.5">sku</th>
                      <th className="px-2 py-1.5">color</th>
                      <th className="px-2 py-1.5">size</th>
                      <th className="px-2 py-1.5">upc</th>
                      <th className="px-2 py-1.5">price</th>
                      <th className="px-2 py-1.5">archived</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--wms-border)]/60 text-[var(--wms-fg)]">
                    {visibleRows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                          Nothing to show.
                        </td>
                      </tr>
                    ) : (
                      visibleRows.map((r) => {
                        const isGained = data.gained.some((g) => g.ls_system_id === r.ls_system_id);
                        return (
                          <tr key={`${isGained ? "g" : "l"}-${r.ls_system_id}`} className="hover:bg-[var(--wms-surface-elevated)]/40">
                            <td className="px-2 py-1.5">
                              <span
                                className={`rounded px-1.5 py-0.5 text-[0.55rem] uppercase ${
                                  isGained ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"
                                }`}
                              >
                                {isGained ? "gain" : "lose"}
                              </span>
                            </td>
                            <td className="px-2 py-1.5 tabular-nums">{r.ls_system_id}</td>
                            <td className="px-2 py-1.5">{r.name ?? "—"}</td>
                            <td className="px-2 py-1.5">{r.sku}</td>
                            <td className="px-2 py-1.5">{r.color ?? "—"}</td>
                            <td className="px-2 py-1.5">{r.size ?? "—"}</td>
                            <td className="px-2 py-1.5">{r.upc ?? "—"}</td>
                            <td className="px-2 py-1.5 tabular-nums">{r.retail_price ?? "—"}</td>
                            <td className="px-2 py-1.5 text-[var(--wms-muted)]">{r.archived ? "yes" : ""}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
                {!showAll && allRows.length > ROWS_INITIAL_SLICE ? (
                  <div className="border-t border-[var(--wms-border)] px-3 py-2 text-center font-mono text-[0.6rem]">
                    <button
                      type="button"
                      onClick={() => setShowAll(true)}
                      className="text-[var(--wms-accent)] hover:underline"
                    >
                      Show all {allRows.length.toLocaleString()} rows
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-[var(--wms-border)] px-4 py-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-1.5 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void onConfirm()}
                  className="rounded border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)] px-4 py-1.5 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] hover:opacity-90"
                >
                  Confirm sync ({(data.gained.length + data.lost.length).toLocaleString()} change{data.gained.length + data.lost.length === 1 ? "" : "s"})
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}

function SummaryStat({ label, n }: { label: string; n: number }) {
  return (
    <div className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 px-3 py-2">
      <p className="font-mono text-[0.55rem] uppercase tracking-wider text-[var(--wms-muted)]">{label}</p>
      <p className="mt-0.5 font-mono text-base tabular-nums font-semibold text-[var(--wms-fg)]">
        {n.toLocaleString()}
      </p>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded px-2 py-1 font-mono text-[0.65rem] uppercase tracking-wider ${
        active
          ? "bg-[var(--wms-accent)]/20 text-[var(--wms-accent)]"
          : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
      }`}
    >
      {children}
    </button>
  );
}
