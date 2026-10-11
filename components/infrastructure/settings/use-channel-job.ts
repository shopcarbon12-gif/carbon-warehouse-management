"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";

export type ChannelJobStatus = {
  connected: {
    claude: boolean;
    claude_model: string;
    google_merchant: boolean;
    google_ads: boolean;
    meta: boolean;
  };
  translate: { id: string; status: string; finished_at: string | null; created_at: string } | null;
  ads: { id: string; status: string; finished_at: string | null; created_at: string } | null;
};

export type ChannelJob<R> = {
  type: "translate" | "ads";
  status: string;
  done: number;
  total: number;
  pct: number;
  message: string | null;
  error: string | null;
  full_title_check: boolean;
  result: R | null;
  started_at: string | null;
  finished_at: string | null;
};

export const jsonFetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
};

export function useChannelStatus() {
  return useSWR<ChannelJobStatus>("/api/shopify/channel-jobs", jsonFetcher, { revalidateOnFocus: false });
}

/**
 * Follows one Translate / Sync ads run: shows the latest run on load, starts a
 * new one, and polls it every 2 s until it finishes.
 */
export function useChannelJob<R>(kind: "translate" | "ads", latestId: string | null | undefined, onDone?: () => void) {
  const [startedId, setStartedId] = useState<string | null>(null);
  // A run started here wins; otherwise follow the most recent run on record.
  const jobId = startedId ?? latestId ?? null;
  const [job, setJob] = useState<ChannelJob<R> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
    const tick = async () => {
      try {
        const j = (await jsonFetcher(`/api/shopify/channel-jobs/${jobId}`)) as ChannelJob<R>;
        if (stopped) return;
        setJob(j);
        if (j.status === "completed" || j.status === "failed") {
          stop();
          doneRef.current?.();
        }
      } catch {
        /* transient — keep polling */
      }
    };
    void tick();
    timer.current = setInterval(tick, 2000);
    return stop;
  }, [jobId]);

  const start = useCallback(
    async (extra: Record<string, unknown> = {}) => {
      setErr(null);
      setStarting(true);
      try {
        const res = await fetch("/api/shopify/channel-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: kind, ...extra }),
        });
        const j = (await res.json().catch(() => ({}))) as { job_id?: string; error?: string };
        if (!res.ok || !j.job_id) throw new Error(j.error ?? "Could not start");
        setJob(null);
        setStartedId(j.job_id);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not start");
      } finally {
        setStarting(false);
      }
    },
    [kind],
  );

  const running = starting || job?.status === "queued" || job?.status === "running";
  return { job, running, err, start };
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}
