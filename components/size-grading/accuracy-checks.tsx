"use client";

/**
 * Accuracy checks the CarbonGradingAI app saved: a rigid object of known size
 * measured corner to corner. Diagnostic only — a drift shows here over time,
 * and nothing on this list changes how scans are scaled.
 */

import { Fragment, useState } from "react";
import useSWR from "swr";
import { Loader2, Move, Save, X } from "lucide-react";

import { LineEditor } from "@/components/size-grading/line-editor";

import { STORE_TZ } from "@/lib/orlando-time";
import { staffLabel } from "@/lib/staff-name";

type Check = {
  id: string;
  true_w_cm: number;
  true_h_cm: number;
  measured_w_cm: number;
  measured_h_cm: number;
  measured_diag_cm: number;
  depth: Record<string, unknown> | null;
  app_version: string | null;
  device_model: string | null;
  note: string | null;
  corners: [number, number][] | null;
  px_per_cm: number | null;
  photo_w: number | null;
  photo_h: number | null;
  has_photo: boolean;
  created_at: string;
  by_email: string | null;
};

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error ?? "Failed to load");
  return j;
};

const WHEN = new Intl.DateTimeFormat("en-US", {
  timeZone: STORE_TZ,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Measured vs true, the error in cm and %, coloured past 1%. */
function Err({ measured, truth }: { measured: number; truth: number }) {
  const d = measured - truth;
  const pct = (d / truth) * 100;
  const off = Math.abs(pct) >= 1;
  return (
    <span className="whitespace-nowrap">
      {measured.toFixed(1)} / {truth.toFixed(1)}{" "}
      <span className={off ? "text-[var(--wms-status-warning-fg)]" : "text-[var(--wms-status-success-fg)]"}>
        ({d >= 0 ? "+" : ""}
        {d.toFixed(1)} cm, {pct >= 0 ? "+" : ""}
        {pct.toFixed(1)}%)
      </span>
    </span>
  );
}

const sizesOf = (c: [number, number][], ppc: number) => {
  const d = (i: number, j: number) => Math.hypot(c[j][0] - c[i][0], c[j][1] - c[i][1]) / ppc;
  return { w: (d(0, 1) + d(3, 2)) / 2, h: (d(0, 3) + d(1, 2)) / 2, d: (d(0, 2) + d(1, 3)) / 2 };
};

/** One check's photo with its four corners, movable; Save works the sizes out again. */
function CheckPhoto({ c, onSaved, onClose }: { c: Check; onSaved: () => Promise<unknown>; onClose: () => void }) {
  const [corners, setCorners] = useState<[number, number][]>(c.corners ?? []);
  const [trueW, setTrueW] = useState(String(c.true_w_cm));
  const [trueH, setTrueH] = useState(String(c.true_h_cm));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ppc = c.px_per_cm ?? 0;
  const live = corners.length === 4 && ppc > 0 ? sizesOf(corners, ppc) : null;
  const tw = Number(trueW.replace(",", "."));
  const th = Number(trueH.replace(",", "."));
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/grading-app/accuracy-checks/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ corners: editing ? corners : undefined, trueW: tw > 0 ? tw : undefined, trueH: th > 0 ? th : undefined }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Could not save");
      setEditing(false);
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };
  const btn = "inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] px-3 py-1.5 text-sm text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40 max-md:min-h-11";
  return (
    <div className="flex flex-col gap-2 p-2">
      {c.has_photo && c.photo_w && c.photo_h && corners.length === 4 ? (
        <div className="max-w-2xl">
          <LineEditor
            src={`/api/grading-app/accuracy-checks/${c.id}/photo`}
            alt="Accuracy check photo"
            width={c.photo_w}
            height={c.photo_h}
            lines={{ box: { pts: corners, color: "#f472b6", closed: true } }}
            selected={null}
            editing={editing}
            onMove={(_k, i, to) => setCorners((cs) => cs.map((p, j) => (j === i ? to : p)))}
          />
        </div>
      ) : (
        <p className="text-sm text-[var(--wms-muted)]">This check was saved before photos were kept (app 1.0.7) — only the true size can be corrected.</p>
      )}
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1 text-xs text-[var(--wms-muted)]">
          True width, cm
          <input value={trueW} onChange={(e) => setTrueW(e.target.value)} inputMode="decimal" className="w-24 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-mono text-[var(--wms-fg)] max-md:min-h-11" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--wms-muted)]">
          True height, cm
          <input value={trueH} onChange={(e) => setTrueH(e.target.value)} inputMode="decimal" className="w-24 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-mono text-[var(--wms-fg)] max-md:min-h-11" />
        </label>
        {live && tw > 0 && th > 0 ? (
          <span className="font-mono text-xs text-[var(--wms-fg)]">
            W <Err measured={live.w} truth={tw} /> · H <Err measured={live.h} truth={th} /> · D <Err measured={live.d} truth={Math.hypot(tw, th)} />
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {corners.length === 4 && c.has_photo && !editing ? (
          <button type="button" className={btn} onClick={() => setEditing(true)}>
            <Move className="h-4 w-4" /> Move the corners
          </button>
        ) : null}
        <button type="button" className={btn} onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
        </button>
        <button type="button" className={btn} onClick={onClose}>
          <X className="h-4 w-4" /> Close
        </button>
        {err ? <span className="text-sm text-[var(--wms-status-danger-fg)]">{err}</span> : null}
      </div>
    </div>
  );
}

export function AccuracyChecks() {
  const { data, error, isLoading, mutate } = useSWR<{ checks: Check[] }>("/api/grading-app/accuracy-checks", fetcher);
  const checks = data?.checks ?? [];
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="text-sm font-semibold text-[var(--wms-fg)]">Accuracy checks</h2>
      <p className="max-w-2xl font-mono text-xs text-[var(--wms-muted)]">
        From the app&apos;s Settings › Check accuracy: a flat, rigid object of known size measured corner to corner
        (measured / true). For watching drift only — the app never corrects its scale from a check. Click a row to see its photo
        and move the corners.
      </p>
      {error ? (
        <p className="text-sm text-[var(--wms-status-danger-fg)]">
          Could not load the checks — {error instanceof Error ? error.message : String(error)}
        </p>
      ) : isLoading ? (
        <p className="flex items-center gap-2 text-sm text-[var(--wms-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : !checks.length ? (
        <p className="text-sm text-[var(--wms-muted)]">No checks saved yet.</p>
      ) : (
        <div className="min-w-0 overflow-x-auto rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)]">
          <table className="w-full text-left text-sm tabular-nums">
            <thead className="text-xs text-[var(--wms-muted)]">
              <tr className="border-b border-[var(--wms-border)]">
                <th className="p-2 font-medium">When</th>
                <th className="p-2 font-medium">Width</th>
                <th className="p-2 font-medium">Height</th>
                <th className="p-2 font-medium">Diagonal</th>
                <th className="p-2 font-medium">Depth</th>
                <th className="p-2 font-medium">Phone</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--wms-border)] text-[var(--wms-fg)]">
              {checks.map((c) => {
                const d = c.depth ?? {};
                const depth = [
                  n(d.distanceCm) !== null ? `${n(d.distanceCm)!.toFixed(0)} cm away` : null,
                  n(d.tiltDeg) !== null ? `tilt ${n(d.tiltDeg)!.toFixed(1)}°` : null,
                  n(d.depthAgeMs) !== null ? `age ${n(d.depthAgeMs)!.toFixed(0)} ms` : null,
                  n(d.highConfPct) !== null ? `${n(d.highConfPct)!.toFixed(0)}% confident` : null,
                  n(d.planeRmsMm) !== null ? `RMS ${n(d.planeRmsMm)!.toFixed(1)} mm` : null,
                ].filter(Boolean);
                const who = staffLabel(null, null, c.by_email);
                return (
                  <Fragment key={c.id}>
                  <tr className="cursor-pointer align-top hover:bg-[var(--wms-surface-elevated)]/50" onClick={() => setOpen((o) => (o === c.id ? null : c.id))} title="Open the photo and corners">
                    <td className="p-2 whitespace-nowrap">
                      {WHEN.format(new Date(c.created_at))}
                      {who ? <span className="block text-xs text-[var(--wms-muted)]">{who}</span> : null}
                    </td>
                    <td className="p-2">
                      <Err measured={c.measured_w_cm} truth={c.true_w_cm} />
                    </td>
                    <td className="p-2">
                      <Err measured={c.measured_h_cm} truth={c.true_h_cm} />
                    </td>
                    <td className="p-2">
                      <Err measured={c.measured_diag_cm} truth={Math.hypot(c.true_w_cm, c.true_h_cm)} />
                    </td>
                    <td className="p-2 text-xs text-[var(--wms-muted)]">{depth.join(" · ") || "—"}</td>
                    <td className="p-2 text-xs text-[var(--wms-muted)]">
                      {[c.device_model, c.app_version ? `v${c.app_version}` : null].filter(Boolean).join(" · ") || "—"}
                      {c.note ? <span className="block text-[var(--wms-fg)]">{c.note}</span> : null}
                    </td>
                  </tr>
                  {open === c.id ? (
                    <tr>
                      <td colSpan={6}>
                        <CheckPhoto c={c} onSaved={() => mutate()} onClose={() => setOpen(null)} />
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
