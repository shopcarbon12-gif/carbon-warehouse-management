import { getSession } from "@/lib/get-session";
import { LocationsSettingsWorkspace } from "@/components/settings/locations-settings-workspace";

export const dynamic = "force-dynamic";

export default async function LocationsSettingsPage() {
  const session = await getSession();
  if (!session) return null;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-6">
      <div className="border-b border-slate-800 pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-slate-100">Location settings</h1>
        <p className="mt-1 font-mono text-xs text-slate-500">
          Sites, Lightspeed shop mapping, active status, and which users may operate each location.
        </p>
      </div>
      <LocationsSettingsWorkspace />
    </div>
  );
}
