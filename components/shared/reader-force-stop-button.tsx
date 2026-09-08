"use client";

import { useCallback, useState } from "react";
import { Loader2, Square } from "lucide-react";

/**
 * Icon-only "force stop" for the selected reader(s).
 *
 * Why this exists: non-POS readers are cold-by-default and are woken by an
 * in-memory scan-session keyed by reader id. A session belonging to a DIFFERENT
 * workflow kind or a different operator makes the next start fail with
 * "Could not start a reader (reader_busy)", and nothing clears it early — it
 * only lapses on the 30 s leave-grace or the 10-minute idle timer (and a
 * cycle-count session is exempt from the idle rule entirely, so it can hold a
 * reader indefinitely). A page left open in another tab, or a browser closed
 * mid-scan, therefore locks the reader out of every other screen.
 *
 * POSTing to /api/scan-sessions/stop ends those sessions regardless of who owns
 * them, which releases the reader immediately. `onStopped` then lets the host
 * page drop its own capture state so the operator restarts from clean rather
 * than on top of a half-finished read.
 *
 * Deliberately icon-only (a square = the universal stop glyph) so it reads as a
 * secondary control next to the primary Start button and never competes with it
 * for attention.
 */
export function ReaderForceStopButton({
  readerIds,
  networkAddresses,
  onStopped,
  disabled,
  className,
}: {
  /** Reader ids to release. Use with the ReaderPicker's selection. */
  readerIds?: readonly string[];
  /** Or release by current IP, for pages pinned to a fixed reader. */
  networkAddresses?: readonly string[];
  /** Runs after a successful stop — clear the page's capture state here. */
  onStopped?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  const ids = readerIds ?? [];
  const ips = networkAddresses ?? [];
  const nothingTargeted = ids.length === 0 && ips.length === 0;

  const onClick = useCallback(async () => {
    if (busy || nothingTargeted) return;
    setBusy(true);
    setErr(false);
    try {
      const r = await fetch("/api/scan-sessions/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(ids.length > 0 ? { readerIds: [...ids] } : {}),
          ...(ips.length > 0 ? { networkAddresses: [...ips] } : {}),
        }),
      });
      if (!r.ok) {
        setErr(true);
        return;
      }
      onStopped?.();
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  }, [busy, nothingTargeted, ids, ips, onStopped]);

  const label = nothingTargeted
    ? "Select a reader first"
    : "Stop this reader and clear the session (fixes “reader_busy”)";

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled || busy || nothingTargeted}
      aria-label="Stop reader and clear session"
      title={err ? "Stop failed — try again" : label}
      className={
        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-40 max-md:h-10 max-md:w-10 " +
        (err
          ? "border-red-400/60 bg-red-500/10 text-red-300"
          : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-muted)] hover:border-red-400/50 hover:bg-red-500/10 hover:text-red-300") +
        (className ? ` ${className}` : "")
      }
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Square className="h-4 w-4 fill-current" />
      )}
    </button>
  );
}
