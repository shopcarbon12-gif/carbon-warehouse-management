"use client";

import { useState } from "react";
import { X } from "lucide-react";
import {
  isExceptionOpen,
  type RfidExceptionAuditRow,
} from "@/lib/operations-exception-types";

type Props = {
  row: RfidExceptionAuditRow | null;
  onClose: () => void;
  onResolved: () => void;
};

function epcsFromMeta(meta: Record<string, unknown> | null): string[] {
  if (!meta) return [];
  const raw = meta.epcs;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

export function ExceptionResolutionModal({ row, onClose, onResolved }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!row) return null;

  const open = isExceptionOpen(row.metadata);
  const epcs = epcsFromMeta(row.metadata);

  const resolve = async (resolution: "return_to_stock" | "mark_missing") => {
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/operations/exceptions/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auditLogId: row.id,
          resolution,
        }),
      });
      const data = (await res.json()) as { error?: string; updated_items?: number };
      if (!res.ok) throw new Error(data.error ?? "Resolve failed");
      onResolved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Resolve failed");
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
        <div className="w-full max-w-md rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-5 shadow-2xl">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-[var(--wms-fg)]">Resolve exception</h2>
              <p className="mt-1 font-mono text-[0.6rem] text-[var(--wms-muted)]">
                {row.action} · {new Date(row.created_at).toLocaleString()}
              </p>
            </div>
            <button
              type="button"
              onClick={() => !busy && onClose()}
              className="rounded p-1 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <h3 className="mt-4 font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">Triggered EPCs</h3>
          <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto font-mono text-[0.65rem] text-red-300/90">
            {epcs.length ? (
              epcs.map((e) => <li key={e}>{e}</li>)
            ) : (
              <li className="text-[var(--wms-muted)]">No EPC list on this record.</li>
            )}
          </ul>

          {err ? (
            <p className="mt-3 font-mono text-xs text-red-400/90">{err}</p>
          ) : null}

          {!open ? (
            <p className="mt-4 font-mono text-xs text-[var(--wms-muted)]">Already resolved.</p>
          ) : (
            <>
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resolve("return_to_stock")}
                  className="flex-1 rounded-lg border border-emerald-600/45 bg-emerald-950/25 py-2.5 font-mono text-xs text-emerald-200 hover:bg-emerald-900/20 disabled:opacity-50"
                >
                  Return to stock
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resolve("mark_missing")}
                  className="flex-1 rounded-lg border border-red-600/45 bg-red-950/25 py-2.5 font-mono text-xs text-red-200 hover:bg-red-900/20 disabled:opacity-50"
                >
                  Mark as missing
                </button>
              </div>
              <p className="mt-3 font-mono text-[0.55rem] leading-relaxed text-[var(--wms-muted)]">
                Return to stock closes the alarm without changing item rows. Mark as missing sets
                matching tags to UNKNOWN and merges resolution into this audit row.
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
