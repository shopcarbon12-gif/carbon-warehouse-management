"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import type { EpcProfile, TenantSettingsRow } from "@/lib/settings/tenant-settings-defaults";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json() as Promise<TenantSettingsRow>;
};

function emptyProfile(): EpcProfile {
  return {
    id: `p_${Date.now().toString(36)}`,
    name: "New profile",
    epcPrefix: "F0A0B",
    itemStartBit: 32,
    itemLength: 40,
    serialStartBit: 80,
    serialLength: 36,
    isActive: true,
  };
}

export function EpcProfilesWorkspace() {
  const { data, error, mutate, isLoading } = useSWR("/api/settings/tenant-settings", fetcher, {
    revalidateOnFocus: false,
  });

  const [modal, setModal] = useState<null | { mode: "add" } | { mode: "edit"; row: EpcProfile }>(null);
  const [busy, setBusy] = useState(false);

  const saveProfiles = useCallback(
    async (next: EpcProfile[]) => {
      setBusy(true);
      try {
        const res = await fetch("/api/settings/tenant-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ epc_profiles: next }),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(j.error ?? "Save failed");
        void mutate();
      } finally {
        setBusy(false);
      }
    },
    [mutate],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!data) return;
      if (!window.confirm("Remove this profile?")) return;
      const next = data.epc_profiles.filter((p) => p.id !== id);
      try {
        await saveProfiles(next);
      } catch (e) {
        window.alert(e instanceof Error ? e.message : "Remove failed");
      }
    },
    [data, saveProfiles],
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          disabled={busy || !data}
          onClick={() => setModal({ mode: "add" })}
          className="wms-btn-primary wms-btn-sm font-mono disabled:opacity-50"
        >
          Add profile
        </button>
      </div>

      {error ? <p className="font-mono text-xs text-red-400/90">{error.message}</p> : null}
      {isLoading || !data ? (
        <p className="font-mono text-xs text-[var(--wms-muted)]">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]/60">
          <table className="w-full min-w-[960px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/80 font-mono text-[0.6rem] uppercase text-[var(--wms-muted)]">
                <th className="px-3 py-3">Profile name</th>
                <th className="px-3 py-3">EPC prefix</th>
                <th className="px-3 py-3">Item start / len</th>
                <th className="px-3 py-3">Serial start / len</th>
                <th className="px-3 py-3">Active</th>
                <th className="px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--wms-border)]/90">
              {data.epc_profiles.map((row) => (
                <tr key={row.id} className="text-[var(--wms-fg)]">
                  <td className="px-3 py-2.5 font-medium">{row.name}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-teal-400/85">{row.epcPrefix}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">
                    {row.itemStartBit} / {row.itemLength}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs">
                    {row.serialStartBit} / {row.serialLength}
                  </td>
                  <td className="px-3 py-2.5">{row.isActive ? "Yes" : "No"}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs">
                    <button
                      type="button"
                      onClick={() => setModal({ mode: "edit", row: { ...row } })}
                      className="text-teal-400/90 hover:underline"
                    >
                      Edit
                    </button>
                    <span className="mx-2 text-[var(--wms-muted)]">|</span>
                    <button
                      type="button"
                      onClick={() => void remove(row.id)}
                      className="text-red-400/85 hover:underline"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal ? (
        <ProfileModal
          mode={modal.mode}
          initial={modal.mode === "edit" ? modal.row : emptyProfile()}
          busy={busy}
          onClose={() => setModal(null)}
          onSave={async (row) => {
            if (!data) return;
            const list = [...data.epc_profiles];
            const i = list.findIndex((p) => p.id === row.id);
            if (modal.mode === "add") list.push(row);
            else if (i >= 0) list[i] = row;
            try {
              await saveProfiles(list);
              setModal(null);
            } catch (e) {
              window.alert(e instanceof Error ? e.message : "Save failed");
            }
          }}
        />
      ) : null}
    </div>
  );
}

function ProfileModal({
  mode,
  initial,
  busy,
  onClose,
  onSave,
}: {
  mode: "add" | "edit";
  initial: EpcProfile;
  busy: boolean;
  onClose: () => void;
  onSave: (row: EpcProfile) => Promise<void>;
}) {
  const [row, setRow] = useState<EpcProfile>(initial);

  useEffect(() => {
    setRow(initial);
  }, [initial]);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-6 shadow-2xl">
        <h3 className="text-sm font-semibold text-[var(--wms-fg)]">
          {mode === "add" ? "Add EPC profile" : "Edit EPC profile"}
        </h3>
        <div className="mt-4 space-y-3 font-mono text-xs">
          <label className="block text-[var(--wms-muted)]">
            Profile ID
            <input
              value={row.id}
              onChange={(e) => setRow((r) => ({ ...r, id: e.target.value.trim() }))}
              disabled={mode === "edit"}
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)] disabled:opacity-60"
            />
          </label>
          <label className="block text-[var(--wms-muted)]">
            Profile name
            <input
              value={row.name}
              onChange={(e) => setRow((r) => ({ ...r, name: e.target.value }))}
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
            />
          </label>
          <label className="block text-[var(--wms-muted)]">
            EPC prefix (hex)
            <input
              value={row.epcPrefix}
              onChange={(e) =>
                setRow((r) => ({
                  ...r,
                  epcPrefix: e.target.value.toUpperCase().replace(/[^0-9A-F]/g, ""),
                }))
              }
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[var(--wms-muted)]">
              Item start bit
              <input
                type="number"
                value={row.itemStartBit}
                onChange={(e) => setRow((r) => ({ ...r, itemStartBit: Number(e.target.value) || 0 }))}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
              />
            </label>
            <label className="text-[var(--wms-muted)]">
              Item length
              <input
                type="number"
                value={row.itemLength}
                onChange={(e) => setRow((r) => ({ ...r, itemLength: Number(e.target.value) || 1 }))}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
              />
            </label>
            <label className="text-[var(--wms-muted)]">
              Serial start bit
              <input
                type="number"
                value={row.serialStartBit}
                onChange={(e) => setRow((r) => ({ ...r, serialStartBit: Number(e.target.value) || 0 }))}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
              />
            </label>
            <label className="text-[var(--wms-muted)]">
              Serial length
              <input
                type="number"
                value={row.serialLength}
                onChange={(e) => setRow((r) => ({ ...r, serialLength: Number(e.target.value) || 1 }))}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
              />
            </label>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-[var(--wms-fg)]">
            <input
              type="checkbox"
              checked={row.isActive}
              onChange={(e) => setRow((r) => ({ ...r, isActive: e.target.checked }))}
              className="rounded border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]"
            />
            Active (included in mobile sync)
          </label>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[var(--wms-border)] px-4 py-2 text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !row.id.trim() || !row.name.trim()}
            onClick={() => void onSave({ ...row, epcPrefix: row.epcPrefix || "F0A0B" })}
            className="wms-btn-primary font-mono disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
