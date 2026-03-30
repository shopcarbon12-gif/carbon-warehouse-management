import { getSession } from "@/lib/get-session";
import { UsersSettingsWorkspace } from "@/components/settings/users-settings-workspace";

export const dynamic = "force-dynamic";

export default async function UsersRolesSettingsPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-slate-800 pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-slate-100">Users &amp; roles</h1>
        <p className="mt-1 font-mono text-xs text-slate-500">
          Manage tenant users, custom roles with page permissions, and location assignments.
        </p>
      </div>
      <UsersSettingsWorkspace />
    </div>
  );
}
