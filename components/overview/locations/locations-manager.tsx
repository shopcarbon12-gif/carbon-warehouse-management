"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { MapPin, PackagePlus, Pencil, Trash2, X } from "lucide-react";
import { BinEditorDrawer, type BinRow } from "./bin-editor-drawer";

type BinEpcRow = {
  epc: string;
  serial_number: string;
  sku: string;
  upc: string | null;
  description: string;
};

type BinContentLine = {
  custom_sku_id: string;
  sku: string;
  description: string;
  color_code: string | null;
  size: string | null;
  qty: number;
};

type CleanGroup = { skuPrefix: string; label: string; qty: number };

/** Collapse a bin's contents into clean-groups using the same rule as the Items column. */
function collapseForClean(rows: BinContentLine[]): CleanGroup[] {
  const map = new Map<string, CleanGroup>();
  for (const r of rows) {
    const sku = r.sku.toUpperCase();
    const prefixLen = sku.startsWith("C") ? 11 : 9;
    const skuPrefix = sku.slice(0, prefixLen);
    // Strip trailing size token from description (same regex as server Items column).
    const label = (r.description ?? "").replace(/\s+\S+$/, "").trim() || r.description;
    const key = skuPrefix;
    const existing = map.get(key);
    if (existing) {
      existing.qty += r.qty;
    } else {
      map.set(key, { skuPrefix, label, qty: r.qty });
    }
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

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
      revalidateOnMount: true,
      fallbackData:
        initialLocations !== undefined ? { locations: initialLocations } : undefined,
    },
  );

  const locations = data?.locations ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<DrawerMode | null>(null);
  const [drawerBin, setDrawerBin] = useState<BinRow | null>(null);
  const [epcModalBin, setEpcModalBin] = useState<BinRow | null>(null);

  const { data: epcData, isLoading: epcLoading } = useSWR<BinEpcRow[]>(
    epcModalBin ? `/api/locations/bins/${epcModalBin.id}/epcs` : null,
    fetcher,
    { revalidateOnFocus: false },
  );

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
  // Two-step clean flow state. Step 1: pick item (or "all") if bin has 2+ groups,
  // otherwise jump straight to step 2. Step 2: confirm the action.
  const [cleanBin, setCleanBin] = useState<BinRow | null>(null);
  const [cleanStep, setCleanStep] = useState<"pick" | "confirm">("pick");
  // null = "All items" (no prefix filter). Otherwise a specific group.
  const [cleanTarget, setCleanTarget] = useState<CleanGroup | null>(null);

  const { data: cleanContents } = useSWR<BinContentLine[]>(
    cleanBin ? `/api/locations/bins/contents?binId=${cleanBin.id}` : null,
    fetcher,
    { revalidateOnFocus: false },
  );
  const cleanGroups = useMemo(
    () => (cleanContents ? collapseForClean(cleanContents) : []),
    [cleanContents],
  );

  const closeCleanFlow = () => {
    setCleanBin(null);
    setCleanStep("pick");
    setCleanTarget(null);
  };

  // Clean button click → open the pick step; if single group, skip to confirm with that group.
  const onCleanClick = (b: BinRow) => {
    if (!canCleanBins) return;
    setCleanBin(b);
    setCleanStep("pick");
    setCleanTarget(null);
  };

  // Once contents load, if there's exactly one group jump to the confirm step.
  useEffect(() => {
    if (!cleanBin || cleanStep !== "pick" || cleanGroups.length === 0) return;
    if (cleanGroups.length === 1) {
      setCleanTarget(cleanGroups[0]!);
      setCleanStep("confirm");
    }
  }, [cleanBin, cleanStep, cleanGroups]);

  const runClean = async () => {
    if (!cleanBin) return;
    setCleanBusy(cleanBin.id);
    setCleanNotice(null);
    try {
      const body = cleanTarget ? { skuPrefix: cleanTarget.skuPrefix } : {};
      const res = await fetch(`/api/locations/bins/${cleanBin.id}/clean`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; cleared?: number };
      if (!res.ok) throw new Error(j.error ?? "Clean failed");
      await mutate();
      setCleanNotice(`Cleared ${j.cleared ?? 0} EPC(s) from bin.`);
      closeCleanFlow();
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
                    <th className="px-3 py-2">Items</th>
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
                      <td className="px-3 py-2 text-[var(--wms-muted)]">
                        {b.bin_items ? (() => {
                          const lines = b.bin_items.split("\n");
                          const numbered = lines.length > 1;
                          return (
                            <ul className="space-y-0.5">
                              {lines.map((line, i) => (
                                <li key={i} className="text-xs leading-snug">
                                  {numbered ? `${i + 1}. ${line}` : line}
                                </li>
                              ))}
                            </ul>
                          );
                        })() : (
                          <span className="text-xs text-[var(--wms-muted)]">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-[var(--wms-muted)]">
                        {(b.in_stock_count ?? 0) > 0 ? (
                          <button
                            type="button"
                            onClick={() => setEpcModalBin(b)}
                            className="text-[var(--wms-accent)] hover:underline"
                            title="View EPCs"
                          >
                            {b.in_stock_count}
                          </button>
                        ) : (
                          b.in_stock_count
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {canCleanBins ? (
                            <button
                              type="button"
                              title="Clean bin — unassign items"
                              disabled={cleanBusy === b.id || (b.in_stock_count ?? 0) === 0}
                              onClick={() => onCleanClick(b)}
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

      {cleanBin && cleanStep === "pick" && cleanGroups.length > 1 ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-[60] bg-black/70"
            onClick={closeCleanFlow}
          />
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
              <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-3">
                <h3 className="text-sm font-semibold text-[var(--wms-fg)]">
                  Which item to remove from bin {cleanBin.code}?
                </h3>
                <button
                  type="button"
                  onClick={closeCleanFlow}
                  className="rounded p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <ol className="px-4 py-3 font-mono text-sm text-[var(--wms-fg)]">
                {cleanGroups.map((g, i) => (
                  <li key={g.skuPrefix} className="py-1">
                    {i + 1}. {g.label}{" "}
                    <span className="text-xs text-[var(--wms-muted)]">({g.qty} EPC{g.qty === 1 ? "" : "s"})</span>
                  </li>
                ))}
              </ol>
              <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--wms-border)] px-4 py-3">
                {cleanGroups.map((g, i) => (
                  <button
                    key={g.skuPrefix}
                    type="button"
                    onClick={() => { setCleanTarget(g); setCleanStep("confirm"); }}
                    className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-border)]"
                  >
                    Item {i + 1}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => { setCleanTarget(null); setCleanStep("confirm"); }}
                  className="rounded-md border border-red-500/50 bg-red-500/20 px-3 py-2 font-mono text-xs font-semibold text-red-400 hover:bg-red-500/30"
                >
                  All
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {cleanBin && cleanStep === "confirm" ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-[60] bg-black/70"
            onClick={closeCleanFlow}
          />
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
              <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-3">
                <h3 className="text-sm font-semibold text-[var(--wms-fg)]">
                  Confirm clean
                </h3>
                <button
                  type="button"
                  onClick={closeCleanFlow}
                  className="rounded p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="px-4 py-4 font-mono text-sm text-[var(--wms-fg)]">
                {cleanTarget
                  ? `Remove ${cleanTarget.label} from bin ${cleanBin.code}?`
                  : `Remove ALL items from bin ${cleanBin.code}?`}
                <p className="mt-2 text-xs text-[var(--wms-muted)]">This is logged as clean_bin.</p>
              </div>
              <div className="flex justify-end gap-2 border-t border-[var(--wms-border)] px-4 py-3">
                <button
                  type="button"
                  disabled={cleanBusy === cleanBin.id}
                  onClick={() => {
                    // Cancel acts as back — return to pick step only if we have 2+ groups,
                    // otherwise close the whole flow (single-group bins have no pick step).
                    if (cleanGroups.length > 1) {
                      setCleanStep("pick");
                      setCleanTarget(null);
                    } else {
                      closeCleanFlow();
                    }
                  }}
                  className="rounded-md border border-[var(--wms-border)] px-4 py-2 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={cleanBusy === cleanBin.id}
                  onClick={() => void runClean()}
                  className="rounded-md border border-red-500/50 bg-red-500 px-4 py-2 font-mono text-xs font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-40"
                >
                  {cleanBusy === cleanBin.id ? "Removing…" : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {epcModalBin ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-[60] bg-black/70"
            onClick={() => setEpcModalBin(null)}
          />
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div className="flex max-h-[min(90vh,720px)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
              <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-3">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--wms-fg)]">
                    Bin {epcModalBin.code} — EPCs
                  </h3>
                  <p className="mt-0.5 font-mono text-[0.6rem] text-[var(--wms-muted)]">
                    {epcModalBin.in_stock_count} in-stock EPC{epcModalBin.in_stock_count === 1 ? "" : "s"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEpcModalBin(null)}
                  className="rounded p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {epcLoading ? (
                  <p className="px-4 py-8 font-mono text-xs text-[var(--wms-muted)]">Loading EPCs…</p>
                ) : !epcData || epcData.length === 0 ? (
                  <p className="px-4 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
                    No EPCs in this bin.
                  </p>
                ) : (
                  <table className="w-full min-w-[720px] border-collapse text-left">
                    <thead className="sticky top-0 z-10">
                      <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono uppercase tracking-wide">
                        <th className="px-3 py-2 text-xs">Custom SKU</th>
                        <th className="px-3 py-2 text-xs">UPC</th>
                        <th className="px-3 py-2 text-xs">Description</th>
                        <th className="px-3 py-2 text-xs">Serial #</th>
                        <th className="px-3 py-2 text-xs">EPC ID</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-xs text-[var(--wms-fg)]">
                      {epcData.map((r) => (
                        <tr key={r.epc} className="hover:bg-[var(--wms-surface-elevated)]/50">
                          <td className="px-3 py-1.5">{r.sku}</td>
                          <td className="px-3 py-1.5 text-[var(--wms-muted)]">{r.upc ?? "—"}</td>
                          <td className="px-3 py-1.5 text-[var(--wms-muted)]" title={r.description}>
                            {r.description}
                          </td>
                          <td className="px-3 py-1.5 tabular-nums">{r.serial_number}</td>
                          <td className="px-3 py-1.5 tabular-nums text-teal-400/85">{r.epc}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
