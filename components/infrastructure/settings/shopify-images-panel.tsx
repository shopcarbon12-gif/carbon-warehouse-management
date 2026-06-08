"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Image as ImageIcon, RefreshCw } from "lucide-react";

type Status = {
  connected: boolean;
  store: string | null;
  matrices_total: number;
  matrices_with_pictures: number;
  skus_total: number;
  skus_with_picture: number;
  last_synced_at: string | null;
  active_job_id: string | null;
};

type Progress = {
  status: string;
  done: number;
  total: number;
  pct: number;
  message: string | null;
  error: string | null;
  result: { total?: number; synced?: number; withPics?: number; skipped?: number } | null;
};

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
};

function fmtWhen(iso: string | null): string {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Settings → Shopify: product imagery. Shows how many products/variants have
 * a synced Shopify picture and a button to pull the latest from Shopify (runs
 * as a background worker job; we poll its progress). It is a manual pull — by
 * design there is no automatic sync.
 */
export function ShopifyImagesPanel() {
  const { data: status, mutate } = useSWR<Status>("/api/shopify/sync/status", fetcher, {
    revalidateOnFocus: false,
  });
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Adopt an already-running sync (e.g. someone else started it / page reload).
  useEffect(() => {
    if (status?.active_job_id && !jobId) setJobId(status.active_job_id);
  }, [status?.active_job_id, jobId]);

  // Poll the active job until it reaches a terminal state.
  useEffect(() => {
    if (!jobId) return;
    const stop = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
    const tick = async () => {
      try {
        const p = (await fetcher(`/api/shopify/sync/jobs/${jobId}/progress`)) as Progress;
        setProgress(p);
        if (p.status === "completed" || p.status === "failed") {
          stop();
          setJobId(null);
          setBusy(false);
          if (p.status === "failed") setErr(p.error ?? "Sync failed");
          void mutate();
        }
      } catch {
        /* transient — keep polling */
      }
    };
    void tick();
    pollRef.current = setInterval(tick, 2000);
    return stop;
  }, [jobId, mutate]);

  const startSync = useCallback(async () => {
    setErr(null);
    setBusy(true);
    setProgress(null);
    try {
      const res = await fetch("/api/shopify/sync/trigger", { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { job_id?: string; error?: string };
      if (!res.ok || !j.job_id) throw new Error(j.error ?? "Could not start sync");
      setJobId(j.job_id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start sync");
      setBusy(false);
    }
  }, []);

  const running = busy || Boolean(jobId);

  return (
    <div className="space-y-4 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-accent)]">
          <ImageIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h3 className="font-mono text-sm font-semibold text-[var(--wms-fg)]">Product pictures</h3>
          <p className="mt-0.5 font-mono text-[0.7rem] leading-relaxed text-[var(--wms-muted)]">
            Pulls product images from Shopify into the catalog (keeping Shopify CDN links — nothing
            stored on our server). Shown in the catalog, item & matrix windows, POS, and the
            handheld lookup. Manual pull — re-run after you add or change pictures in Shopify.
          </p>
        </div>
      </div>

      {/* Connection + coverage */}
      <div className="grid grid-cols-2 gap-2 font-mono text-[0.7rem] sm:grid-cols-4">
        <Stat
          label="Store"
          value={status?.connected ? (status.store ?? "connected") : "not connected"}
          ok={status?.connected}
        />
        <Stat
          label="Products w/ pics"
          value={status ? `${status.matrices_with_pictures} / ${status.matrices_total}` : "…"}
        />
        <Stat
          label="Variants w/ pics"
          value={status ? `${status.skus_with_picture} / ${status.skus_total}` : "…"}
        />
        <Stat label="Last synced" value={fmtWhen(status?.last_synced_at ?? null)} />
      </div>

      {/* Action */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={running || status?.connected === false}
          onClick={() => void startSync()}
          title={
            status?.connected === false
              ? "Set SHOPIFY_SHOP_DOMAIN + admin token in Coolify first"
              : "Pull the latest product pictures from Shopify"
          }
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-5 py-2.5 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90 disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
          {running ? "Syncing…" : "Sync pictures from Shopify"}
        </button>
        {err ? <span className="font-mono text-xs text-red-400/90">{err}</span> : null}
      </div>

      {/* Live progress */}
      {progress && running ? (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--wms-surface-elevated)]">
            <div
              className="h-full rounded-full bg-[var(--wms-accent)] transition-[width] duration-300"
              style={{ width: `${Math.max(2, progress.pct)}%` }}
            />
          </div>
          <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
            {progress.message ?? `${progress.done}/${progress.total}`} · {progress.pct}%
          </p>
        </div>
      ) : null}
      {progress && !running && progress.status === "completed" ? (
        <p className="font-mono text-[0.65rem] text-emerald-500/90">
          {progress.message ?? "Done."}
        </p>
      ) : null}
    </div>
  );
}

function Stat({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 px-3 py-2">
      <div className="text-[0.55rem] uppercase tracking-wide text-[var(--wms-muted)]">{label}</div>
      <div
        className={`mt-0.5 truncate ${
          ok === false ? "text-amber-500" : ok === true ? "text-emerald-500" : "text-[var(--wms-fg)]"
        }`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}
