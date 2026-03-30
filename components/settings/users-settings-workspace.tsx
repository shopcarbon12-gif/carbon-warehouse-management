"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { ChevronDown } from "lucide-react";
import type { TenantUserListRow } from "@/lib/queries/settings-users";
import type { UserRoleRow } from "@/lib/queries/settings-user-roles";
import {
  APP_PERMISSION_PAGES,
  type PermissionsMap,
  getSectionMode,
  setSectionMode,
} from "@/lib/settings/permission-catalog";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

function hydratePermissions(raw: unknown): PermissionsMap {
  const stored = (raw && typeof raw === "object" ? raw : {}) as PermissionsMap;
  const out: PermissionsMap = {};
  for (const page of APP_PERMISSION_PAGES) {
    out[page.id] = {};
    for (const sec of page.sections) {
      out[page.id][sec.id] = getSectionMode(stored, page.id, sec.id);
    }
  }
  return out;
}

type Tab = "users" | "roles";

export function UsersSettingsWorkspace() {
  const [tab, setTab] = useState<Tab>("users");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [editUser, setEditUser] = useState<TenantUserListRow | null>(null);
  const [roleModal, setRoleModal] = useState<null | { mode: "add" } | { mode: "edit"; row: UserRoleRow }>(
    null,
  );

  const { data: users, error: usersErr, mutate: muUsers } = useSWR<TenantUserListRow[]>(
    "/api/settings/access/users",
    fetcher,
    { revalidateOnFocus: false },
  );
  const { data: roles, error: rolesErr, mutate: muRoles } = useSWR<UserRoleRow[]>(
    "/api/settings/access/user-roles",
    fetcher,
    { revalidateOnFocus: false },
  );

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
    setSelectedIds((prev) => {
      if (prev.size === users.length) return new Set();
      return new Set(users.map((u) => u.id));
    });
  }, [users]);

  const exportUsersCsv = useCallback(() => {
    if (!users?.length) return;
    const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [
      ["Email", "Role", "Locations"].map(esc).join(","),
      ...users.map((u) =>
        [
          u.email,
          u.role_name ?? "—",
          u.locations.map((l) => `${l.code} ${l.name}`).join("; "),
        ]
          .map((c) => esc(String(c)))
          .join(","),
      ),
    ];
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `wms-users-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [users]);

  const exportSelectedEmailsCsv = useCallback(() => {
    if (!users?.length) return;
    const subset = users.filter((u) => selectedIds.has(u.id));
    if (!subset.length) {
      window.alert("Select at least one user.");
      return;
    }
    const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [["Email"].map(esc).join(","), ...subset.map((u) => esc(u.email))];
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `wms-users-selected-emails-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    setBulkOpen(false);
  }, [users, selectedIds]);

  const bulkDeactivate = useCallback(async () => {
    if (!users?.length) return;
    const subset = users.filter((u) => selectedIds.has(u.id));
    if (!subset.length) {
      window.alert("Select at least one user.");
      return;
    }
    if (
      !window.confirm(
        `Remove ${subset.length} user(s) from this tenant? They will lose access to this WMS tenant.`,
      )
    ) {
      return;
    }
    setBulkOpen(false);
    let failed = 0;
    for (const u of subset) {
      const res = await fetch(`/api/settings/access/users/${u.id}`, { method: "DELETE" });
      if (!res.ok) failed++;
    }
    setSelectedIds(new Set());
    void muUsers();
    if (failed > 0) {
      window.alert(`${subset.length - failed} removed, ${failed} failed (check permissions or last admin).`);
    }
  }, [users, selectedIds, muUsers]);

  useEffect(() => {
    if (!bulkOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.("[data-bulk-dropdown]")) setBulkOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [bulkOpen]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-2" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "users"}
          onClick={() => setTab("users")}
          className={`rounded-t-md px-4 py-2 font-mono text-xs uppercase tracking-wide ${
            tab === "users"
              ? "border border-b-0 border-slate-700 bg-zinc-900 text-teal-300/90"
              : "text-slate-500 hover:text-slate-300"
          }`}
        >
          Users
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "roles"}
          onClick={() => setTab("roles")}
          className={`rounded-t-md px-4 py-2 font-mono text-xs uppercase tracking-wide ${
            tab === "roles"
              ? "border border-b-0 border-slate-700 bg-zinc-900 text-teal-300/90"
              : "text-slate-500 hover:text-slate-300"
          }`}
        >
          User roles
        </button>
      </div>

      {tab === "users" ? (
        <>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setAddUserOpen(true)}
              className="rounded-md bg-teal-600 px-3 py-2 font-mono text-xs font-semibold text-white hover:bg-teal-500"
            >
              Add user
            </button>
            <button
              type="button"
              onClick={exportUsersCsv}
              className="rounded-md border border-slate-600 bg-zinc-900 px-3 py-2 font-mono text-xs text-slate-200 hover:bg-zinc-800"
            >
              Export
            </button>
            <div className="relative" data-bulk-dropdown>
              <button
                type="button"
                onClick={() => setBulkOpen((o) => !o)}
                className="inline-flex items-center gap-1 rounded-md border border-slate-600 bg-zinc-900 px-3 py-2 font-mono text-xs text-slate-200 hover:bg-zinc-800"
              >
                Bulk actions
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
              </button>
              {bulkOpen ? (
                <div className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-slate-700 bg-zinc-900 py-1 shadow-xl">
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left font-mono text-xs text-slate-300 hover:bg-zinc-800"
                    onClick={() => void bulkDeactivate()}
                  >
                    Remove selected from tenant
                  </button>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left font-mono text-xs text-slate-300 hover:bg-zinc-800"
                    onClick={() => exportSelectedEmailsCsv()}
                  >
                    Export selected emails (CSV)
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {usersErr ? (
            <p className="font-mono text-xs text-red-400/90">
              {usersErr instanceof Error ? usersErr.message : "Failed to load users"}
            </p>
          ) : null}

          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-zinc-950/60">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-800 bg-zinc-900/80 font-mono text-[0.6rem] uppercase text-slate-500">
                  <th className="w-10 px-2 py-3">
                    <input
                      type="checkbox"
                      aria-label="Select all users"
                      checked={Boolean(users?.length) && selectedIds.size === (users?.length ?? 0)}
                      onChange={() => toggleSelectAll()}
                      className="rounded border-slate-600 bg-zinc-900"
                    />
                  </th>
                  <th className="px-3 py-3">Email</th>
                  <th className="px-3 py-3">Role</th>
                  <th className="px-3 py-3">Locations</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/90">
                {!users ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center font-mono text-xs text-slate-500">
                      Loading…
                    </td>
                  </tr>
                ) : (
                  users.map((u) => (
                    <tr key={u.id} className="text-slate-200">
                      <td className="px-2 py-2.5">
                        <input
                          type="checkbox"
                          aria-label={`Select ${u.email}`}
                          checked={selectedIds.has(u.id)}
                          onChange={() => toggleSelect(u.id)}
                          className="rounded border-slate-600 bg-zinc-900"
                        />
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-slate-100">{u.email}</td>
                      <td className="px-3 py-2.5 text-slate-400">{u.role_name ?? "—"}</td>
                      <td className="max-w-[280px] px-3 py-2.5 font-mono text-[0.65rem] text-slate-500">
                        {u.locations.length
                          ? u.locations.map((l) => `${l.code} · ${l.name}`).join(", ")
                          : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs">
                        <button
                          type="button"
                          onClick={() => setEditUser(u)}
                          className="text-teal-400/90 hover:underline"
                        >
                          Edit
                        </button>
                        <span className="mx-2 text-slate-600">|</span>
                        <button
                          type="button"
                          onClick={() => void removeUser(u, muUsers)}
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

          {addUserOpen ? (
            <UserFormModal
              title="Add user"
              roles={roles ?? []}
              onClose={() => setAddUserOpen(false)}
              onSaved={() => {
                setAddUserOpen(false);
                void muUsers();
              }}
            />
          ) : null}
          {editUser ? (
            <UserFormModal
              title="Edit user"
              roles={roles ?? []}
              initial={editUser}
              onClose={() => setEditUser(null)}
              onSaved={() => {
                setEditUser(null);
                void muUsers();
              }}
            />
          ) : null}
        </>
      ) : (
        <>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setRoleModal({ mode: "add" })}
              className="rounded-md bg-teal-600 px-3 py-2 font-mono text-xs font-semibold text-white hover:bg-teal-500"
            >
              Add role
            </button>
          </div>
          {rolesErr ? (
            <p className="font-mono text-xs text-red-400/90">
              {rolesErr instanceof Error ? rolesErr.message : "Failed to load roles"}
            </p>
          ) : null}
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-zinc-950/60">
            <table className="w-full min-w-[400px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-800 bg-zinc-900/80 font-mono text-[0.6rem] uppercase text-slate-500">
                  <th className="px-3 py-3">Role name</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/90">
                {!roles ? (
                  <tr>
                    <td colSpan={2} className="px-3 py-8 text-center text-slate-500">
                      Loading…
                    </td>
                  </tr>
                ) : (
                  roles.map((r) => (
                    <tr key={r.id} className="text-slate-200">
                      <td className="px-3 py-2.5 font-medium">{r.name}</td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => setRoleModal({ mode: "edit", row: r })}
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

          {roleModal ? (
            <RolePermissionsModal
              mode={roleModal.mode}
              row={roleModal.mode === "edit" ? roleModal.row : null}
              onClose={() => setRoleModal(null)}
              onSaved={() => {
                setRoleModal(null);
                void muRoles();
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

async function removeUser(u: TenantUserListRow, mutate: () => void) {
  if (!window.confirm(`Remove ${u.email} from this tenant?`)) return;
  const res = await fetch(`/api/settings/access/users/${u.id}`, { method: "DELETE" });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    window.alert(j.error ?? "Remove failed");
    return;
  }
  void mutate();
}

function UserFormModal({
  title,
  roles,
  initial,
  onClose,
  onSaved,
}: {
  title: string;
  roles: UserRoleRow[];
  initial?: TenantUserListRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = useState(initial?.email ?? "");
  const [password, setPassword] = useState("");
  const [roleId, setRoleId] = useState<number>(initial?.role_id ?? roles[0]?.id ?? 0);
  const [locIds, setLocIds] = useState<Set<string>>(
    () => new Set(initial?.locations.map((l) => l.id) ?? []),
  );
  const [allLocs, setAllLocs] = useState<{ id: string; code: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/settings/access/locations")
      .then((r) => r.json())
      .then((rows: { id: string; code: string; name: string }[]) => setAllLocs(Array.isArray(rows) ? rows : []))
      .catch(() => setAllLocs([]));
  }, []);

  const toggleLoc = (id: string) => {
    setLocIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const submit = async () => {
    setErr(null);
    if (!email.trim()) {
      setErr("Email required");
      return;
    }
    if (!roleId) {
      setErr("Select a role");
      return;
    }
    setBusy(true);
    try {
      if (initial) {
        const res = await fetch(`/api/settings/access/users/${initial.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: email.trim(),
            roleId,
            locationIds: [...locIds],
          }),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(j.error ?? "Save failed");
      } else {
        const res = await fetch("/api/settings/access/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: email.trim(),
            password: password.trim() || undefined,
            roleId,
            locationIds: [...locIds],
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          error?: string;
          generatedPassword?: string;
        };
        if (!res.ok) throw new Error(j.error ?? "Save failed");
        if (j.generatedPassword) {
          window.alert(`User created. Temporary password:\n\n${j.generatedPassword}\n\nCopy it now; it will not be shown again.`);
        }
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
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-800 bg-zinc-950 p-6 shadow-2xl">
        <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        <div className="mt-4 space-y-3 font-mono text-xs">
          <label className="block text-slate-500">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={!!initial}
              className="mt-1 w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 text-slate-100 disabled:opacity-60"
            />
          </label>
          {!initial ? (
            <label className="block text-slate-500">
              Password (optional — auto-generated if empty)
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 text-slate-100"
              />
            </label>
          ) : null}
          <label className="block text-slate-500">
            Role
            <select
              value={roleId}
              onChange={(e) => setRoleId(Number(e.target.value))}
              className="mt-1 w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 text-slate-100"
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <div className="text-slate-500">
            Locations
            <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded border border-slate-800 p-2">
              {allLocs.map((l) => (
                <label key={l.id} className="flex cursor-pointer items-center gap-2 text-slate-300">
                  <input
                    type="checkbox"
                    checked={locIds.has(l.id)}
                    onChange={() => toggleLoc(l.id)}
                    className="rounded border-slate-600 bg-zinc-900"
                  />
                  {l.code} · {l.name}
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
            className="rounded border border-slate-600 px-4 py-2 text-slate-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="rounded bg-teal-600 px-4 py-2 font-semibold text-white hover:bg-teal-500 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RolePermissionsModal({
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
  const [perm, setPerm] = useState<PermissionsMap>(() => hydratePermissions(row?.permissions));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setName(row?.name ?? "");
    setPerm(hydratePermissions(row?.permissions));
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
          body: JSON.stringify({ name: name.trim(), permissions: perm }),
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
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
      />
      <div className="relative max-h-[min(90vh,640px)] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-800 bg-zinc-950 p-6 shadow-2xl">
        <h3 className="text-sm font-semibold text-slate-100">
          {mode === "add" ? "Add role" : "Edit role"}
        </h3>
        <p className="mt-1 font-mono text-[0.65rem] text-slate-500">
          Permissions control page/section visibility (stored as JSON on the role). Enforcement in navigation
          can be wired in a follow-up.
        </p>
        <label className="mt-4 block font-mono text-xs text-slate-500">
          Role name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 text-sm text-slate-100"
          />
        </label>
        <div className="mt-4 space-y-4 border-t border-slate-800 pt-4">
          {APP_PERMISSION_PAGES.map((page) => (
            <div key={page.id}>
              <div className="font-mono text-[0.65rem] font-semibold uppercase tracking-wide text-teal-500/80">
                {page.label}
              </div>
              <div className="mt-2 space-y-2">
                {page.sections.map((sec) => {
                  const modeCur = perm[page.id]?.[sec.id] ?? "view";
                  return (
                    <div
                      key={sec.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-800/80 bg-zinc-900/40 px-3 py-2"
                    >
                      <span className="font-mono text-xs text-slate-300">{sec.label}</span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setMode(page.id, sec.id, "view")}
                          className={`rounded px-2 py-1 font-mono text-[0.65rem] ${
                            modeCur === "view"
                              ? "bg-teal-600/30 text-teal-200"
                              : "text-slate-500 hover:bg-zinc-800"
                          }`}
                        >
                          View
                        </button>
                        <button
                          type="button"
                          onClick={() => setMode(page.id, sec.id, "hide")}
                          className={`rounded px-2 py-1 font-mono text-[0.65rem] ${
                            modeCur === "hide"
                              ? "bg-red-900/35 text-red-200/90"
                              : "text-slate-500 hover:bg-zinc-800"
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
              className="rounded border border-red-900/50 px-3 py-2 font-mono text-xs text-red-400 hover:bg-red-950/30"
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
              className="rounded border border-slate-600 px-4 py-2 font-mono text-xs text-slate-300 hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="rounded bg-teal-600 px-4 py-2 font-mono text-xs font-semibold text-white hover:bg-teal-500 disabled:opacity-50"
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
  if (!window.confirm(`Delete role “${row.name}”? Users must not reference it.`)) return;
  const res = await fetch(`/api/settings/access/user-roles/${row.id}`, { method: "DELETE" });
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    window.alert(j.error ?? "Delete failed");
    return;
  }
  onSaved();
}
