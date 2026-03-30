"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import type { StatusLabelRow } from "@/lib/queries/status-labels";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json() as Promise<StatusLabelRow[]>;
};

type BoolKey =
  | "includeInInventory"
  | "hideInSearchFilters"
  | "hideInItemDetails"
  | "displayInGroupPage";

function Toggle({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-10 shrink-0 rounded-full border transition-colors ${
        checked
          ? "border-teal-500/60 bg-teal-600/35"
          : "border-slate-600 bg-slate-800/80"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-slate-500"}`}
    >
      <span
        className={`pointer-events-none absolute top-0.5 h-5 w-5 rounded-full bg-slate-100 shadow transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function StatusLabelsWorkspace() {
  const { data, error, isLoading, mutate } = useSWR<StatusLabelRow[]>(
    "/api/settings/status-labels",
    fetcher,
    { revalidateOnFocus: false },
  );
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const patchBool = useCallback(
    async (id: number, field: BoolKey, value: boolean) => {
      const key = `${id}:${field}`;
      setPending((p) => ({ ...p, [key]: true }));
      try {
        const body: Record<string, unknown> = { id, [field]: value };
        const res = await fetch("/api/settings/status-labels", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? res.statusText);
        }
        await mutate();
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[key];
          return next;
        });
      }
    },
    [mutate],
  );

  if (error) {
    return (
      <p className="font-mono text-sm text-red-400/90">
        {error instanceof Error ? error.message : "Failed to load status labels"}
      </p>
    );
  }

  if (isLoading || !data) {
    return <p className="font-mono text-xs text-slate-500">Loading…</p>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800 bg-zinc-950/60">
      <table className="w-full min-w-[920px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-800 bg-zinc-900/80 font-mono text-[0.6rem] uppercase tracking-wide text-slate-500">
            <th className="px-3 py-3">Name</th>
            <th className="px-3 py-3 text-center">Include in inventory</th>
            <th className="px-3 py-3 text-center">Hide in search filters</th>
            <th className="px-3 py-3 text-center">Hide in item details</th>
            <th className="px-3 py-3 text-center">Display in group page</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/90">
          {data.map((row) => (
            <tr key={row.id} className="text-slate-200 hover:bg-zinc-900/40">
              <td className="px-3 py-2.5 font-medium text-slate-100">{row.name}</td>
              <td className="px-3 py-2.5 text-center">
                <Toggle
                  checked={row.include_in_inventory}
                  disabled={!!pending[`${row.id}:includeInInventory`]}
                  ariaLabel={`Include ${row.name} in inventory`}
                  onChange={(v) => void patchBool(row.id, "includeInInventory", v)}
                />
              </td>
              <td className="px-3 py-2.5 text-center">
                <Toggle
                  checked={row.hide_in_search_filters}
                  disabled={!!pending[`${row.id}:hideInSearchFilters`]}
                  ariaLabel={`Hide ${row.name} in search filters`}
                  onChange={(v) => void patchBool(row.id, "hideInSearchFilters", v)}
                />
              </td>
              <td className="px-3 py-2.5 text-center">
                <Toggle
                  checked={row.hide_in_item_details}
                  disabled={!!pending[`${row.id}:hideInItemDetails`]}
                  ariaLabel={`Hide ${row.name} in item details`}
                  onChange={(v) => void patchBool(row.id, "hideInItemDetails", v)}
                />
              </td>
              <td className="px-3 py-2.5 text-center">
                <Toggle
                  checked={row.display_in_group_page}
                  disabled={!!pending[`${row.id}:displayInGroupPage`]}
                  ariaLabel={`Display ${row.name} on group page`}
                  onChange={(v) => void patchBool(row.id, "displayInGroupPage", v)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
