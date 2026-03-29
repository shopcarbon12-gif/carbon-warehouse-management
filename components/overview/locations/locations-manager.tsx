"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { MapPin, PackagePlus, Pencil } from "lucide-react";
import { BinEditorDrawer, type BinRow } from "./bin-editor-drawer";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
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

export function LocationsManager() {
  const { data, error, mutate } = useSWR<{ locations: Loc[] }>(
    "/api/overview/locations",
    fetcher,
    { revalidateOnFocus: false },
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

  return (
    <div className="space-y-4">
      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Failed to load locations"}
        </p>
      ) : null}

      <div className="grid min-h-[420px] gap-4 lg:grid-cols-[minmax(220px,280px)_1fr]">
        {/* Left: locations */}
        <div className="rounded-lg border border-slate-800 bg-zinc-950/80 lg:min-h-0 lg:overflow-hidden lg:flex lg:flex-col">
          <div className="border-b border-slate-800 px-3 py-2 font-mono text-[0.65rem] uppercase tracking-wide text-slate-500">
            Locations
          </div>
          {locations.length === 0 && !error ? (
            <div className="flex flex-1 flex-col items-center justify-center px-4 py-12 text-center">
              <MapPin className="h-9 w-9 text-slate-700" strokeWidth={1.25} />
              <p className="mt-3 font-mono text-sm text-slate-500">No locations configured.</p>
              <p className="mt-1 font-mono text-[0.65rem] text-slate-600">
                Run <code className="text-slate-500">npm run db:seed</code> to bootstrap sites.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-800/80 overflow-y-auto lg:flex-1">
              {locations.map((l) => {
                const active = l.id === selectedId;
                return (
                  <li key={l.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(l.id)}
                      className={`w-full px-3 py-3 text-left font-mono text-sm transition-colors ${
                        active
                          ? "bg-slate-800/80 text-teal-200 ring-1 ring-inset ring-teal-700/40"
                          : "text-slate-200 hover:bg-zinc-900/60"
                      }`}
                    >
                      <span className="text-teal-400/90">{l.code}</span>
                      <span className="text-slate-600"> — </span>
                      <span className="text-slate-200">{l.name}</span>
                      <span className="mt-0.5 block text-[0.6rem] text-slate-500">
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
        <div className="flex min-h-0 flex-col rounded-lg border border-slate-800 bg-zinc-950/80">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Bins</h3>
              {selected ? (
                <p className="font-mono text-[0.6rem] text-slate-500">
                  {selected.code} · {selected.name}
                </p>
              ) : (
                <p className="font-mono text-[0.6rem] text-slate-600">Select a location</p>
              )}
            </div>
            <button
              type="button"
              disabled={!selected}
              onClick={openAdd}
              className="inline-flex items-center gap-1.5 rounded-md border border-teal-600/45 bg-teal-950/25 px-3 py-2 font-mono text-xs text-teal-200 hover:bg-teal-900/25 disabled:opacity-40"
            >
              <PackagePlus className="h-3.5 w-3.5" />
              Add new bin
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
            {!selected ? (
              <div className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
                <p className="font-mono text-sm text-slate-500">Select a location on the left.</p>
              </div>
            ) : selected.bins.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                <p className="font-mono text-sm text-slate-500">No bins at this site yet.</p>
                <p className="mt-2 max-w-sm font-mono text-[0.65rem] text-slate-600">
                  Use <strong className="text-slate-500">Add new bin</strong> to create receiving or
                  floor positions. Archive is blocked while in-stock EPCs reference a bin.
                </p>
              </div>
            ) : (
              <table className="w-full min-w-[640px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-zinc-900 font-mono text-[0.6rem] uppercase text-slate-500">
                    <th className="px-3 py-2">Identifier</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right tabular-nums">Capacity</th>
                    <th className="px-3 py-2 text-right tabular-nums">In-stock EPCs</th>
                    <th className="px-3 py-2 w-28"> </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80 font-mono text-[0.65rem] text-slate-300">
                  {selected.bins.map((b) => (
                    <tr key={b.id} className="hover:bg-zinc-900/40">
                      <td className="px-3 py-2 text-slate-200">{b.code}</td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            b.status === "inactive"
                              ? "text-amber-400/90"
                              : "text-emerald-400/85"
                          }
                        >
                          {b.status === "inactive" ? "inactive" : "active"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                        {b.capacity != null ? b.capacity : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                        {b.in_stock_count}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => openEdit(b)}
                          className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[0.6rem] text-slate-300 hover:bg-zinc-800"
                        >
                          <Pencil className="h-3 w-3" />
                          Edit
                        </button>
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
