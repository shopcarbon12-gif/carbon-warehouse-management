"use client";

import { useCallback, useEffect, useState } from "react";

type Job = {
  id: string;
  job_type: string;
  status: string;
  idempotency_key: string;
  error: string | null;
  attempts: number;
  created_at: string;
};

export function SyncPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);

  const load = useCallback(async () => {
    const res = await fetch("/api/sync/jobs");
    if (!res.ok) return;
    setJobs((await res.json()) as Job[]);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(t);
  }, [load]);

  async function enqueue(t: "lightspeed_pull" | "reconcile") {
    await fetch("/api/sync/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobType: t }),
    });
    void load();
  }

  return (
    <div className="mt-6 space-y-4">
      <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
        Queued <code className="text-[var(--wms-muted)]">lightspeed_pull</code> jobs run the same matrix catalog sync as{" "}
        <strong className="text-[var(--wms-muted)]">Trigger manual sync</strong> when the WMS worker (
        <code className="text-[var(--wms-muted)]">npm run worker</code>) is running.
      </p>
      <div className="flex flex-wrap gap-2 font-mono text-xs">
        <button
          type="button"
          className="rounded-md border border-teal-600/50 bg-teal-950/30 px-3 py-2 font-semibold text-teal-200 hover:bg-teal-900/25"
          onClick={() => void enqueue("lightspeed_pull")}
        >
          Enqueue Lightspeed catalog pull
        </button>
        <button
          type="button"
          className="rounded-md border border-[var(--wms-border)] px-3 py-2 text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]/80"
          onClick={() => void enqueue("reconcile")}
        >
          Enqueue reconcile (stub)
        </button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono text-xs uppercase text-[var(--wms-muted)]">
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Attempts</th>
              <th className="px-4 py-3">Idempotency</th>
              <th className="px-4 py-3">Error</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
                  No jobs yet — enqueue above or POST handheld batches.
                </td>
              </tr>
            ) : (
              jobs.map((j) => (
                <tr
                  key={j.id}
                  className="border-b border-[var(--wms-border)]/60 text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]/70"
                >
                  <td className="px-4 py-2 font-mono text-xs">{j.job_type}</td>
                  <td className="px-4 py-2 font-mono text-xs">{j.status}</td>
                  <td className="px-4 py-2 font-mono text-xs tabular-nums">{j.attempts}</td>
                  <td className="max-w-[200px] truncate px-4 py-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                    {j.idempotency_key}
                  </td>
                  <td className="max-w-xs truncate px-4 py-2 font-mono text-xs text-red-400/90">
                    {j.error ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
