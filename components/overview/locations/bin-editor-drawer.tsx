"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";

export type BinRow = {
  id: string;
  code: string;
  capacity: number | null;
  in_stock_count: number;
  status: string;
  bin_items: string | null;
};

type DrawerMode = "add" | "edit";

type Props = {
  open: boolean;
  mode: DrawerMode | null;
  editingBin: BinRow | null;
  locationId: string;
  locationLabel: string;
  /** Pre-filled bin code for add mode (used by the Shelf Map "+ Add 1A05R" link). */
  presetCode?: string;
  onClose: () => void;
  onSaved: () => void;
};

export function BinEditorDrawer({
  open,
  mode,
  editingBin,
  locationId,
  locationLabel,
  presetCode,
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
      // Shelf Map "+ Add 1A05R" link → pre-fill so the operator just confirms.
      if (presetCode) setCode(presetCode);
      return;
    }
    if (editingBin) {
      setCode(editingBin.code);
      setCapacity(editingBin.capacity != null ? String(editingBin.capacity) : "");
      setStatus(editingBin.status === "inactive" ? "inactive" : "active");
      setErr(null);
    }
  }, [open, mode, editingBin, presetCode, resetForm]);

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

  const deleteBin = async () => {
    if (!editingBin) return;
    const stockCount = editingBin.in_stock_count;
    const msg = stockCount > 0
      ? `Delete bin "${editingBin.code}"? ${stockCount} in-stock EPC${stockCount === 1 ? "" : "s"} will be unassigned (bin_id → null) and stay live at this location.`
      : `Delete bin "${editingBin.code}"?`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/locations/bins/${encodeURIComponent(editingBin.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const j = (await res.json()) as { error?: string; orphaned?: number };
      if (!res.ok) throw new Error(j.error ?? "Delete failed");
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
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
            <h2 className="text-base font-semibold text-[var(--wms-fg)]">
              {mode === "add" ? "Add bin" : "Edit bin"}
            </h2>
            <p className="font-mono text-xs text-[var(--wms-muted)]">{locationLabel}</p>
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            className="rounded p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] max-md:-my-1.5 max-md:inline-flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 max-md:overscroll-contain">
          <div className="space-y-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/30 p-4">
            <label className="block font-mono text-xs font-medium uppercase tracking-wide text-[var(--wms-fg)]">
              Bin name / identifier
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base"
              />
            </label>
            <label className="block font-mono text-xs font-medium uppercase tracking-wide text-[var(--wms-fg)]">
              Capacity limit (optional)
              <input
                type="number"
                inputMode="numeric"
                min={0}
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base"
              />
            </label>
            <label className="block font-mono text-xs font-medium uppercase tracking-wide text-[var(--wms-fg)]">
              Status
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as "active" | "inactive")}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>

            {mode === "edit" && editingBin ? (
              <p className="font-mono text-xs text-[var(--wms-muted)]">
                In-stock EPCs at this site:{" "}
                <span className="text-[var(--wms-muted)]">{editingBin.in_stock_count}</span>
              </p>
            ) : null}

            {err ? (
              <p className="font-mono text-sm text-red-600 dark:text-red-400/90">{err}</p>
            ) : null}

            <button
              type="button"
              disabled={busy}
              onClick={() => void saveBin()}
              className="wms-btn-primary w-full font-mono max-md:min-h-11"
            >
              Save bin
            </button>

            {mode === "edit" && editingBin ? (
              <button
                type="button"
                disabled={busy}
                title={
                  editingBin.in_stock_count > 0
                    ? `Will unassign ${editingBin.in_stock_count} in-stock EPC${editingBin.in_stock_count === 1 ? "" : "s"} (bin_id → null) before deleting.`
                    : undefined
                }
                onClick={() => void deleteBin()}
                className="wms-btn-danger w-full font-mono max-md:min-h-11"
              >
                Delete bin
              </button>
            ) : null}
          </div>
        </div>
      </aside>
    </>
  );
}
