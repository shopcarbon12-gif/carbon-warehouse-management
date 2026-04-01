"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";

export type StagedRow = {
  epc: string;
  sku: string;
  location_code: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  rows: StagedRow[];
  destinationLabel: string;
  onConfirm: () => Promise<void>;
};

export function TransferCommitModal({
  open,
  onClose,
  rows,
  destinationLabel,
  onConfirm,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const bySku = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      m.set(r.sku, (m.get(r.sku) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  if (!open) return null;

  const run = async () => {
    setErr(null);
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Transfer failed");
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
          className="flex max-h-[min(90vh,560px)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-3">
            <h2 className="text-sm font-semibold text-[var(--wms-fg)]">Confirm transfer</h2>
            <button
              type="button"
              onClick={() => !busy && onClose()}
              className="rounded p-1 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
              Destination · <span className="text-teal-400/90">{destinationLabel}</span>
            </p>
            <h3 className="mt-4 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
              By SKU ({rows.length} EPCs)
            </h3>
            <ul className="mt-2 space-y-1.5 font-mono text-xs text-[var(--wms-fg)]">
              {bySku.map(([sku, n]) => (
                <li
                  key={sku}
                  className="flex justify-between rounded border border-[var(--wms-border)]/80 bg-[var(--wms-surface-elevated)]/50 px-2 py-1.5"
                >
                  <span>{sku}</span>
                  <span className="tabular-nums text-[var(--wms-muted)]">×{n}</span>
                </li>
              ))}
            </ul>
          </div>
          {err ? (
            <p className="px-4 font-mono text-xs text-red-400/90">{err}</p>
          ) : null}
          <div className="flex gap-2 border-t border-[var(--wms-border)] p-4">
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
              disabled={busy || rows.length === 0}
              onClick={() => void run()}
              className="flex-1 rounded-lg border border-orange-600/50 bg-orange-950/30 py-2.5 font-mono text-xs font-medium text-orange-200 hover:bg-orange-900/25 disabled:opacity-40"
            >
              {busy ? "Transferring…" : "Confirm transfer"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
