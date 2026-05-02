"use client";

import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";

const CONFIRM_PHRASE = "ZERO OUT EVERYTHING";

type ZeroOutResponse = {
  ok: true;
  total_deleted: number;
  counts: { table: string; before: number; deleted: number }[];
};

export function ZeroOutRfidButton({ onZeroed }: { onZeroed?: () => void }) {
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ZeroOutResponse | null>(null);

  const close = () => {
    if (busy) return;
    setOpen(false);
    setPhrase("");
    setErr(null);
    setResult(null);
  };

  const run = async () => {
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/rfid/zero-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: phrase }),
      });
      const j = (await res.json()) as ZeroOutResponse | { error: string };
      if (!res.ok || !("ok" in j)) {
        throw new Error(("error" in j && j.error) || "Zero-out failed");
      }
      setResult(j);
      onZeroed?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Zero-out failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-red-700/60 bg-red-950/40 px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wide text-red-200 hover:border-red-500 hover:bg-red-900/60"
      >
        <AlertTriangle className="h-4 w-4" />
        Zero out RFID data
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
              className="w-full max-w-md rounded-xl border-2 border-red-700/60 bg-[var(--wms-surface)] p-5 shadow-2xl"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-red-300">
                  <AlertTriangle className="h-4 w-4" />
                  Zero out all RFID data
                </h2>
                <button
                  type="button"
                  onClick={close}
                  className="rounded p-1 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
                  aria-label="Close"
                  disabled={busy}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {result ? (
                <div className="mt-3 space-y-3">
                  <p className="font-mono text-xs text-emerald-300">
                    Zeroed out{" "}
                    <span className="font-semibold">
                      {result.total_deleted.toLocaleString()}
                    </span>{" "}
                    rows across {result.counts.filter((c) => c.deleted > 0).length}{" "}
                    table(s).
                  </p>
                  <ul className="max-h-48 space-y-1 overflow-auto rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-2 font-mono text-[0.65rem] text-[var(--wms-fg)]">
                    {result.counts.map((c) => (
                      <li key={c.table} className="flex justify-between">
                        <span className="text-[var(--wms-muted)]">{c.table}</span>
                        <span>{c.deleted.toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onClick={close}
                    className="wms-btn-primary w-full font-mono"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <>
                  <p className="mt-2 font-mono text-[0.7rem] leading-relaxed text-[var(--wms-muted)]">
                    Wipes every commissioned EPC, every raw reader read, every
                    handheld batch, every device-queue entry, every transfer
                    line-item, every asset movement, every rfid alarm, every
                    encode event, every cycle-count comparison row, and every
                    inventory-snapshot row — for this tenant.
                  </p>
                  <p className="mt-2 font-mono text-[0.7rem] leading-relaxed text-[var(--wms-muted)]">
                    <span className="text-emerald-300">Stays:</span> audit log,
                    inventory audit logs, saved reports, sync logs, replenishment
                    logs, exceptions, cycle-count run history, catalog (matrices
                    + custom SKUs), users, locations, devices.
                  </p>
                  <p className="mt-2 font-mono text-[0.7rem] leading-relaxed text-amber-300">
                    This cannot be undone.
                  </p>
                  <label className="mt-4 block font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
                    Type{" "}
                    <span className="text-red-300">{CONFIRM_PHRASE}</span> to
                    enable the button
                  </label>
                  <input
                    type="text"
                    value={phrase}
                    onChange={(e) => setPhrase(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-1 w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
                    disabled={busy}
                  />
                  {err ? (
                    <p className="mt-3 font-mono text-xs text-red-400/90">{err}</p>
                  ) : null}
                  <div className="mt-5 flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={close}
                      className="flex-1 rounded-lg border-2 border-[var(--wms-border)] bg-[var(--wms-surface)] py-2.5 font-mono text-sm font-medium text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={busy || phrase !== CONFIRM_PHRASE}
                      onClick={() => void run()}
                      className="flex-1 rounded-lg border-2 border-red-700/60 bg-red-900/40 py-2.5 font-mono text-sm font-semibold text-red-200 hover:bg-red-800/60 disabled:opacity-40"
                    >
                      {busy ? "Wiping…" : "Zero out"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
