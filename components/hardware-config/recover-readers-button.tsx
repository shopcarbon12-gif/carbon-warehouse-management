"use client";

import { useEffect, useRef, useState } from "react";
import { LifeBuoy, X } from "lucide-react";

type ReaderRow = {
  id: string;
  name: string;
  network_address: string | null;
  monsoon_driver: string;
  is_authorized: boolean;
};

type RecentReads = {
  last_read_at: string | null;
  reads_last_5_min: number;
  reads_last_hour: number;
};

type Diagnosis = {
  agent_id: string;
  agent_name: string;
  status: string;
  last_heartbeat_at: string | null;
  last_heartbeat_age_seconds: number | null;
  recover_requested_at: string | null;
  readers: ReaderRow[];
  recent_reads: RecentReads;
};

type Phase =
  | "idle"
  | "loading_diagnosis"
  | "diagnosis_loaded"
  | "submitting"
  | "waiting_for_restart"
  | "succeeded"
  | "stuck_after_restart"
  | "failed";

const RESTART_POLL_INTERVAL_MS = 4_000;
const RESTART_TIMEOUT_MS = 90_000;
const POST_RESTART_READ_GRACE_MS = 30_000;

function fmtAge(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export function RecoverReadersButton({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [postDiag, setPostDiag] = useState<Diagnosis | null>(null);
  const [requestedAt, setRequestedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollHandleRef = useRef<NodeJS.Timeout | null>(null);

  const close = () => {
    if (phase === "submitting" || phase === "waiting_for_restart") return;
    if (pollHandleRef.current) clearInterval(pollHandleRef.current);
    pollHandleRef.current = null;
    setOpen(false);
    setPhase("idle");
    setDiag(null);
    setPostDiag(null);
    setRequestedAt(null);
    setError(null);
  };

  useEffect(() => {
    if (!open || phase !== "loading_diagnosis") return;
    void (async () => {
      setError(null);
      try {
        const res = await fetch(`/api/cdm-agents/${agentId}/recover`, { method: "GET" });
        const j = await res.json();
        if (!res.ok || !j.diagnosis) throw new Error(j.error ?? "Failed to load diagnosis");
        setDiag(j.diagnosis as Diagnosis);
        setPhase("diagnosis_loaded");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load diagnosis");
        setPhase("failed");
      }
    })();
  }, [open, phase, agentId]);

  const submit = async () => {
    setError(null);
    setPhase("submitting");
    try {
      const res = await fetch(`/api/cdm-agents/${agentId}/recover`, { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Recover failed");
      setRequestedAt(j.recover_requested_at);
      setPhase("waiting_for_restart");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recover failed");
      setPhase("failed");
    }
  };

  // Polling loop: after submit, watch for evidence the agent restarted —
  // last_heartbeat_at advances past requested_at. Then watch reads for
  // POST_RESTART_READ_GRACE_MS to verify the readers came back.
  useEffect(() => {
    if (phase !== "waiting_for_restart" || !requestedAt) return;
    const startedAt = Date.now();
    const reqMs = Date.parse(requestedAt);

    const tick = async () => {
      try {
        const res = await fetch(`/api/cdm-agents/${agentId}/recover`, { method: "GET" });
        const j = await res.json();
        if (!res.ok || !j.diagnosis) return;
        const d = j.diagnosis as Diagnosis;
        const hbMs = d.last_heartbeat_at ? Date.parse(d.last_heartbeat_at) : 0;

        if (hbMs > reqMs) {
          // Agent has heartbeat'd AFTER we sent the recover, meaning the
          // heartbeat-after-restart already landed (server cleared the flag
          // because boot_time > recover_requested_at).
          setPostDiag(d);
          // Give readers up to POST_RESTART_READ_GRACE_MS to start producing.
          if (Date.now() - startedAt > POST_RESTART_READ_GRACE_MS) {
            if (d.recent_reads.reads_last_5_min > (diag?.recent_reads.reads_last_5_min ?? 0)) {
              setPhase("succeeded");
            } else {
              setPhase("stuck_after_restart");
            }
          }
          return;
        }
        if (Date.now() - startedAt > RESTART_TIMEOUT_MS) {
          setPostDiag(d);
          setPhase("stuck_after_restart");
        }
      } catch {
        // ignore transient errors during polling
      }
    };

    void tick();
    pollHandleRef.current = setInterval(tick, RESTART_POLL_INTERVAL_MS);
    return () => {
      if (pollHandleRef.current) clearInterval(pollHandleRef.current);
      pollHandleRef.current = null;
    };
  }, [phase, requestedAt, agentId, diag]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setPhase("loading_diagnosis");
        }}
        title="Restart agent + reset stuck readers"
        className="mr-2 inline-flex items-center gap-1 rounded border border-amber-400/40 px-2 py-1 font-mono text-[0.6rem] uppercase text-amber-300 hover:bg-amber-400/10"
      >
        <LifeBuoy className="h-3 w-3" /> Recover
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-[80] bg-black/70"
            onClick={close}
          />
          <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
            <div
              role="dialog"
              aria-modal="true"
              className="w-full max-w-lg rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-5 shadow-2xl"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--wms-fg)]">
                  <LifeBuoy className="h-4 w-4 text-amber-300" />
                  Recover readers — {agentName}
                </h2>
                <button
                  type="button"
                  onClick={close}
                  disabled={phase === "submitting" || phase === "waiting_for_restart"}
                  className="rounded p-1 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {phase === "loading_diagnosis" ? (
                <p className="mt-4 font-mono text-xs text-[var(--wms-muted)]">Running diagnosis…</p>
              ) : null}

              {error ? <p className="mt-3 font-mono text-xs text-red-400/90">{error}</p> : null}

              {diag && phase !== "loading_diagnosis" ? (
                <DiagnosisCard
                  label={phase === "succeeded" || phase === "stuck_after_restart" ? "Before recovery" : "Current state"}
                  diag={diag}
                />
              ) : null}

              {postDiag &&
              (phase === "waiting_for_restart" ||
                phase === "succeeded" ||
                phase === "stuck_after_restart") ? (
                <DiagnosisCard label="After agent restart" diag={postDiag} />
              ) : null}

              {phase === "diagnosis_loaded" ? (
                <>
                  <p className="mt-3 font-mono text-[0.7rem] text-[var(--wms-muted)]">
                    Click Recover to ask the agent to exit cleanly. systemd will respawn it within
                    5 seconds, killing any stuck reader processes and resetting all supervisor
                    state. Reads should resume within ~30 seconds.
                  </p>
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      onClick={close}
                      className="flex-1 rounded-lg border-2 border-[var(--wms-border)] bg-[var(--wms-surface)] py-2.5 font-mono text-sm font-medium text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void submit()}
                      className="flex-1 rounded-lg border-2 border-amber-400/50 bg-amber-500/20 py-2.5 font-mono text-sm font-semibold text-amber-100 hover:bg-amber-500/30"
                    >
                      Recover
                    </button>
                  </div>
                </>
              ) : null}

              {phase === "submitting" ? (
                <p className="mt-3 font-mono text-xs text-[var(--wms-muted)]">
                  Sending recover signal…
                </p>
              ) : null}

              {phase === "waiting_for_restart" ? (
                <p className="mt-3 font-mono text-xs text-amber-300">
                  Waiting for agent to restart… (up to 90 seconds)
                </p>
              ) : null}

              {phase === "succeeded" ? (
                <p className="mt-3 font-mono text-xs text-emerald-300">
                  Agent restarted and reads are flowing again.
                </p>
              ) : null}

              {phase === "stuck_after_restart" ? (
                <div className="mt-3 rounded border border-amber-400/40 bg-amber-500/10 p-3 font-mono text-[0.7rem] leading-relaxed text-amber-100">
                  Agent restarted, but reads still aren&apos;t flowing. The reader hardware
                  itself is likely stuck. Physically power-cycle the reader (unplug Ethernet/power,
                  wait 10 seconds, plug back in), then click Recover again.
                </div>
              ) : null}

              {(phase === "succeeded" ||
                phase === "stuck_after_restart" ||
                phase === "failed") ? (
                <button
                  type="button"
                  onClick={close}
                  className="mt-4 w-full rounded-lg border-2 border-[var(--wms-border)] bg-[var(--wms-surface)] py-2.5 font-mono text-sm font-medium text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
                >
                  Close
                </button>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

function DiagnosisCard({ label, diag }: { label: string; diag: Diagnosis }) {
  return (
    <div className="mt-3 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-3 font-mono text-[0.65rem] text-[var(--wms-fg)]">
      <div className="mb-1 text-[var(--wms-muted)]">{label}</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <div>
          <span className="text-[var(--wms-muted)]">Status:</span> {diag.status}
        </div>
        <div>
          <span className="text-[var(--wms-muted)]">Heartbeat:</span>{" "}
          {fmtAge(diag.last_heartbeat_age_seconds)}
        </div>
        <div>
          <span className="text-[var(--wms-muted)]">Reads (5m):</span>{" "}
          {diag.recent_reads.reads_last_5_min.toLocaleString()}
        </div>
        <div>
          <span className="text-[var(--wms-muted)]">Reads (1h):</span>{" "}
          {diag.recent_reads.reads_last_hour.toLocaleString()}
        </div>
        <div className="col-span-2">
          <span className="text-[var(--wms-muted)]">Last read:</span>{" "}
          {diag.recent_reads.last_read_at
            ? new Date(diag.recent_reads.last_read_at).toLocaleTimeString()
            : "—"}
        </div>
      </div>
      {diag.readers.length > 0 ? (
        <div className="mt-2 border-t border-[var(--wms-border)]/60 pt-2">
          <div className="text-[var(--wms-muted)]">Readers:</div>
          <ul>
            {diag.readers.map((r) => (
              <li key={r.id} className="flex justify-between">
                <span>
                  {r.name} <span className="text-[var(--wms-muted)]">({r.network_address ?? "?"})</span>
                </span>
                <span className="text-[var(--wms-muted)]">{r.monsoon_driver}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
