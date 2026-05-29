"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import type { TenantUserListRow } from "@/lib/queries/settings-users";
import type { UserRoleRow } from "@/lib/queries/settings-user-roles";
import {
  type PermissionsMap,
  getSectionMode,
  setSectionMode,
} from "@/lib/settings/permission-catalog";
import { MOBILE_PERMISSION_PAGES } from "@/lib/settings/mobile-permission-catalog";

/**
 * WMS Mobile sub-section of the Users & Roles page. The handheld app signs in
 * with the SAME WMS user accounts, so "Mobile users" lists the tenant users
 * and lets an admin assign each a Mobile role; "Mobile roles" is a per-screen
 * View/Hide editor (scope='mobile') covering every screen in the app. Lives
 * under the parent "WMS Mobile" tab.
 */

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

function hydrateMobilePermissions(raw: unknown): PermissionsMap {
  const stored = (raw && typeof raw === "object" ? raw : {}) as PermissionsMap;
  const out: PermissionsMap = {};
  for (const page of MOBILE_PERMISSION_PAGES) {
    out[page.id] = {};
    for (const sec of page.sections) {
      out[page.id][sec.id] = getSectionMode(stored, page.id, sec.id);
    }
  }
  return out;
}

type SubTab = "users" | "roles";

export function MobileAccessPanel() {
  const [sub, setSub] = useState<SubTab>("users");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 border-b border-[var(--wms-border)] pb-2" role="tablist">
        <SubTabBtn label="Mobile users" active={sub === "users"} onClick={() => setSub("users")} />
        <SubTabBtn label="Mobile roles" active={sub === "roles"} onClick={() => setSub("roles")} />
      </div>
      {sub === "users" ? <MobileUsersTab /> : <MobileRolesTab />}
    </div>
  );
}

function SubTabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
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
/* Mobile users                                                               */
/* -------------------------------------------------------------------------- */

function MobileUsersTab() {
  const { data: users, error, mutate } = useSWR<TenantUserListRow[]>(
    "/api/settings/access/users",
    fetcher,
    { revalidateOnFocus: false },
  );
  const { data: roles } = useSWR<UserRoleRow[]>(
    "/api/settings/access/user-roles?scope=mobile",
    fetcher,
    { revalidateOnFocus: false },
  );
  const [editing, setEditing] = useState<TenantUserListRow | null>(null);

  return (
    <>
      <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
        The handheld app signs in with these WMS accounts. Assign a{" "}
        <span className="text-[var(--wms-fg)]">Mobile role</span> to control which app screens each
        person sees. No role = full access (Super Admin).
      </p>

      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Failed to load users"}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]/60">
        <table className="w-full min-w-[680px] border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/80 font-mono uppercase tracking-wide">
              <th className="px-3 py-3">Name</th>
              <th className="px-3 py-3">Email</th>
              <th className="px-3 py-3">WMS role</th>
              <th className="px-3 py-3">Mobile role</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/90">
            {!users ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
                  Loading…
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} className="text-[var(--wms-fg)]">
                  <td className="px-3 py-2.5">
                    {[u.first_name, u.last_name].filter(Boolean).join(" ") || (
                      <span className="text-[var(--wms-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs">{u.email}</td>
                  <td className="px-3 py-2.5 text-[var(--wms-muted)]">{u.role_name ?? "—"}</td>
                  <td className="px-3 py-2.5">
                    {u.mobile_role_name ? (
                      <span className="rounded border border-teal-500/40 bg-teal-950/30 px-2 py-0.5 font-mono text-[0.65rem] text-teal-200">
                        {u.mobile_role_name}
                      </span>
                    ) : (
                      <span className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
                        full access
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs">
                    <button
                      type="button"
                      onClick={() => setEditing(u)}
                      className="font-medium text-[var(--wms-accent)] hover:underline"
                    >
                      Set mobile role
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing ? (
        <MobileRoleAssignModal
          user={editing}
          roles={roles ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void mutate();
          }}
        />
      ) : null}
    </>
  );
}

function MobileRoleAssignModal({
  user,
  roles,
  onClose,
  onSaved,
}: {
  user: TenantUserListRow;
  roles: UserRoleRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [roleId, setRoleId] = useState<number | null>(user.mobile_role_id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/settings/access/users/${user.id}/mobile-role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobileRoleId: roleId }),
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
      <div className="relative w-full max-w-md rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-6 shadow-2xl">
        <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Mobile role</h3>
        <p className="mt-1 font-mono text-[0.65rem] text-[var(--wms-muted)]">{user.email}</p>
        <label className="mt-4 block font-mono text-xs text-[var(--wms-muted)]">
          Mobile role
          <select
            value={roleId ?? ""}
            onChange={(e) => setRoleId(e.target.value ? Number(e.target.value) : null)}
            className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
          >
            <option value="">— No role (full access) —</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        {err ? <p className="mt-3 font-mono text-xs text-red-400/90">{err}</p> : null}
        <div className="mt-6 flex justify-end gap-2">
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
  );
}

/* -------------------------------------------------------------------------- */
/* Mobile roles                                                               */
/* -------------------------------------------------------------------------- */

function MobileRolesTab() {
  const { data: roles, error, mutate } = useSWR<UserRoleRow[]>(
    "/api/settings/access/user-roles?scope=mobile",
    fetcher,
    { revalidateOnFocus: false },
  );
  const [modal, setModal] = useState<null | { mode: "add" } | { mode: "edit"; row: UserRoleRow }>(null);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
          Mobile roles map to the handheld app&apos;s screens. Empty permissions = full access — so
          the seeded <span className="text-[var(--wms-fg)]">Super Admin</span> sees every screen on
          every platform.
        </p>
        <button
          type="button"
          onClick={() => setModal({ mode: "add" })}
          className="wms-btn-primary wms-btn-sm font-mono"
        >
          Add mobile role
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
                  <td className="px-3 py-2.5 font-medium">
                    {r.name}
                    {r.name.toLowerCase() === "super admin" ? (
                      <span className="ml-2 rounded border border-amber-500/40 bg-amber-950/30 px-1.5 py-0.5 font-mono text-[0.5rem] uppercase tracking-wide text-amber-200">
                        full access · all platforms
                      </span>
                    ) : null}
                  </td>
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
        <MobileRolePermissionsModal
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

function MobileRolePermissionsModal({
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
  const [perm, setPerm] = useState<PermissionsMap>(() => hydrateMobilePermissions(row?.permissions));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setName(row?.name ?? "");
    setPerm(hydrateMobilePermissions(row?.permissions));
  }, [row]);

  const setOne = (pageId: string, sectionId: string, m: "view" | "hide") => {
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
          body: JSON.stringify({ name: name.trim(), permissions: perm, scope: "mobile" }),
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
          {mode === "add" ? "Add mobile role" : "Edit mobile role"}
        </h3>
        <p className="mt-1 font-mono text-[0.65rem] text-[var(--wms-muted)]">
          Toggle each handheld screen View / Hide. Empty = full access. App-side enforcement ships in
          the next mobile release.
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
          {MOBILE_PERMISSION_PAGES.map((page) => (
            <div key={page.id}>
              <div className="font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-accent)]">
                {page.label}
              </div>
              <div className="mt-2 space-y-2">
                {page.sections.map((sec) => {
                  const cur = perm[page.id]?.[sec.id] ?? "view";
                  return (
                    <div
                      key={sec.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--wms-border)]/80 bg-[var(--wms-surface-elevated)]/50 px-3 py-2"
                    >
                      <span className="font-mono text-xs text-[var(--wms-fg)]">{sec.label}</span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setOne(page.id, sec.id, "view")}
                          className={`rounded px-2 py-1 font-mono text-xs ${
                            cur === "view"
                              ? "bg-teal-600/30 font-medium text-teal-100"
                              : "text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
                          }`}
                        >
                          View
                        </button>
                        <button
                          type="button"
                          onClick={() => setOne(page.id, sec.id, "hide")}
                          className={`rounded px-2 py-1 font-mono text-xs ${
                            cur === "hide"
                              ? "bg-red-900/35 font-medium text-red-200/90"
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
  if (!window.confirm(`Delete mobile role "${row.name}"? Users assigned to it must be reassigned first.`))
    return;
  const res = await fetch(`/api/settings/access/user-roles/${row.id}`, { method: "DELETE" });
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    window.alert(j.error ?? "Delete failed");
    return;
  }
  onSaved();
}
