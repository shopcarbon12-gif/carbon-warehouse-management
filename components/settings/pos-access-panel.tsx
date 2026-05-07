"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { ChevronDown } from "lucide-react";
import type { PosUserListRow } from "@/lib/queries/settings-pos-users";
import type { UserRoleRow } from "@/lib/queries/settings-user-roles";
import {
  type PermissionsMap,
  getSectionMode,
  setSectionMode,
} from "@/lib/settings/permission-catalog";
import { POS_PERMISSION_PAGES } from "@/lib/settings/pos-permission-catalog";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

function hydratePosPermissions(raw: unknown): PermissionsMap {
  const stored = (raw && typeof raw === "object" ? raw : {}) as PermissionsMap;
  const out: PermissionsMap = {};
  for (const page of POS_PERMISSION_PAGES) {
    out[page.id] = {};
    for (const sec of page.sections) {
      out[page.id][sec.id] = getSectionMode(stored, page.id, sec.id);
    }
  }
  return out;
}

type SubTab = "users" | "roles";

/**
 * POS sub-section of the Users & Roles page. Mirrors the WMS Users tab UX
 * (table, edit, export, bulk actions) and adds an inner sub-tab toggle for
 * POS roles. Lives under the parent "POS" tab.
 */
export function PosAccessPanel() {
  const [sub, setSub] = useState<SubTab>("users");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 border-b border-[var(--wms-border)] pb-2" role="tablist">
        <SubTabBtn label="POS users" active={sub === "users"} onClick={() => setSub("users")} />
        <SubTabBtn label="POS roles" active={sub === "roles"} onClick={() => setSub("roles")} />
      </div>
      {sub === "users" ? <PosUsersTab /> : <PosRolesTab />}
    </div>
  );
}

function SubTabBtn({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-t-md px-4 py-2 font-mono text-xs uppercase tracking-wide ${
        active
          ? "border border-b-0 border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-teal-300/90"
          : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
      }`}
    >
      {label}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* POS users                                                                  */
/* -------------------------------------------------------------------------- */

type LocationOpt = { id: string; code: string; name: string };

function PosUsersTab() {
  const { data: users, error, mutate } = useSWR<PosUserListRow[]>(
    "/api/settings/access/pos-users",
    fetcher,
    { revalidateOnFocus: false },
  );
  const { data: roles } = useSWR<UserRoleRow[]>(
    "/api/settings/access/user-roles?scope=pos",
    fetcher,
    { revalidateOnFocus: false },
  );
  const { data: locations } = useSWR<LocationOpt[]>(
    "/api/settings/access/locations",
    fetcher,
    { revalidateOnFocus: false },
  );

  const [editing, setEditing] = useState<PosUserListRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (!users?.length) return;
    setSelectedIds((prev) => (prev.size === users.length ? new Set() : new Set(users.map((u) => u.id))));
  }, [users]);

  const exportCsv = useCallback(() => {
    if (!users?.length) return;
    const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [
      ["Email", "POS role", "Active", "Locations"].map(esc).join(","),
      ...users.map((u) =>
        [
          u.email,
          u.pos_role_name ?? u.legacy_role ?? "—",
          u.is_active ? "yes" : "no",
          u.locations.map((l) => `${l.code} ${l.name}`).join("; "),
        ]
          .map((c) => esc(String(c)))
          .join(","),
      ),
    ];
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pos-users-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [users]);

  const exportSelectedEmails = useCallback(() => {
    if (!users?.length) return;
    const subset = users.filter((u) => selectedIds.has(u.id));
    if (!subset.length) {
      window.alert("Select at least one POS user.");
      return;
    }
    const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [["Email"].map(esc).join(","), ...subset.map((u) => esc(u.email))];
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pos-users-selected-emails-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    setBulkOpen(false);
  }, [users, selectedIds]);

  const bulkDeactivate = useCallback(async () => {
    if (!users?.length) return;
    const subset = users.filter((u) => selectedIds.has(u.id));
    if (!subset.length) {
      window.alert("Select at least one POS user.");
      return;
    }
    if (!window.confirm(`Deactivate ${subset.length} POS user(s)?`)) return;
    setBulkOpen(false);
    let failed = 0;
    for (const u of subset) {
      const res = await fetch(`/api/settings/access/pos-users/${u.id}`, { method: "DELETE" });
      if (!res.ok) failed++;
    }
    setSelectedIds(new Set());
    void mutate();
    if (failed > 0) {
      window.alert(`${subset.length - failed} deactivated, ${failed} failed.`);
    }
  }, [users, selectedIds, mutate]);

  useEffect(() => {
    if (!bulkOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.("[data-pos-bulk]")) setBulkOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [bulkOpen]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
          Add a per-location <span className="text-[var(--wms-fg)]">Manager</span> here. The manager
          then signs into the POS and provisions cashiers from there — those cashiers will appear in
          this list automatically.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="wms-btn-primary wms-btn-sm font-mono"
          >
            Add POS manager
          </button>
          <button
            type="button"
            onClick={exportCsv}
            className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)]"
          >
            Export
          </button>
          <div className="relative" data-pos-bulk>
            <button
              type="button"
              onClick={() => setBulkOpen((o) => !o)}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)]"
            >
              Bulk actions
              <ChevronDown className="h-3.5 w-3.5 opacity-70" />
            </button>
            {bulkOpen ? (
              <div className="absolute right-0 z-20 mt-1 w-56 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-1 shadow-xl">
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
                  onClick={() => void bulkDeactivate()}
                >
                  Deactivate selected
                </button>
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
                  onClick={() => exportSelectedEmails()}
                >
                  Export selected emails (CSV)
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Failed to load POS users"}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]/60">
        <table className="w-full min-w-[760px] border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/80 font-mono uppercase tracking-wide">
              <th className="w-10 px-2 py-3">
                <input
                  type="checkbox"
                  aria-label="Select all POS users"
                  checked={Boolean(users?.length) && selectedIds.size === (users?.length ?? 0)}
                  onChange={() => toggleSelectAll()}
                  className="rounded border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]"
                />
              </th>
              <th className="px-3 py-3">Email</th>
              <th className="px-3 py-3">POS role</th>
              <th className="px-3 py-3">PIN</th>
              <th className="px-3 py-3">Active</th>
              <th className="px-3 py-3">Locations</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/90">
            {!users ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
                  Loading…
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
                  No POS users. Create employees in the POS back-office to populate this list.
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} className="text-[var(--wms-fg)]">
                  <td className="px-2 py-2.5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${u.email}`}
                      checked={selectedIds.has(u.id)}
                      onChange={() => toggleSelect(u.id)}
                      className="rounded border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]"
                    />
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs">{u.email}</td>
                  <td className="px-3 py-2.5 text-[var(--wms-muted)]">
                    {u.pos_role_name ?? (
                      <span className="font-mono text-[0.65rem] italic">
                        {u.legacy_role ?? "—"}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[0.65rem]">
                    {u.has_pin ? (
                      <span className="text-emerald-500/85">●●●●</span>
                    ) : (
                      <span className="text-[var(--wms-muted)]">none</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[0.65rem]">
                    {u.is_active ? (
                      <span className="text-emerald-500/85">yes</span>
                    ) : (
                      <span className="text-[var(--wms-muted)]">no</span>
                    )}
                  </td>
                  <td className="max-w-[260px] px-3 py-2.5 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                    {u.locations.length
                      ? u.locations.map((l) => `${l.code} · ${l.name}`).join(", ")
                      : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs">
                    <button
                      type="button"
                      onClick={() => setEditing(u)}
                      className="font-medium text-[var(--wms-accent)] hover:underline"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing ? (
        <PosUserEditModal
          user={editing}
          roles={roles ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void mutate();
          }}
        />
      ) : null}

      {adding ? (
        <PosManagerCreateModal
          locations={locations ?? []}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void mutate();
          }}
        />
      ) : null}
    </>
  );
}

function PosManagerCreateModal({
  locations,
  onClose,
  onSaved,
}: {
  locations: LocationOpt[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [locationId, setLocationId] = useState<string>(locations[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (!email.trim() || !password.trim() || !pin.trim() || !locationId) {
      setErr("All fields are required");
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      setErr("PIN must be exactly 4 digits");
      return;
    }
    if (password.length < 6) {
      setErr("Password must be at least 6 characters");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/settings/access/pos-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          pin,
          locationId,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-6 shadow-2xl">
        <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Add POS manager</h3>
        <p className="mt-1 font-mono text-[0.65rem] text-[var(--wms-muted)]">
          Provisions a Manager-role POS user for a single location. The manager signs into the POS
          with this email + password and then provisions cashiers from there.
        </p>
        <div className="mt-4 space-y-3 font-mono text-xs">
          <label className="block text-[var(--wms-muted)]">
            Email
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="off"
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
              placeholder="store@shopcarbon.com"
            />
          </label>
          <label className="block text-[var(--wms-muted)]">
            Password (min 6 chars)
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="new-password"
              minLength={6}
              maxLength={128}
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
            />
          </label>
          <label className="block text-[var(--wms-muted)]">
            PIN (4 digits)
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
              placeholder="••••"
            />
          </label>
          <label className="block text-[var(--wms-muted)]">
            Location
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
            >
              {locations.length === 0 ? (
                <option value="">— No locations available —</option>
              ) : (
                locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} · {l.name}
                  </option>
                ))
              )}
            </select>
          </label>
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
            disabled={busy || locations.length === 0}
            onClick={() => void submit()}
            className="wms-btn-primary font-mono disabled:opacity-50"
          >
            {busy ? "Saving…" : "Create manager"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PosUserEditModal({
  user,
  roles,
  onClose,
  onSaved,
}: {
  user: PosUserListRow;
  roles: UserRoleRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [posRoleId, setPosRoleId] = useState<number | null>(user.pos_role_id);
  const [isActive, setIsActive] = useState(user.is_active);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (pin && !/^\d{4}$/.test(pin)) {
      setErr("PIN must be exactly 4 digits");
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        posRoleId: posRoleId,
        isActive: isActive,
      };
      if (pin) body.resetPin = pin;
      const res = await fetch(`/api/settings/access/pos-users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-6 shadow-2xl">
        <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Edit POS user</h3>
        <p className="mt-1 font-mono text-[0.65rem] text-[var(--wms-muted)]">{user.email}</p>
        <div className="mt-4 space-y-3 font-mono text-xs">
          <label className="block text-[var(--wms-muted)]">
            POS role
            <select
              value={posRoleId ?? ""}
              onChange={(e) => setPosRoleId(e.target.value ? Number(e.target.value) : null)}
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
            >
              <option value="">— No POS role —</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-[var(--wms-fg)]">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]"
            />
            POS account active
          </label>
          <label className="block text-[var(--wms-muted)]">
            Reset PIN (4 digits, optional)
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              pattern="\d{4}"
              inputMode="numeric"
              maxLength={4}
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
              placeholder="leave blank to keep current"
            />
          </label>
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

/* -------------------------------------------------------------------------- */
/* POS roles                                                                  */
/* -------------------------------------------------------------------------- */

function PosRolesTab() {
  const { data: roles, error, mutate } = useSWR<UserRoleRow[]>(
    "/api/settings/access/user-roles?scope=pos",
    fetcher,
    { revalidateOnFocus: false },
  );
  const [modal, setModal] = useState<null | { mode: "add" } | { mode: "edit"; row: UserRoleRow }>(null);

  return (
    <>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setModal({ mode: "add" })}
          className="wms-btn-primary wms-btn-sm font-mono"
        >
          Add POS role
        </button>
      </div>
      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Failed to load roles"}
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]/60">
        <table className="w-full min-w-[400px] border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/80 font-mono uppercase tracking-wide">
              <th className="px-3 py-3">Role name</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/90">
            {!roles ? (
              <tr>
                <td colSpan={2} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                  Loading…
                </td>
              </tr>
            ) : (
              roles.map((r) => (
                <tr key={r.id} className="text-[var(--wms-fg)]">
                  <td className="px-3 py-2.5 font-medium">{r.name}</td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => setModal({ mode: "edit", row: r })}
                      className="font-mono text-xs text-teal-400/90 hover:underline"
                    >
                      Edit role
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {modal ? (
        <PosRolePermissionsModal
          mode={modal.mode}
          row={modal.mode === "edit" ? modal.row : null}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void mutate();
          }}
        />
      ) : null}
    </>
  );
}

function PosRolePermissionsModal({
  mode,
  row,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  row: UserRoleRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(row?.name ?? "");
  const [perm, setPerm] = useState<PermissionsMap>(() => hydratePosPermissions(row?.permissions));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setName(row?.name ?? "");
    setPerm(hydratePosPermissions(row?.permissions));
  }, [row]);

  const setMode = (pageId: string, sectionId: string, m: "view" | "hide") => {
    setPerm((p) => setSectionMode(p, pageId, sectionId, m));
  };

  const submit = async () => {
    setErr(null);
    if (!name.trim()) {
      setErr("Role name required");
      return;
    }
    setBusy(true);
    try {
      if (mode === "add") {
        const res = await fetch("/api/settings/access/user-roles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), permissions: perm, scope: "pos" }),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(j.error ?? "Save failed");
      } else if (row) {
        const res = await fetch(`/api/settings/access/user-roles/${row.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), permissions: perm }),
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
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative max-h-[min(90vh,640px)] w-full max-w-2xl overflow-y-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-6 shadow-2xl">
        <h3 className="text-sm font-semibold text-[var(--wms-fg)]">
          {mode === "add" ? "Add POS role" : "Edit POS role"}
        </h3>
        <p className="mt-1 font-mono text-[0.65rem] text-[var(--wms-muted)]">
          POS roles are scoped to the POS app — they are independent of WMS user roles. Empty
          permissions = full access.
        </p>
        <label className="mt-4 block font-mono text-xs text-[var(--wms-muted)]">
          Role name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-sm text-[var(--wms-fg)]"
          />
        </label>
        <div className="mt-4 space-y-4 border-t border-[var(--wms-border)] pt-4">
          {POS_PERMISSION_PAGES.map((page) => (
            <div key={page.id}>
              <div className="font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-accent)]">
                {page.label}
              </div>
              <div className="mt-2 space-y-2">
                {page.sections.map((sec) => {
                  const modeCur = perm[page.id]?.[sec.id] ?? "view";
                  return (
                    <div
                      key={sec.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--wms-border)]/80 bg-[var(--wms-surface-elevated)]/50 px-3 py-2"
                    >
                      <span className="font-mono text-xs text-[var(--wms-fg)]">{sec.label}</span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setMode(page.id, sec.id, "view")}
                          className={`rounded px-2 py-1 font-mono text-xs ${
                            modeCur === "view"
                              ? "bg-[color-mix(in_srgb,var(--wms-accent)_22%,var(--wms-surface-elevated))] font-medium text-[color-mix(in_srgb,var(--wms-fg)_20%,var(--wms-accent))] dark:bg-teal-600/30 dark:text-teal-100"
                              : "text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
                          }`}
                        >
                          View
                        </button>
                        <button
                          type="button"
                          onClick={() => setMode(page.id, sec.id, "hide")}
                          className={`rounded px-2 py-1 font-mono text-xs ${
                            modeCur === "hide"
                              ? "bg-red-100 font-medium text-red-900 dark:bg-red-900/35 dark:text-red-200/90"
                              : "text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
                          }`}
                        >
                          Hide
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {err ? <p className="mt-3 font-mono text-xs text-red-400/90">{err}</p> : null}
        <div className="mt-6 flex flex-wrap justify-between gap-2">
          {mode === "edit" && row ? (
            <button
              type="button"
              onClick={() => void deleteRole(row, onSaved)}
              className="wms-btn-danger wms-btn-sm font-mono"
            >
              Delete role
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-[var(--wms-border)] px-4 py-2 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
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
    </div>
  );
}

async function deleteRole(row: UserRoleRow, onSaved: () => void) {
  if (!window.confirm(`Delete POS role "${row.name}"? Users assigned to it must be reassigned first.`)) return;
  const res = await fetch(`/api/settings/access/user-roles/${row.id}`, { method: "DELETE" });
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    window.alert(j.error ?? "Delete failed");
    return;
  }
  onSaved();
}

