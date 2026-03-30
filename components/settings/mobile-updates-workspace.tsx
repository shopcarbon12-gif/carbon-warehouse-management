"use client";

import { useCallback, useState } from "react";

export function MobileUpdatesWorkspace() {
  const [versionLabel, setVersionLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f?.name.toLowerCase().endsWith(".apk")) setFile(f);
  }, []);

  const upload = async () => {
    if (!file || !versionLabel.trim()) {
      setMsg("Choose an APK file and enter a version label.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("apk", file);
      fd.set("versionLabel", versionLabel.trim());
      const res = await fetch("/api/mobile/upload-apk", { method: "POST", body: fd });
      const j = (await res.json().catch(() => ({}))) as { error?: string; apkUrl?: string };
      if (!res.ok) throw new Error(j.error ?? "Upload failed");
      setMsg(`Saved. Active release URL: ${j.apkUrl ?? "(ok)"}`);
      setFile(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="rounded-xl border-2 border-dashed border-[var(--wms-border)] bg-[var(--wms-surface)] p-8 text-center dark:border-[var(--wms-border)]"
      >
        <p className="font-mono text-sm text-[var(--wms-muted)]">Drop release APK here, or choose a file</p>
        <input
          type="file"
          accept=".apk"
          className="mt-4 block w-full font-mono text-xs text-[var(--wms-fg)]"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>
      <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
        Version label
        <input
          value={versionLabel}
          onChange={(e) => setVersionLabel(e.target.value)}
          placeholder="e.g. 0.2.0"
          className="mt-1 w-full max-w-md rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm dark:border-[var(--wms-border)]"
        />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => void upload()}
        className="w-fit rounded-lg bg-[var(--wms-accent)] px-4 py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] disabled:opacity-50"
      >
        {busy ? "Uploading…" : "Upload & set active"}
      </button>
      {msg ? <p className="font-mono text-xs text-[var(--wms-muted)]">{msg}</p> : null}
    </div>
  );
}
