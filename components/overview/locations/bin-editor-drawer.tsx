"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";

export type BinRow = {
  id: string;
  code: string;
  capacity: number | null;
  in_stock_count: number;
  status: string;
};

type DrawerMode = "add" | "edit";

type Props = {
  open: boolean;
  mode: DrawerMode | null;
  editingBin: BinRow | null;
  locationId: string;
  locationLabel: string;
  onClose: () => void;
  onSaved: () => void;
};

export function BinEditorDrawer({
  open,
  mode,
  editingBin,
  locationId,
  locationLabel,
  onClose,
  onSaved,
}: Props) {
  const [code, setCode] = useState("");
  const [capacity, setCapacity] = useState("");
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setCode("");
    setCapacity("");
    setStatus("active");
    setErr(null);
  }, []);

  useEffect(() => {
    if (!open || !mode) return;
    if (mode === "add") {
      resetForm();
      return;
    }
    if (editingBin) {
      setCode(editingBin.code);
      setCapacity(editingBin.capacity != null ? String(editingBin.capacity) : "");
      setStatus(editingBin.status === "inactive" ? "inactive" : "active");
      setErr(null);
    }
  }, [open, mode, editingBin, resetForm]);

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

  const saveBin = async () => {
    const c = code.trim();
    if (!c) {
      setErr("Bin name / identifier is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const cap = capacity.trim() === "" ? null : Number.parseInt(capacity, 10);
      const body: Record<string, unknown> = {
        locationId,
        code: c,
        capacity: Number.isFinite(cap) ? cap : null,
        status,
      };
      if (mode === "edit" && editingBin) body.binId = editingBin.id;

      const res = await fetch("/api/locations/bins", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      resetForm();
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const archiveBin = async () => {
    if (!editingBin) return;
    if (editingBin.in_stock_count > 0) {
      setErr("Cannot archive: this bin has in-stock EPCs.");
      return;
    }
    if (!window.confirm(`Archive bin “${editingBin.code}”?`)) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/locations/bins/${encodeURIComponent(editingBin.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Archive failed");
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Archive failed");
    } finally {
      setBusy(false);
    }
  };

  if (!open || !mode) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Close drawer"
        className="fixed inset-0 z-[75] bg-black/60"
        onClick={() => !busy && onClose()}
      />
      <aside className="fixed inset-y-0 right-0 z-[80] flex w-full max-w-md flex-col border-l border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--wms-fg)]">
              {mode === "add" ? "Add bin" : "Edit bin"}
            </h2>
            <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]">{locationLabel}</p>
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            className="rounded p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="space-y-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/30 p-4">
            <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
              Bin name / identifier
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
              />
            </label>
            <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
              Capacity limit (optional)
              <input
                type="number"
                min={0}
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
              />
            </label>
            <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
              Status
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as "active" | "inactive")}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>

            {mode === "edit" && editingBin ? (
              <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
                In-stock EPCs at this site:{" "}
                <span className="text-[var(--wms-muted)]">{editingBin.in_stock_count}</span>
              </p>
            ) : null}

            {err ? <p className="font-mono text-xs text-red-400/90">{err}</p> : null}

            <button
              type="button"
              disabled={busy}
              onClick={() => void saveBin()}
              className="w-full rounded border border-teal-600/45 bg-teal-950/25 py-2.5 font-mono text-xs font-medium text-teal-200 hover:bg-teal-900/25 disabled:opacity-50"
            >
              Save bin
            </button>

            {mode === "edit" && editingBin ? (
              <button
                type="button"
                disabled={busy || editingBin.in_stock_count > 0}
                title={
                  editingBin.in_stock_count > 0
                    ? "Move in-stock EPCs before archiving"
                    : undefined
                }
                onClick={() => void archiveBin()}
                className="w-full rounded border border-red-900/50 bg-red-950/20 py-2.5 font-mono text-xs font-medium text-red-300/90 hover:bg-red-950/35 disabled:opacity-30"
              >
                Archive bin
              </button>
            ) : null}
          </div>
        </div>
      </aside>
    </>
  );
}
