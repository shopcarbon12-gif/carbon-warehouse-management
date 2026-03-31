"use client";

import { useRouter } from "next/navigation";
import { useCallback, useId, useRef, useState } from "react";

export type MobileReleaseRow = {
  id: number;
  version_label: string;
  apk_url: string;
  is_active: boolean;
  created_at: string;
};

export function MobileUpdatesWorkspace({ initialReleases }: { initialReleases: MobileReleaseRow[] }) {
  const router = useRouter();
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
      if (!res.ok) {
        const base = j.error ?? `Upload failed (${res.status})`;
        let hint = "";
        if (typeof base === "string") {
          if (base.includes("Database unavailable")) {
            hint =
              " Set DATABASE_URL on the WMS Coolify app to your Postgres internal URL, save, redeploy. See docs/WORKER.md (Database URL on the WMS web app).";
          } else if (base.includes("Expected multipart form")) {
            hint =
              " Redeploy after pulling next.config proxyClientMaxBodySize (APK > default proxy buffer). If it persists, raise Traefik/Coolify client max body size.";
          }
        }
        throw new Error(`${base}${hint}`);
      }
      const abs = j.apkUrlAbsolute ?? j.apkUrl ?? "(ok)";
      setMsg(`Saved. Active release: ${abs}. Handhelds will see this on the next /api/mobile/status poll.`);
      setFile(null);
      setInputKey((k) => k + 1);
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const [activatingId, setActivatingId] = useState<number | null>(null);

  const setActive = async (releaseId: number) => {
    setActivatingId(releaseId);
    setMsg(null);
    try {
      const res = await fetch("/api/mobile/releases/set-active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseId }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setMsg("Marked release as active. Handhelds will pick it up on the next status check.");
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed to set active");
    } finally {
      setActivatingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {initialReleases.length > 0 ? (
        <div className="rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-4 dark:border-[var(--wms-border)]">
          <h2 className="font-mono text-[0.65rem] font-semibold uppercase tracking-wide text-[var(--wms-muted)]">
            Releases for this tenant
          </h2>
          <ul className="mt-3 divide-y divide-[var(--wms-border)] font-mono text-xs">
            {initialReleases.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="text-[var(--wms-fg)]">{r.version_label}</span>
                {r.is_active ? (
                  <span className="rounded bg-[var(--wms-accent)]/20 px-2 py-0.5 text-[0.65rem] text-[var(--wms-accent)]">
                    active
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={activatingId !== null}
                    onClick={() => void setActive(r.id)}
                    className="rounded border border-[var(--wms-border)] px-2 py-0.5 text-[0.65rem] text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50"
                  >
                    {activatingId === r.id ? "…" : "Set active"}
                  </button>
                )}
                <span className="min-w-0 flex-1 truncate text-[var(--wms-muted)]" title={r.apk_url}>
                  {r.apk_url}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="font-mono text-xs text-[var(--wms-muted)]">
          No releases in the database for this tenant yet. Upload an APK above (or confirm you are in the correct warehouse /
          tenant).
        </p>
      )}
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
      <p className="max-w-2xl font-mono text-[0.65rem] leading-relaxed text-[var(--wms-muted)]">
        <strong className="text-[var(--wms-fg)]">Docker / Coolify:</strong> APK files live on the container disk. A new
        deploy without a <strong>persistent volume</strong> on <span className="font-mono">/app/public/uploads</span>{" "}
        removes old uploads — handhelds then get <strong>404</strong> on the OTA URL until you upload again. Mount a
        volume on that path (or re-upload after each deploy).
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
