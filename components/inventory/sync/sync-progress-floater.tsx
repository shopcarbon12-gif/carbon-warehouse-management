"use client";

/**
 * Global Lightspeed sync progress bar — top-right corner, follows the
 * operator across pages. Activated when the preview modal POSTs apply
 * and stores the job_id in sessionStorage under SYNC_JOB_KEY.
 *
 * Lifecycle:
 *   1. Mounts on every page (lives in app layout). Reads sessionStorage.
 *   2. While there's a job_id, polls /api/inventory/sync/jobs/[id]/progress
 *      every 1.5s.
 *   3. On status='completed' or 'failed', shows the terminal state for
 *      ~6s then auto-dismisses (clears sessionStorage so a refresh doesn't
 *      re-show it).
 *   4. The widget itself is a small fixed pill the operator can dismiss
 *      manually with the X — clearing sessionStorage immediately.
 *
 * Survives full page reloads via sessionStorage. Doesn't require the
 * preview modal to remain mounted.
 */

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, X, AlertTriangle } from "lucide-react";

const SYNC_JOB_KEY = "wms.lightspeedSyncJobId";
const POLL_MS = 1500;
const TERMINAL_LINGER_MS = 6000;

type Progress = {
  status: string;
  progress_done: number;
  progress_total: number;
  progress_pct: number;
  progress_message: string;
  eta_seconds: number | null;
  error: string | null;
  records_inserted_or_updated: number | null;
  records_archived: number | null;
};

/** Imperative helper for the modal: stash the job id, the floater picks it up. */
export function startSyncJobTracking(jobId: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(SYNC_JOB_KEY, jobId);
  // Notify any mounted floater in the same tab — sessionStorage 'storage'
  // events don't fire same-tab. CustomEvent does.
  window.dispatchEvent(new CustomEvent("wms-sync-job-started"));
}

export function SyncProgressFloater() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const init = () => {
      const j = window.sessionStorage.getItem(SYNC_JOB_KEY);
      setJobId(j);
      setDismissed(false);
    };
    init();
    const onStart = () => init();
    window.addEventListener("wms-sync-job-started", onStart);
    return () => window.removeEventListener("wms-sync-job-started", onStart);
  }, []);

  useEffect(() => {
    if (!jobId || dismissed) return;
    let cancelled = false;
    let lingerTimer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const res = await fetch(`/api/inventory/sync/jobs/${encodeURIComponent(jobId)}/progress`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const j = (await res.json()) as Progress;
        if (cancelled) return;
        setProgress(j);
        if (j.status === "completed" || j.status === "failed" || j.status === "cancelled") {
          // Wait, then clear job id so refresh doesn't re-show.
          lingerTimer = setTimeout(() => {
            if (cancelled) return;
            window.sessionStorage.removeItem(SYNC_JOB_KEY);
            setJobId(null);
          }, TERMINAL_LINGER_MS);
        }
      } catch {
        /* transient — keep trying */
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (lingerTimer) clearTimeout(lingerTimer);
    };
  }, [jobId, dismissed]);

  const onDismiss = useCallback(() => {
    window.sessionStorage.removeItem(SYNC_JOB_KEY);
    setJobId(null);
    setDismissed(true);
  }, []);

  if (!jobId || dismissed || !progress) return null;

  const status = progress.status;
  const pct = Math.max(0, Math.min(100, progress.progress_pct));
  const isTerminal = status === "completed" || status === "failed" || status === "cancelled";

  return (
    <div className="pointer-events-auto fixed right-4 top-4 z-[120] w-72 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-xl">
      <div className="flex items-center gap-2 border-b border-[var(--wms-border)] px-3 py-2">
        {status === "running" || status === "preview" ? (
          <RefreshCw className="h-3.5 w-3.5 animate-spin text-[var(--wms-accent)]" />
        ) : status === "completed" ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
        )}
        <p className="flex-1 font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-fg)]">
          Lightspeed sync
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-0.5 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
          aria-label="Dismiss"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="px-3 py-2.5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--wms-surface-elevated)]">
          <div
            className={`h-full transition-all ${
              status === "completed"
                ? "bg-emerald-400"
                : status === "failed"
                  ? "bg-red-400"
                  : "bg-[var(--wms-accent)]"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-1.5 font-mono text-[0.6rem] text-[var(--wms-muted)]">
          {progress.progress_message ||
            (isTerminal ? status : "Working…")}
        </p>
        <p className="font-mono text-[0.6rem] tabular-nums text-[var(--wms-muted)]">
          {progress.progress_done.toLocaleString()} / {progress.progress_total.toLocaleString()} ({pct}%)
          {progress.eta_seconds != null && status === "running"
            ? ` · ${formatEta(progress.eta_seconds)} left`
            : ""}
        </p>
        {progress.error ? (
          <p className="mt-1 font-mono text-[0.6rem] text-red-300">{progress.error}</p>
        ) : null}
        {status === "completed" && progress.records_archived != null ? (
          <p className="mt-1 font-mono text-[0.6rem] text-[var(--wms-muted)]">
            +{(progress.records_inserted_or_updated ?? 0).toLocaleString()} written
            {" · "}
            {progress.records_archived.toLocaleString()} archived
          </p>
        ) : null}
      </div>
    </div>
  );
}

function formatEta(s: number): string {
  if (s < 60) return `~${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `~${m}m ${r}s`;
  const h = Math.floor(m / 60);
  return `~${h}h ${m % 60}m`;
}
