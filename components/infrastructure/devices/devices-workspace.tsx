"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Cpu, Plus, Trash2 } from "lucide-react";
import type { DeviceGridRow } from "@/lib/server/infrastructure-devices";
import {
  DEVICE_TYPES,
  DEVICE_TYPE_LABELS,
  type DeviceType,
} from "@/lib/constants/device-registry";
import { DeviceEditorModal } from "./device-editor-modal";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

type FilterTab = "all" | DeviceType;

function typeLabel(t: DeviceType): string {
  return DEVICE_TYPE_LABELS[t] ?? t;
}

export function DevicesWorkspace() {
  const { data, error, mutate } = useSWR<{ devices: DeviceGridRow[] }>(
    "/api/infrastructure/devices",
    fetcher,
    { revalidateOnFocus: false },
  );

  const devices = data?.devices ?? [];
  const [tab, setTab] = useState<FilterTab>("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DeviceGridRow | null>(null);

  const filtered = useMemo(() => {
    if (tab === "all") return devices;
    return devices.filter((d) => d.device_type === tab);
  }, [devices, tab]);

  const remove = async (d: DeviceGridRow) => {
    if (!window.confirm(`Remove “${d.name}” from the registry?`)) return;
    try {
      const res = await fetch(`/api/infrastructure/devices/${encodeURIComponent(d.id)}`, {
        method: "DELETE",
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Delete failed");
      await mutate();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Delete failed");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Device categories"
          className="flex flex-wrap gap-1.5 border-b border-slate-800 pb-2"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "all"}
            onClick={() => setTab("all")}
            className={`rounded-t-md px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide ${
              tab === "all"
                ? "border border-b-0 border-slate-700 bg-zinc-900 text-teal-300/90"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            All
          </button>
          {DEVICE_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-t-md px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide ${
                tab === t
                  ? "border border-b-0 border-slate-700 bg-zinc-900 text-teal-300/90"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {typeLabel(t)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setModalOpen(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-violet-600/45 bg-violet-950/25 px-4 py-2 font-mono text-xs text-violet-200 hover:bg-violet-900/25"
        >
          <Plus className="h-3.5 w-3.5" />
          Add device
        </button>
      </div>

      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Failed to load devices"}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full min-w-[960px] border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-slate-800 bg-zinc-900 font-mono text-[0.6rem] uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">IP / MAC</th>
              <th className="px-3 py-2">Location</th>
              <th className="px-3 py-2">Bin</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 w-24"> </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80 font-mono text-[0.65rem] text-slate-300">
            {filtered.length === 0 && !error ? (
              <tr>
                <td colSpan={7} className="px-6 py-16 text-center">
                  <Cpu className="mx-auto h-10 w-10 text-slate-700" strokeWidth={1.25} />
                  <p className="mt-3 font-mono text-sm text-slate-500">
                    No devices registered in this category.
                  </p>
                  <p className="mx-auto mt-2 max-w-md font-mono text-[0.65rem] leading-relaxed text-slate-600">
                    Add your first Zebra printer or Carbon edge reader. Locations come from the
                    warehouse map — assign each device so scan events can be attributed to a site
                    (and optionally a bin).
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(null);
                      setModalOpen(true);
                    }}
                    className="mt-6 rounded-lg border border-teal-600/45 bg-teal-950/25 px-5 py-2.5 font-mono text-xs text-teal-200 hover:bg-teal-900/25"
                  >
                    Register a device
                  </button>
                </td>
              </tr>
            ) : (
              filtered.map((d) => (
                <tr key={d.id} className="hover:bg-zinc-900/40">
                  <td className="px-3 py-2 text-slate-200">{d.name}</td>
                  <td className="px-3 py-2 text-slate-500">{d.device_type.replace(/_/g, " ")}</td>
                  <td className="max-w-[200px] truncate px-3 py-2 text-slate-400" title={d.network_address ?? ""}>
                    {d.network_address ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-teal-400/85">
                    {d.location_code} · {d.location_name}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{d.bin_code ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        d.status_online ? "text-emerald-400/90" : "text-slate-500 line-through decoration-slate-600"
                      }
                    >
                      {d.status_online ? "Online" : "Offline"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(d);
                          setModalOpen(true);
                        }}
                        className="rounded border border-slate-700 px-2 py-1 text-[0.6rem] text-slate-300 hover:bg-zinc-800"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(d)}
                        className="rounded border border-red-900/40 p-1.5 text-red-400/90 hover:bg-red-950/30"
                        aria-label="Remove device"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <DeviceEditorModal
        open={modalOpen}
        editing={editing}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        onSaved={() => void mutate()}
      />
    </div>
  );
}
