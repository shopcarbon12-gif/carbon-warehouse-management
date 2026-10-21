"use client";

/**
 * Accuracy checks the CarbonGradingAI app saved: a rigid object of known size
 * measured corner to corner. Diagnostic only — a drift shows here over time,
 * and nothing on this list changes how scans are scaled.
 */

import useSWR from "swr";
import { Loader2 } from "lucide-react";

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

export function AccuracyChecks() {
  const { data, error, isLoading } = useSWR<{ checks: Check[] }>("/api/grading-app/accuracy-checks", fetcher);
  const checks = data?.checks ?? [];

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="text-sm font-semibold text-[var(--wms-fg)]">Accuracy checks</h2>
      <p className="max-w-2xl font-mono text-xs text-[var(--wms-muted)]">
        From the app&apos;s Settings › Check accuracy: a flat, rigid object of known size measured corner to corner
        (measured / true). For watching drift only — the app never corrects its scale from a check.
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
                  <tr key={c.id} className="align-top">
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
