"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { useUrlParam } from "@/lib/use-url-param";
import type { RewardsUserListRow } from "@/lib/queries/settings-rewards-users";
import type { UserRoleRow } from "@/lib/queries/settings-user-roles";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

type SubTab = "users" | "roles";

/**
 * REWARDS sub-section of the Users & Roles page.
 *
 * Mirrors PosAccessPanel structure: two sub-tabs, "Rewards users" and
 * "Rewards roles". Credentials apply to rewards.shopcarbon.com (Carbon-Loyalty
 * shares the WMS Postgres). Roles are restricted to "Super Admin" and
 * "Manager" — no Warehouse role here, the API rejects it on POST.
 */
export function RewardsAccessPanel() {
  const [sub, setSub] = useState<SubTab>("users");
  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap gap-2 border-b border-[var(--wms-border)] pb-2"
        role="tablist"
      >
        <SubTabBtn label="Rewards users" active={sub === "users"} onClick={() => setSub("users")} />
        <SubTabBtn label="Rewards roles" active={sub === "roles"} onClick={() => setSub("roles")} />
      </div>
      {sub === "users" ? <RewardsUsersTab /> : <RewardsRolesTab />}
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
/* Users                                                                      */
/* -------------------------------------------------------------------------- */

function RewardsUsersTab() {
  const { data: users, error, mutate } = useSWR<RewardsUserListRow[]>(
    "/api/settings/access/rewards-users",
    fetcher,
    { revalidateOnFocus: false },
  );
  const { data: roles } = useSWR<UserRoleRow[]>(
    "/api/settings/access/user-roles?scope=rewards",
    fetcher,
    { revalidateOnFocus: false },
  );

  // `rwuser` = "new" (create window) | <rewards user id> (edit window).
  const [rwUserParam, setRwUserParam] = useUrlParam("rwuser");
  const adding = rwUserParam === "new";
  const editing = useMemo<RewardsUserListRow | null>(() => {
    if (!rwUserParam || rwUserParam === "new") return null;
    return users?.find((u) => u.id === rwUserParam) ?? null;
  }, [users, rwUserParam]);

  const deactivate = useCallback(
    async (u: RewardsUserListRow) => {
      if (!window.confirm(`Deactivate rewards access for ${u.email}?`)) return;
      const res = await fetch(`/api/settings/access/rewards-users/${u.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        window.alert(j.error ?? "Deactivate failed");
        return;
      }
      void mutate();
    },
    [mutate],
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
          Credentials manager for{" "}
          <span className="text-[var(--wms-fg)]">rewards.shopcarbon.com</span>. Roles are
          restricted to Super Admin and Manager.
        </p>
        <button
          type="button"
          onClick={() => setRwUserParam("new")}
          className="wms-btn-primary wms-btn-sm font-mono"
        >
          Add rewards user
        </button>
      </div>

      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Failed to load rewards users"}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]/60">
        <table className="w-full min-w-[640px] border-collapse text-left max-md:min-w-[560px]">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/80 font-mono uppercase tracking-wide">
              <th className="px-3 py-3 max-md:sticky max-md:left-0 max-md:z-[1] max-md:bg-[var(--wms-surface-elevated)] max-md:shadow-[inset_-1px_0_0_var(--wms-border)]">Name</th>
              <th className="px-3 py-3">Email</th>
              <th className="px-3 py-3">Role</th>
              <th className="px-3 py-3 max-md:hidden">Password</th>
              <th className="px-3 py-3 max-md:hidden">Active</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/90">
            {!users ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
                  Loading…
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
                  No rewards users yet. Click&nbsp;
                  <span className="text-[var(--wms-fg)]">Add rewards user</span> to provision
                  the first one.
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} className="text-[var(--wms-fg)]">
                  <td className="px-3 py-2.5 text-[var(--wms-fg)] max-md:sticky max-md:left-0 max-md:z-[1] max-md:bg-[var(--wms-surface-elevated)] max-md:shadow-[inset_-1px_0_0_var(--wms-border)]">
                    {[u.first_name, u.last_name].filter(Boolean).join(" ") || (
                      <span className="text-[var(--wms-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs">{u.email}</td>
                  <td className="px-3 py-2.5 text-[var(--wms-muted)]">
                    {u.rewards_role_name ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[0.65rem] max-md:hidden">
                    {u.has_rewards_password ? (
                      <span className="text-emerald-500/85">●●●●●●</span>
                    ) : (
                      <span className="text-[var(--wms-muted)]">unset</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[0.65rem] max-md:hidden">
                    {u.is_active ? (
                      <span className="text-emerald-500/85">yes</span>
                    ) : (
                      <span className="text-[var(--wms-muted)]">no</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs">
                    <button
                      type="button"
                      onClick={() => setRwUserParam(u.id)}
                      className="mr-3 font-medium text-[var(--wms-accent)] hover:underline max-md:inline-flex max-md:min-h-9 max-md:items-center max-md:px-2.5"
                    >
                      Edit
                    </button>
                    {u.is_active ? (
                      <button
                        type="button"
                        onClick={() => void deactivate(u)}
                        className="font-medium text-rose-400 hover:underline max-md:inline-flex max-md:min-h-9 max-md:items-center max-md:px-2.5"
                      >
                        Deactivate
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {adding ? (
        <RewardsUserCreateModal
          onClose={() => setRwUserParam(null)}
          onSaved={() => {
            setRwUserParam(null);
            void mutate();
          }}
        />
      ) : null}

      {editing ? (
        <RewardsUserEditModal
          user={editing}
          roles={roles ?? []}
          onClose={() => setRwUserParam(null)}
          onSaved={() => {
            setRwUserParam(null);
            void mutate();
          }}
        />
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Create modal                                                                */
/* -------------------------------------------------------------------------- */

function RewardsUserCreateModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [roleName, setRoleName] = useState<"Super Admin" | "Manager">("Manager");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (!email.trim() || password.length < 6) {
      setErr("Enter a valid email and a password (6+ characters).");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/settings/access/rewards-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          roleName,
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Create failed");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 z-[60] bg-black/70"
      />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-6 shadow-2xl max-md:max-h-[85dvh] max-md:overflow-y-auto max-md:overscroll-contain">
          <h3 className="font-mono text-sm font-semibold uppercase tracking-wider text-[var(--wms-fg)]">
            Add rewards user
          </h3>
          <p className="mt-1 text-xs text-[var(--wms-muted)]">
            Creates a credential for rewards.shopcarbon.com. Independent of WMS / POS
            passwords.
          </p>
          <div className="mt-4 grid gap-3 font-mono text-xs">
            <label className="grid gap-1">
              <span className="text-[var(--wms-muted)]">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
              />
            </label>
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <label className="grid gap-1">
                <span className="text-[var(--wms-muted)]">First name</span>
                <input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  maxLength={80}
                  className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-[var(--wms-muted)]">Last name</span>
                <input
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  maxLength={80}
                  className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
                />
              </label>
            </div>
            <label className="grid gap-1">
              <span className="text-[var(--wms-muted)]">Password (min 6 chars)</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-[var(--wms-muted)]">Role</span>
              <select
                value={roleName}
                onChange={(e) =>
                  setRoleName(e.target.value === "Super Admin" ? "Super Admin" : "Manager")
                }
                className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
              >
                <option value="Manager">Manager</option>
                <option value="Super Admin">Super Admin</option>
              </select>
            </label>
          </div>
          {err ? <p className="mt-3 text-xs text-rose-400">{err}</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-[var(--wms-border)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              className="wms-btn-primary wms-btn-sm font-mono disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Edit modal                                                                  */
/* -------------------------------------------------------------------------- */

function RewardsUserEditModal({
  user,
  roles,
  onClose,
  onSaved,
}: {
  user: RewardsUserListRow;
  roles: UserRoleRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rewardsRoleId, setRewardsRoleId] = useState<number | null>(user.rewards_role_id);
  const [isActive, setIsActive] = useState<boolean>(user.is_active);
  const [firstName, setFirstName] = useState(user.first_name ?? "");
  const [lastName, setLastName] = useState(user.last_name ?? "");
  const [resetPassword, setResetPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (resetPassword && resetPassword.length < 6) {
      setErr("New password must be at least 6 characters (or leave blank).");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/settings/access/rewards-users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rewardsRoleId,
          isActive,
          resetPassword: resetPassword || undefined,
          firstName: firstName.trim() || null,
          lastName: lastName.trim() || null,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Update failed");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 z-[60] bg-black/70"
      />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-6 shadow-2xl max-md:max-h-[85dvh] max-md:overflow-y-auto max-md:overscroll-contain">
          <h3 className="font-mono text-sm font-semibold uppercase tracking-wider text-[var(--wms-fg)]">
            Edit rewards user
          </h3>
          <p className="mt-1 text-xs text-[var(--wms-muted)]">
            <span className="font-mono text-[var(--wms-fg)]">{user.email}</span>
          </p>
          <div className="mt-4 grid gap-3 font-mono text-xs">
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <label className="grid gap-1">
                <span className="text-[var(--wms-muted)]">First name</span>
                <input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  maxLength={80}
                  className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-[var(--wms-muted)]">Last name</span>
                <input
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  maxLength={80}
                  className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
                />
              </label>
            </div>
            <label className="grid gap-1">
              <span className="text-[var(--wms-muted)]">Role</span>
              <select
                value={rewardsRoleId == null ? "" : String(rewardsRoleId)}
                onChange={(e) => {
                  const v = e.target.value;
                  setRewardsRoleId(v === "" ? null : Number(v));
                }}
                className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
              >
                <option value="">— No role —</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
              />
              <span className="text-[var(--wms-fg)]">Active</span>
            </label>
            <label className="grid gap-1">
              <span className="text-[var(--wms-muted)]">Reset password (optional, 6+ chars)</span>
              <input
                type="password"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
              />
            </label>
          </div>
          {err ? <p className="mt-3 text-xs text-rose-400">{err}</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-[var(--wms-border)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              className="wms-btn-primary wms-btn-sm font-mono disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Roles                                                                       */
/* -------------------------------------------------------------------------- */

function RewardsRolesTab() {
  const { data: roles, error } = useSWR<UserRoleRow[]>(
    "/api/settings/access/user-roles?scope=rewards",
    fetcher,
    { revalidateOnFocus: false },
  );

  return (
    <>
      <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
        Rewards roles are seeded by migration 0079 and locked to{" "}
        <span className="text-[var(--wms-fg)]">Super Admin</span> and{" "}
        <span className="text-[var(--wms-fg)]">Manager</span>. No Warehouse role exists for
        rewards. Permissions on each role are managed inside Carbon-Loyalty.
      </p>

      {error ? (
        <p className="mt-3 font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Failed to load rewards roles"}
        </p>
      ) : null}

      <div className="mt-3 overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]/60">
        <table className="w-full min-w-[420px] border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/80 font-mono uppercase tracking-wide">
              <th className="px-3 py-3">Role</th>
              <th className="px-3 py-3">Scope</th>
              <th className="px-3 py-3">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/90">
            {!roles ? (
              <tr>
                <td colSpan={3} className="px-3 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
                  Loading…
                </td>
              </tr>
            ) : roles.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
                  Rewards roles missing — run migration 0079_rewards_access.sql.
                </td>
              </tr>
            ) : (
              roles.map((r) => (
                <tr key={r.id} className="text-[var(--wms-fg)]">
                  <td className="px-3 py-2.5 font-mono text-xs">{r.name}</td>
                  <td className="px-3 py-2.5 text-[var(--wms-muted)]">{r.scope}</td>
                  <td className="px-3 py-2.5 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                    {new Date(r.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
