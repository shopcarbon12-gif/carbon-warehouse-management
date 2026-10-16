"use client";

import { useState } from "react";
import { FileSpreadsheet, FileText, Radar } from "lucide-react";

const btn =
  "inline-flex items-center gap-1 rounded border border-[var(--wms-accent)]/45 bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] px-2 py-1 font-mono text-[0.6rem] max-md:text-xs max-md:min-h-11 max-md:px-3 font-medium text-[var(--wms-accent)] hover:opacity-90 disabled:opacity-50";

type ReportJson = { unknown?: { epc: string; statusNow: string }[]; error?: string };

/**
 * The end-of-count report (owner, 2026-10-16): Excel / PDF (summary, every NEW
 * Unknown tag with all its information, defective tags) and CLOUD + GEIGER —
 * the count's Unknown tags still waiting go to every handheld at the active
 * location, to be found and changed to LIVE.
 */
export function CountReportActions({ kind, id }: { kind: "cycle_count" | "phone"; id: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const base = `/api/reports/count-report?kind=${kind}&id=${encodeURIComponent(id)}`;

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(base, { cache: "no-store" });
      const j = (await res.json().catch(() => ({}))) as ReportJson;
      if (!res.ok) throw new Error(j.error ?? "Report failed");
      const epcs = (j.unknown ?? []).filter((u) => u.statusNow.startsWith("Unknown")).map((u) => u.epc);
      if (epcs.length === 0) {
        setMsg("No Unknown tags waiting in this count.");
        return;
      }
      if (!window.confirm(`Send ${epcs.length} Unknown tag${epcs.length === 1 ? "" : "s"} to every handheld's Cloud + Geiger?`)) return;
      const q = await fetch("/api/handhelds/epc-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epcs }),
      });
      const r = (await q.json().catch(() => ({}))) as { handhelds?: number; warning?: string; error?: string };
      if (!q.ok) throw new Error(r.error ?? "Send failed");
      setMsg(r.warning ?? `Sent ${epcs.length} to ${r.handhelds ?? 0} handheld${r.handhelds === 1 ? "" : "s"}.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      <a href={`${base}&format=xlsx`} className={btn} title="Count report — summary, NEW Unknown tags, defective (Excel)">
        <FileSpreadsheet className="h-3 w-3 max-md:h-4 max-md:w-4" />
        Excel
      </a>
      <a href={`${base}&format=pdf`} className={btn} title="Count report — summary, NEW Unknown tags, defective (PDF)">
        <FileText className="h-3 w-3 max-md:h-4 max-md:w-4" />
        PDF
      </a>
      <button type="button" onClick={() => void send()} disabled={busy} className={btn} title="Send this count's Unknown tags to every handheld's Cloud + Geiger">
        <Radar className="h-3 w-3 max-md:h-4 max-md:w-4" />
        {busy ? "Sending…" : "Cloud + Geiger"}
      </button>
      {msg ? <span className="basis-full text-right font-mono text-[0.6rem] text-[var(--wms-muted)]">{msg}</span> : null}
    </span>
  );
}
