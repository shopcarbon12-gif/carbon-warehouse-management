"use client";

import { useState } from "react";
import { X } from "lucide-react";

export type VarianceSummary = {
  matched: number;
  missing: number;
  misplaced: number;
  unrecognized: number;
};

type Props = {
  open: boolean;
  onClose: () => void;
  summary: VarianceSummary;
  onCommit: () => Promise<void>;
};

export function CycleCountCommitModal({
  open,
  onClose,
  summary,
  onCommit,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;

  const run = async () => {
    setErr(null);
    setBusy(true);
    try {
      await onCommit();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[80] bg-black/70"
        onClick={() => !busy && onClose()}
      />
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
        <div
          className="w-full max-w-md rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-5 shadow-2xl"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-sm font-semibold text-[var(--wms-fg)]">Commit cycle count</h2>
            <button
              type="button"
              onClick={() => !busy && onClose()}
              className="rounded p-1 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-2 font-mono text-[0.65rem] leading-relaxed text-[var(--wms-muted)]">
            Missing tags will be set to <span className="text-amber-400/90">UNKNOWN</span>.
            Misplaced tags will be moved to <span className="text-teal-400/90">in-stock</span> in
            the selected bin. Unrecognized EPCs are audit-only.
          </p>
          <ul className="mt-4 space-y-2 font-mono text-xs text-[var(--wms-fg)]">
            <li className="flex justify-between border-b border-[var(--wms-border)]/80 pb-2">
              <span className="text-[var(--wms-muted)]">Matched</span>
              <span className="text-emerald-400/90">{summary.matched}</span>
            </li>
            <li className="flex justify-between border-b border-[var(--wms-border)]/80 pb-2">
              <span className="text-[var(--wms-muted)]">Missing</span>
              <span className="text-amber-400/90">{summary.missing}</span>
            </li>
            <li className="flex justify-between border-b border-[var(--wms-border)]/80 pb-2">
              <span className="text-[var(--wms-muted)]">Misplaced</span>
              <span className="text-orange-400/90">{summary.misplaced}</span>
            </li>
            <li className="flex justify-between pb-2">
              <span className="text-[var(--wms-muted)]">Unrecognized</span>
              <span className="text-[var(--wms-muted)]">{summary.unrecognized}</span>
            </li>
            <li className="flex justify-between border-t border-[var(--wms-border)] pt-2 font-medium text-[var(--wms-fg)]">
              <span>Scanned EPCs</span>
              <span>
                {summary.matched + summary.misplaced + summary.unrecognized}
              </span>
            </li>
          </ul>
          {err ? (
            <p className="mt-3 font-mono text-xs text-red-400/90">{err}</p>
          ) : null}
          <div className="mt-5 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onClose()}
              className="flex-1 rounded-lg border border-[var(--wms-border)] py-2.5 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run()}
              className="flex-1 rounded-lg border border-teal-600/50 bg-teal-950/40 py-2.5 font-mono text-xs font-medium text-teal-200 hover:bg-teal-900/30 disabled:opacity-50"
            >
              {busy ? "Committing…" : "Commit"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
