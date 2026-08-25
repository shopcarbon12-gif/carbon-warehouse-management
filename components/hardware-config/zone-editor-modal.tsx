"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { X } from "lucide-react";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

type LocOpt = { id: string; code: string; name: string };

type Props = {
  open: boolean;
  /** When provided, the location dropdown is pre-selected (and locked). */
  locationId?: string | null;
  onClose: () => void;
  onSaved: () => void;
};

export function ZoneEditorModal({ open, locationId, onClose, onSaved }: Props) {
  const { data: locData } = useSWR<LocOpt[]>("/api/locations", fetcher, {
    revalidateOnFocus: false,
  });
  const locations = locData ?? [];

  const [selectedLocId, setSelectedLocId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedLocId(locationId ?? locations[0]?.id ?? "");
    setName("");
    setDescription("");
    setErr(null);
  }, [open, locationId, locations]);

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

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setErr("Zone name is required");
      return;
    }
    if (!selectedLocId) {
      setErr("Location is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/zones", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          locationId: selectedLocId,
          name: trimmed,
          description: description.trim() || null,
        }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] p-5 shadow-xl max-md:max-h-[85dvh] max-md:overflow-y-auto max-md:overscroll-contain">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-mono text-sm font-semibold text-[var(--wms-fg)]">Add zone</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Location
            </label>
            <select
              value={selectedLocId}
              onChange={(e) => setSelectedLocId(e.target.value)}
              disabled={!!locationId}
              className="w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none disabled:opacity-60"
            >
              <option value="">-- select --</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  [{l.code}] {l.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Zone name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Warehouse, Store, Receiving Dock"
              maxLength={64}
              className="w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Description (optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={3}
              className="w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none"
            />
          </div>
          {err ? (
            <p className="font-mono text-[0.7rem] text-red-400/90">{err}</p>
          ) : null}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)] hover:text-[var(--wms-fg)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wide text-[var(--wms-accent-fg)] hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Saving..." : "Save zone"}
          </button>
        </div>
      </div>
    </div>
  );
}
