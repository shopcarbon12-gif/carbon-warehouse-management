"use client";

import useSWR from "swr";

/**
 * The converted email as a customer gets it, inside a fully sandboxed frame
 * (no scripts, no same-origin). The HTML is fetched with the admin's session
 * and handed to the frame as srcDoc, so the frame itself needs no cookie.
 */
const text = async (u: string) => {
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};

export function EmailPreviewFrames({ designId, version, height = 720 }: { designId: string; version?: string; height?: number }) {
  const { data, error } = useSWR(`/api/email/designs/${designId}/preview${version ? `?v=${encodeURIComponent(version)}` : ""}`, text);
  if (error) return <p className="text-xs text-[var(--wms-status-danger-fg)]">Preview failed: {error.message}</p>;
  if (data === undefined) return <p className="text-xs text-[var(--wms-muted)]">Loading preview…</p>;
  return (
    <div className="flex min-w-0 gap-3 overflow-x-auto pb-1">
      {(
        [
          ["Desktop (600 px)", 640],
          ["Phone (375 px)", 375],
        ] as const
      ).map(([l, w]) => (
        <div key={l} className="flex shrink-0 flex-col gap-1">
          <span className="font-mono text-[0.66rem] font-semibold uppercase tracking-wide text-[var(--wms-muted)]">{l}</span>
          <iframe title={l} sandbox="" srcDoc={data} style={{ width: w, height }} className="max-w-[85vw] rounded border border-[var(--wms-border)] bg-white" />
        </div>
      ))}
    </div>
  );
}
