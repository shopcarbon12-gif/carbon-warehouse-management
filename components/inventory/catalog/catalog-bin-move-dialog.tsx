"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { ArrowRight, Search, X } from "lucide-react";

/**
 * Move popover wired from the Catalog tab.
 *
 * Source = "any" — sweeps every in-stock EPC sharing this row's
 * (UPC, color) group, across all sizes, regardless of current bin
 * (or homeless). Target is picked from the active-location bin list.
 */

type ShelfMapBin = {
  id: string;
  code: string;
  status: string;
  lines: { sku_prefix: string; name: string; color: string | null; qty: number }[];
};
type SectionPayload = { aisle: string; section: string; bins: ShelfMapBin[] };
type NavPayload = {
  location: { id: string; code: string; name: string } | null;
  navigation: { aisle: string; section: string; bin_count: number }[];
};

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

export function CatalogBinMoveDialog({
  skuPrefix,
  name,
  color,
  onClose,
  onDone,
}: {
  skuPrefix: string;
  name: string;
  color: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { data: nav } = useSWR<NavPayload>("/api/overview/locations/sections", fetcher, {
    revalidateOnFocus: false,
  });

  // We'll pull all bins for the location by fetching every section.
  // The nav payload already enumerates (aisle, section), so we hit them
  // in parallel and flatten. For a typical warehouse this is < 10 calls.
  const sectionKeys = useMemo(() => {
    if (!nav?.navigation) return [] as string[];
    return nav.navigation.map(
      (n) =>
        `/api/overview/locations/sections?aisle=${encodeURIComponent(n.aisle)}&section=${encodeURIComponent(n.section)}`,
    );
  }, [nav]);

  const [bins, setBins] = useState<ShelfMapBin[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (sectionKeys.length === 0) {
      setBins([]);
      return;
    }
    void Promise.all(sectionKeys.map((k) => fetcher(k) as Promise<SectionPayload>))
      .then((results) => {
        if (cancelled) return;
        const all = results.flatMap((r) => r.bins);
        // Dedupe by id — defensive (sections can't actually share bins).
        const map = new Map<string, ShelfMapBin>();
        for (const b of all) map.set(b.id, b);
        setBins([...map.values()].filter((b) => b.status !== "inactive"));
      })
      .catch(() => {
        if (cancelled) return;
        setBins([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sectionKeys]);

  const [target, setTarget] = useState<ShelfMapBin | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
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
  }, [onClose]);

  const candidates = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return bins
      .filter((b) => !needle || b.code.toUpperCase().includes(needle))
      .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }))
      .slice(0, 100);
  }, [bins, q]);

  const submit = async () => {
    if (!target) {
      setErr("Pick a target bin first");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/locations/bins/move", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skuPrefix,
          sourceBinId: "any",
          targetBinId: target.id,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; moved?: number };
      if (!res.ok) throw new Error(j.error ?? "Move failed");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Move failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[60] bg-black/70"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div className="flex max-h-[min(90vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
          <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-3">
            <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Move SKU to bin</h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
            <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-3 font-mono text-xs">
              <p>
                <span className="text-[var(--wms-accent)]">{skuPrefix}</span>
                <span className="text-[var(--wms-muted)]"> · </span>
                <span className="text-[var(--wms-fg)]">{name}</span>
                <span className="text-[var(--wms-muted)]"> · </span>
                <span className="text-[var(--wms-warn)]">{color ?? "—"}</span>
              </p>
              <p className="mt-1 text-[var(--wms-muted)]">
                Source: <span className="text-[var(--wms-fg)]">any current bin or homeless</span>
                <ArrowRight className="mx-1 inline h-3 w-3" /> target
                <span className="ml-2 text-[var(--wms-muted)]">— sweeps every size in this color.</span>
              </p>
            </div>

            <label className="flex items-center gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 focus-within:border-[var(--wms-accent)]/60">
              <Search className="h-4 w-4 shrink-0 text-[var(--wms-muted)]" strokeWidth={2} />
              <input
                type="text"
                autoFocus
                autoComplete="off"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Type to filter bins (e.g. 1A03)"
                className="flex-1 bg-transparent font-mono text-sm text-[var(--wms-fg)] outline-none placeholder:text-[var(--wms-muted)]/70"
              />
            </label>

            <div className="max-h-64 overflow-y-auto rounded-md border border-[var(--wms-border)]">
              {candidates.length === 0 ? (
                <p className="px-3 py-4 text-center font-mono text-xs text-[var(--wms-muted)]">
                  {bins.length === 0 ? "Loading bins…" : `No active bins match "${q}".`}
                </p>
              ) : (
                <ul className="divide-y divide-[var(--wms-border)]/60">
                  {candidates.map((b) => (
                    <li key={b.id}>
                      <button
                        type="button"
                        onClick={() => setTarget(b)}
                        className={`w-full px-3 py-2 text-left font-mono text-xs hover:bg-[var(--wms-surface-elevated)] ${
                          target?.id === b.id
                            ? "bg-[color-mix(in_srgb,var(--wms-accent)_15%,var(--wms-surface-elevated))]"
                            : ""
                        }`}
                      >
                        <span className="text-[var(--wms-accent)]">{b.code}</span>
                        <span className="ml-2 text-[var(--wms-muted)]">
                          {b.lines.length} line{b.lines.length === 1 ? "" : "s"} ·{" "}
                          {b.lines.reduce((s, l) => s + l.qty, 0)} EPC
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {err ? <p className="font-mono text-xs text-red-400">{err}</p> : null}
          </div>

          <div className="flex justify-end gap-2 border-t border-[var(--wms-border)] px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !target}
              className="wms-btn-accent-soft rounded-md px-3 py-2 font-mono text-xs disabled:opacity-50"
            >
              {busy ? "Moving…" : `Move to ${target?.code ?? "…"}`}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
