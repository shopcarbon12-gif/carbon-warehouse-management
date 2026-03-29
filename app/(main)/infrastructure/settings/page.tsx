import { SettingsWorkspace } from "@/components/infrastructure/settings/settings-workspace";

export default function InfrastructureSettingsPage() {
  return (
    <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-6">
      <div className="border-b border-slate-800 pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-slate-100">Settings</h1>
        <p className="mt-1 font-mono text-xs text-slate-500">
          Tenant RFID defaults and integration identifiers. Secrets stay in environment variables.
        </p>
      </div>
      <SettingsWorkspace />
    </div>
  );
}
