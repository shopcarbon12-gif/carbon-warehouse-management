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
    void load();
  }, [load]);

  async function enqueue(t: "lightspeed_pull" | "shopify_push" | "reconcile") {
    await fetch("/api/sync/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobType: t }),
    });
    void load();
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap gap-2 font-mono text-xs">
        <button
          type="button"
          className="rounded-md bg-[var(--accent)] px-3 py-2 font-semibold text-[var(--background)]"
          onClick={() => void enqueue("lightspeed_pull")}
        >
          Enqueue Lightspeed pull (stub)
        </button>
        <button
          type="button"
          className="rounded-md border border-[var(--surface-border)] px-3 py-2 text-[var(--foreground)]"
          onClick={() => void enqueue("shopify_push")}
        >
          Enqueue Shopify push (stub)
        </button>
        <button
          type="button"
          className="rounded-md border border-[var(--surface-border)] px-3 py-2 text-[var(--foreground)]"
          onClick={() => void enqueue("reconcile")}
        >
          Enqueue reconcile (stub)
        </button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-[var(--surface-border)]">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--surface-border)] bg-[var(--surface)] font-mono text-xs uppercase text-[var(--muted)]">
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
                <td colSpan={5} className="px-4 py-8 text-center font-mono text-[var(--muted)]">
                  No jobs yet — enqueue above or POST handheld batches.
                </td>
              </tr>
            ) : (
              jobs.map((j) => (
                <tr
                  key={j.id}
                  className="border-b border-[var(--surface-border)]/60 hover:bg-[var(--surface)]/40"
                >
                  <td className="px-4 py-2 font-mono text-xs">{j.job_type}</td>
                  <td className="px-4 py-2 font-mono text-xs">{j.status}</td>
                  <td className="px-4 py-2 font-mono text-xs tabular-nums">{j.attempts}</td>
                  <td className="max-w-[200px] truncate px-4 py-2 font-mono text-[0.65rem] text-[var(--muted)]">
                    {j.idempotency_key}
                  </td>
                  <td className="max-w-xs truncate px-4 py-2 font-mono text-xs text-red-300">
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
