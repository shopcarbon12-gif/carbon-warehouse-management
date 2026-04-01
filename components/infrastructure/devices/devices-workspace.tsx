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
          className="flex flex-wrap gap-1.5 border-b border-[var(--wms-border)] pb-2"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "all"}
            onClick={() => setTab("all")}
            className={`rounded-t-md px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide ${
              tab === "all"
                ? "border border-b-0 border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] font-semibold text-[var(--wms-accent)] dark:bg-[var(--wms-surface-elevated)] dark:text-[var(--wms-accent)]"
                : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
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
                  ? "border border-b-0 border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] font-semibold text-[var(--wms-accent)] dark:bg-[var(--wms-surface-elevated)] dark:text-[var(--wms-accent)]"
                  : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
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
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-4 py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90"
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

      <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
        <table className="w-full min-w-[960px] border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono uppercase tracking-wide">
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">IP / MAC</th>
              <th className="px-3 py-2">Location</th>
              <th className="px-3 py-2">Bin</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 w-24"> </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-[var(--wms-fg)]">
            {filtered.length === 0 && !error ? (
              <tr>
                <td colSpan={7} className="px-6 py-16 text-center">
                  <Cpu className="mx-auto h-10 w-10 text-[var(--wms-secondary)]" strokeWidth={1.25} />
                  <p className="mt-3 font-mono text-sm text-[var(--wms-muted)]">
                    No devices registered in this category.
                  </p>
                  <p className="mx-auto mt-2 max-w-md font-mono text-[0.65rem] leading-relaxed text-[var(--wms-muted)]">
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
                    className="mt-6 rounded-lg border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-5 py-2.5 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90"
                  >
                    Register a device
                  </button>
                </td>
              </tr>
            ) : (
              filtered.map((d) => (
                <tr key={d.id} className="hover:bg-[var(--wms-surface-elevated)]/50">
                  <td className="px-3 py-2 text-[var(--wms-fg)]">{d.name}</td>
                  <td className="px-3 py-2 text-[var(--wms-muted)]">{d.device_type.replace(/_/g, " ")}</td>
                  <td className="max-w-[200px] truncate px-3 py-2 text-[var(--wms-muted)]" title={d.network_address ?? ""}>
                    {d.network_address ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-teal-400/85">
                    {d.location_code} · {d.location_name}
                  </td>
                  <td className="px-3 py-2 text-[var(--wms-muted)]">{d.bin_code ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        d.status_online ? "wms-status-success" : "text-[var(--wms-muted)] line-through decoration-[var(--wms-muted)]"
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
                        className="rounded border border-[var(--wms-border)] px-2 py-1 text-[0.6rem] text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
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
