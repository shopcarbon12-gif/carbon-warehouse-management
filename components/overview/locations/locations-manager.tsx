"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { MapPin, PackagePlus, Pencil, Trash2 } from "lucide-react";
import { BinEditorDrawer, type BinRow } from "./bin-editor-drawer";

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
    const parts = [j.error, j.hint].filter((x): x is string => Boolean(x?.trim()));
    throw new Error(parts.length ? parts.join(" — ") : res.statusText);
  }
  return res.json();
};

type Loc = {
  id: string;
  code: string;
  name: string;
  bins: BinRow[];
};

type DrawerMode = "add" | "edit";

/** Server-fetched seed (RSC) so locations/bins render without relying on a second client round-trip. */
export type InitialOverviewLocations = Loc[];

export function LocationsManager({
  canCleanBins = false,
  initialLocations,
}: {
  canCleanBins?: boolean;
  initialLocations?: InitialOverviewLocations;
}) {
  const { data, error, mutate } = useSWR<{ locations: Loc[] }>(
    "/api/overview/locations",
    fetcher,
    {
      revalidateOnFocus: false,
      fallbackData:
        initialLocations !== undefined ? { locations: initialLocations } : undefined,
    },
  );

  const locations = data?.locations ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<DrawerMode | null>(null);
  const [drawerBin, setDrawerBin] = useState<BinRow | null>(null);

  useEffect(() => {
    if (locations.length === 0) return;
    setSelectedId((cur) => {
      if (cur && locations.some((l) => l.id === cur)) return cur;
      return locations[0]!.id;
    });
  }, [locations]);

  const selected = useMemo(
    () => locations.find((l) => l.id === selectedId) ?? null,
    [locations, selectedId],
  );

  const openAdd = () => {
    if (!selected) return;
    setDrawerMode("add");
    setDrawerBin(null);
    setDrawerOpen(true);
  };

  const openEdit = (b: BinRow) => {
    setDrawerMode("edit");
    setDrawerBin(b);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setDrawerMode(null);
    setDrawerBin(null);
  };

  const [cleanBusy, setCleanBusy] = useState<string | null>(null);
  const [cleanNotice, setCleanNotice] = useState<string | null>(null);

  const cleanBin = async (binId: string) => {
    if (!canCleanBins) return;
    if (!window.confirm("Unassign all in-stock EPCs from this bin? This is logged as clean_bin.")) return;
    setCleanBusy(binId);
    setCleanNotice(null);
    try {
      const res = await fetch(`/api/locations/bins/${binId}/clean`, {
        method: "POST",
        credentials: "same-origin",
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; cleared?: number };
      if (!res.ok) throw new Error(j.error ?? "Clean failed");
      await mutate();
      setCleanNotice(`Cleared ${j.cleared ?? 0} EPC(s) from bin.`);
    } catch (e) {
      setCleanNotice(e instanceof Error ? e.message : "Clean failed");
    } finally {
      setCleanBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {cleanNotice ? (
        <p className="font-mono text-xs text-[var(--wms-muted)]" role="status">
          {cleanNotice}
        </p>
      ) : null}
      {error ? (
        <p className="font-mono text-sm text-red-600 dark:text-red-400/90">
          {error instanceof Error ? error.message : "Failed to load locations"}
        </p>
      ) : null}

      <div className="grid min-h-[420px] gap-4 lg:grid-cols-[minmax(220px,280px)_1fr]">
        {/* Left: locations */}
        <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 lg:min-h-0 lg:overflow-hidden lg:flex lg:flex-col">
          <div className="border-b border-[var(--wms-border)] px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-fg)]">
            Locations
          </div>
          {locations.length === 0 && !error ? (
            <div className="flex flex-1 flex-col items-center justify-center px-4 py-12 text-center">
              <MapPin className="h-9 w-9 text-[var(--wms-secondary)]" strokeWidth={1.25} />
              <p className="mt-3 font-mono text-sm text-[var(--wms-muted)]">No locations configured.</p>
              <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
                Run <code className="text-[var(--wms-fg)]">npm run db:seed</code> to bootstrap sites.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[var(--wms-border)]/80 overflow-y-auto lg:flex-1">
              {locations.map((l) => {
                const active = l.id === selectedId;
                return (
                  <li key={l.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(l.id)}
                      className={`w-full px-3 py-3 text-left font-mono text-base transition-colors ${
                        active
                          ? "wms-loc-row-active"
                          : "text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]/80"
                      }`}
                    >
                      <span className="font-semibold text-[var(--wms-accent)]">{l.code}</span>
                      <span className="text-[var(--wms-muted)]"> — </span>
                      <span className="text-[var(--wms-fg)]">{l.name}</span>
                      <span className="mt-0.5 block text-xs text-[var(--wms-muted)]">
                        {l.bins.length} bin{l.bins.length === 1 ? "" : "s"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Right: bins for selected location */}
        <div className="flex min-h-0 flex-col rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--wms-border)] px-4 py-3">
            <div>
              <h3 className="text-base font-semibold text-[var(--wms-fg)]">Bins</h3>
              {selected ? (
                <p className="font-mono text-xs text-[var(--wms-muted)]">
                  {selected.code} · {selected.name}
                </p>
              ) : (
                <p className="font-mono text-xs text-[var(--wms-muted)]">Select a location</p>
              )}
            </div>
            <button
              type="button"
              disabled={!selected}
              onClick={openAdd}
              className="wms-btn-accent-soft inline-flex items-center gap-1.5 rounded-md px-3 py-2 font-mono text-sm disabled:opacity-40"
            >
              <PackagePlus className="h-4 w-4 shrink-0" strokeWidth={2} />
              Add new bin
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
            {!selected ? (
              <div className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
                <p className="font-mono text-sm text-[var(--wms-muted)]">Select a location on the left.</p>
              </div>
            ) : selected.bins.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                <p className="font-mono text-sm text-[var(--wms-muted)]">No bins at this site yet.</p>
                <p className="mt-2 max-w-sm font-mono text-xs text-[var(--wms-muted)]">
                  Use <strong className="text-[var(--wms-fg)]">Add new bin</strong> to create receiving or
                  floor positions. Archive is blocked while in-stock EPCs reference a bin.
                </p>
              </div>
            ) : (
              <table className="w-full min-w-[640px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono uppercase tracking-wide">
                    <th className="px-3 py-2">Identifier</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right tabular-nums">Capacity</th>
                    <th className="px-3 py-2 text-right tabular-nums">In-stock EPCs</th>
                    <th className="px-3 py-2 w-36"> </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-[var(--wms-fg)]">
                  {selected.bins.map((b) => (
                    <tr key={b.id} className="hover:bg-[var(--wms-surface-elevated)]/50">
                      <td className="px-3 py-2 text-[var(--wms-fg)]">{b.code}</td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            b.status === "inactive" ? "wms-status-warning" : "wms-status-success"
                          }
                        >
                          {b.status === "inactive" ? "inactive" : "active"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-[var(--wms-muted)]">
                        {b.capacity != null ? b.capacity : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-[var(--wms-muted)]">
                        {b.in_stock_count}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {canCleanBins ? (
                            <button
                              type="button"
                              title="Clean bin — unassign all items"
                              disabled={cleanBusy === b.id || (b.in_stock_count ?? 0) === 0}
                              onClick={() => void cleanBin(b.id)}
                              className="wms-table-btn-clean inline-flex items-center gap-1 rounded px-2 py-1 text-xs disabled:opacity-40"
                            >
                              <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                              Clean
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => openEdit(b)}
                            className="wms-table-row-action inline-flex items-center gap-1 rounded px-2 py-1 text-xs"
                          >
                            <Pencil className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                            Edit
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <BinEditorDrawer
        open={drawerOpen}
        mode={drawerMode}
        editingBin={drawerBin}
        locationId={selected?.id ?? ""}
        locationLabel={selected ? `${selected.code} · ${selected.name}` : ""}
        onClose={closeDrawer}
        onSaved={() => void mutate()}
      />
    </div>
  );
}
