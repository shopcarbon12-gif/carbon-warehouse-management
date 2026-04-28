"use client";

import { useEffect } from "react";
import { Radio, X } from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Card header — same shape the staged-payload row shows. */
  sku: string;
  name: string | null;
  color: string | null;
  size: string | null;
  /** EPCs currently staged for this Custom SKU (ordered as scanned). */
  epcs: string[];
  /** Optional: remove a single EPC from the staged set. */
  onRemoveEpc?: (epc: string) => void;
};

export function StagedEpcsModal({
  open,
  onClose,
  sku,
  name,
  color,
  size,
  epcs,
  onRemoveEpc,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const variant = [color, size].filter(Boolean).join(" · ");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-xl">
        <div className="flex items-start justify-between border-b border-[var(--wms-border)] px-5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-[var(--wms-accent)]" />
              <h3 className="font-mono text-sm font-semibold text-[var(--wms-fg)]">
                Staged EPCs
              </h3>
              <span className="rounded bg-[var(--wms-surface-elevated)] px-2 py-0.5 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                {epcs.length}
              </span>
            </div>
            <div className="mt-1 truncate font-mono text-[0.7rem] text-[var(--wms-muted)]">
              {name ?? "—"}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">
              <span>SKU: {sku}</span>
              {variant ? <span>· {variant}</span> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-3">
          {epcs.length === 0 ? (
            <p className="py-6 text-center font-mono text-xs text-[var(--wms-muted)]">
              No EPCs staged.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--wms-border)]/60 font-mono text-[0.7rem]">
              {epcs.map((e) => (
                <li
                  key={e}
                  className="flex items-center justify-between gap-3 py-1.5"
                >
                  <span className="select-all break-all text-teal-400/85">{e}</span>
                  {onRemoveEpc ? (
                    <button
                      type="button"
                      onClick={() => onRemoveEpc(e)}
                      title="Remove from staged set"
                      className="rounded border border-red-400/30 px-2 py-0.5 text-[0.6rem] uppercase text-red-400/80 hover:bg-red-400/10"
                    >
                      Remove
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-[var(--wms-border)] px-5 py-2">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded border border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
