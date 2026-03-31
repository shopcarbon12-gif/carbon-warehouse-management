"use client";

import { useCallback, useId, useRef, useState } from "react";

export function MobileUpdatesWorkspace() {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [versionLabel, setVersionLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer.files?.[0];
    if (f?.name.toLowerCase().endsWith(".apk")) {
      setFile(f);
      setMsg(`${f.name} (${(f.size / (1024 * 1024)).toFixed(1)} MiB)`);
    } else {
      setMsg("Drop a single .apk file.");
    }
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const upload = async () => {
    if (!file || !versionLabel.trim()) {
      setMsg("Choose an APK (drop or browse) and enter a version label.");
      return;
    }
    setBusy(true);
    setMsg(`Uploading ${file.name}…`);
    try {
      const fd = new FormData();
      fd.set("apk", file);
      fd.set("versionLabel", versionLabel.trim());
      const res = await fetch("/api/mobile/upload-apk", { method: "POST", body: fd });
      const text = await res.text();
      let j: { error?: string; apkUrl?: string; apkUrlAbsolute?: string } = {};
      try {
        j = JSON.parse(text) as typeof j;
      } catch {
        if (!res.ok) {
          throw new Error(
            res.status === 413
              ? "Upload too large for server/proxy (HTTP 413). In Coolify, raise Traefik/client max body size for this host."
              : text.slice(0, 240) || `HTTP ${res.status}`,
          );
        }
        throw new Error(text.slice(0, 240) || "Invalid JSON from server");
      }
      if (!res.ok) throw new Error(j.error ?? `Upload failed (${res.status})`);
      const abs = j.apkUrlAbsolute ?? j.apkUrl ?? "(ok)";
      setMsg(`Saved. Active release: ${abs}. Handhelds will see this on the next /api/mobile/status poll.`);
      setFile(null);
      setInputKey((k) => k + 1);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={onDragOver}
        onDrop={onDrop}
        className="rounded-xl border-2 border-dashed border-[var(--wms-border)] bg-[var(--wms-surface)] p-8 text-center dark:border-[var(--wms-border)]"
      >
        <p className="font-mono text-sm text-[var(--wms-muted)]">Drop release APK here, or choose a file</p>
        <input
          key={inputKey}
          ref={fileInputRef}
          id={inputId}
          type="file"
          accept=".apk,application/vnd.android.package-archive"
          className="mt-4 block w-full font-mono text-xs text-[var(--wms-fg)]"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            setMsg(f ? `${f.name} (${(f.size / (1024 * 1024)).toFixed(1)} MiB)` : null);
          }}
        />
        {file ? (
          <p className="mt-3 font-mono text-xs text-[var(--wms-fg)]">
            Ready: <strong>{file.name}</strong>
          </p>
        ) : null}
      </div>
      <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
        Version label
        <input
          value={versionLabel}
          onChange={(e) => setVersionLabel(e.target.value)}
          placeholder="e.g. 0.1.9 or v0.1.10"
          className="mt-1 w-full max-w-md rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm dark:border-[var(--wms-border)]"
        />
      </label>
      <p className="max-w-2xl font-mono text-[0.65rem] leading-relaxed text-[var(--wms-muted)]">
        Re-uploading the <strong>same version label</strong> replaces the stored APK for that label. Large files need
        enough proxy body limit on the VPS (Traefik / Coolify).
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void upload()}
        className="w-fit rounded-lg bg-[var(--wms-accent)] px-4 py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] disabled:opacity-50"
      >
        {busy ? "Uploading…" : "Upload & set active"}
      </button>
      {msg ? <p className="max-w-3xl whitespace-pre-wrap font-mono text-xs text-[var(--wms-muted)]">{msg}</p> : null}
    </div>
  );
}
