export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">Settings</h1>
      <p className="mt-1 font-mono text-sm text-[var(--muted)]">
        Policy toggles and tenant defaults will live here; session and location are controlled from
        the shell.
      </p>
      <ul className="mt-6 space-y-3 font-mono text-sm text-[var(--foreground)]">
        <li className="flex items-center gap-2">
          <input type="checkbox" defaultChecked readOnly className="accent-[var(--accent)]" />
          <span>Allow handheld offline queue (placeholder)</span>
        </li>
        <li className="flex items-center gap-2">
          <input type="checkbox" readOnly className="accent-[var(--accent)]" />
          <span>Sync zero-RFID items to external (dangerous — placeholder)</span>
        </li>
      </ul>
    </div>
  );
}
