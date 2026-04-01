"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import type { TenantLocationAdminRow } from "@/lib/queries/settings-locations-admin";
import type { TenantUserListRow } from "@/lib/queries/settings-users";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

export function LocationsSettingsWorkspace() {
  const { data: locations, error, mutate } = useSWR<TenantLocationAdminRow[]>(
    "/api/settings/access/locations",
    fetcher,
    { revalidateOnFocus: false },
  );
  const { data: users } = useSWR<TenantUserListRow[]>("/api/settings/access/users", fetcher, {
    revalidateOnFocus: false,
  });

  const [modal, setModal] = useState<null | { mode: "add" } | { mode: "edit"; row: TenantLocationAdminRow }>(
    null,
  );

  const toggleActive = useCallback(
    async (row: TenantLocationAdminRow) => {
      const next = !row.is_active;
      const res = await fetch(`/api/settings/access/locations/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: row.code,
          name: row.name,
          lightspeedShopId: row.lightspeed_shop_id,
          isActive: next,
          userIds: row.users.map((u) => u.id),
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        window.alert(j.error ?? "Update failed");
        return;
      }
      void mutate();
    },
    [mutate],
  );

  const removeLocation = useCallback(
    async (row: TenantLocationAdminRow) => {
      if (
        !window.confirm(
          `Delete location “${row.name}”? Related data may be removed per database rules.`,
        )
      ) {
        return;
      }
      const res = await fetch(`/api/settings/access/locations/${row.id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        window.alert(j.error ?? "Delete failed");
        return;
      }
      void mutate();
    },
    [mutate],
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setModal({ mode: "add" })}
          className="wms-btn-primary wms-btn-sm font-mono"
        >
          Add location
        </button>
      </div>

      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]/60">
        <table className="w-full min-w-[900px] border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/80 font-mono uppercase tracking-wide">
              <th className="px-3 py-3">Location name</th>
              <th className="px-3 py-3">Code</th>
              <th className="px-3 py-3">Lightspeed shop ID</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Assigned users</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/90">
            {!locations ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                  Loading…
                </td>
              </tr>
            ) : (
              locations.map((row) => (
                <tr key={row.id} className="text-[var(--wms-fg)]">
                  <td className="px-3 py-2.5 font-medium text-[var(--wms-fg)]">{row.name}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-[var(--wms-muted)]">{row.code}</td>
                  <td className="px-3 py-2.5 font-mono text-xs font-medium text-[var(--wms-accent)]">
                    {row.lightspeed_shop_id ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => void toggleActive(row)}
                      className={`rounded-full px-2.5 py-0.5 font-mono text-xs font-medium ${
                        row.is_active
                          ? "bg-emerald-100 text-emerald-900 ring-1 ring-emerald-600/40 dark:bg-emerald-950/50 dark:text-emerald-200/95 dark:ring-emerald-700/45"
                          : "bg-[var(--wms-surface-elevated)] text-[var(--wms-muted)] ring-1 ring-[var(--wms-border)]"
                      }`}
                    >
                      {row.is_active ? "Active" : "Disabled"}
                    </button>
                  </td>
                  <td className="max-w-[220px] px-3 py-2.5 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                    {row.users.length ? row.users.map((u) => u.email).join(", ") : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs">
                    <button
                      type="button"
                      onClick={() => setModal({ mode: "edit", row })}
                      className="text-teal-400/90 hover:underline"
                    >
                      Edit
                    </button>
                    <span className="mx-2 text-[var(--wms-muted)]">|</span>
                    <button
                      type="button"
                      onClick={() => void removeLocation(row)}
                      className="text-red-400/85 hover:underline"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
        Lightspeed shop ID maps to the numeric shop identifier in your Lightspeed admin URLs (R-Series /
        Retail). Use it to target inventory sync per shop.
      </p>

      {modal ? (
        <LocationFormModal
          mode={modal.mode}
          row={modal.mode === "edit" ? modal.row : null}
          users={users ?? []}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void mutate();
          }}
        />
      ) : null}
    </div>
  );
}

function LocationFormModal({
  mode,
  row,
  users,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  row: TenantLocationAdminRow | null;
  users: TenantUserListRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(row?.code ?? "");
  const [name, setName] = useState(row?.name ?? "");
  const [shopId, setShopId] = useState(row?.lightspeed_shop_id != null ? String(row.lightspeed_shop_id) : "");
  const [isActive, setIsActive] = useState(row?.is_active ?? true);
  const [userIds, setUserIds] = useState<Set<string>>(() => new Set(row?.users.map((u) => u.id) ?? []));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setCode(row?.code ?? "");
    setName(row?.name ?? "");
    setShopId(row?.lightspeed_shop_id != null ? String(row.lightspeed_shop_id) : "");
    setIsActive(row?.is_active ?? true);
    setUserIds(new Set(row?.users.map((u) => u.id) ?? []));
  }, [row]);

  const toggleUser = (id: string) => {
    setUserIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const submit = async () => {
    setErr(null);
    if (!code.trim() || !name.trim()) {
      setErr("Code and name are required");
      return;
    }
    const shopNum = shopId.trim() === "" ? null : Number.parseInt(shopId.trim(), 10);
    if (shopId.trim() !== "" && (!Number.isFinite(shopNum) || shopNum! < 1)) {
      setErr("Lightspeed shop ID must be a positive integer or empty");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        code: code.trim(),
        name: name.trim(),
        lightspeedShopId: shopNum,
        isActive: isActive,
        userIds: [...userIds],
      };
      if (mode === "add") {
        const res = await fetch("/api/settings/access/locations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(j.error ?? "Save failed");
      } else if (row) {
        const res = await fetch(`/api/settings/access/locations/${row.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(j.error ?? "Save failed");
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
      />
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-6 shadow-2xl">
        <h3 className="text-sm font-semibold text-[var(--wms-fg)]">
          {mode === "add" ? "Add location" : "Edit location"}
        </h3>
        <p className="mt-1 font-mono text-[0.6rem] leading-relaxed text-[var(--wms-muted)]">
          Lightspeed shop ID: use the numeric id from your Lightspeed URL when viewing a shop / register
          context (varies by product). Leave empty if this site is not mapped to a single LS shop.
        </p>
        <div className="mt-4 space-y-3 font-mono text-xs">
          <label className="block text-[var(--wms-muted)]">
            Short code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={mode === "edit"}
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)] disabled:opacity-60"
              placeholder="001"
            />
          </label>
          <label className="block text-[var(--wms-muted)]">
            Location name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
            />
          </label>
          <label className="block text-[var(--wms-muted)]">
            Lightspeed shop ID (optional)
            <input
              value={shopId}
              onChange={(e) => setShopId(e.target.value)}
              inputMode="numeric"
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
              placeholder="e.g. 1"
            />
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-[var(--wms-fg)]">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]"
            />
            Location active
          </label>
          <div className="text-[var(--wms-muted)]">
            User access
            <div className="mt-2 max-h-36 space-y-1 overflow-y-auto rounded border border-[var(--wms-border)] p-2">
              {users.map((u) => (
                <label key={u.id} className="flex cursor-pointer items-center gap-2 text-[var(--wms-fg)]">
                  <input
                    type="checkbox"
                    checked={userIds.has(u.id)}
                    onChange={() => toggleUser(u.id)}
                    className="rounded border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]"
                  />
                  {u.email}
                </label>
              ))}
            </div>
          </div>
          {err ? <p className="text-red-400/90">{err}</p> : null}
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
            disabled={busy}
            onClick={() => void submit()}
            className="wms-btn-primary font-mono disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
