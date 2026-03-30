"use client";

import useSWR from "swr";
import { useMemo, useState } from "react";

type SlipRow = {
  slip_number: number;
  source_loc: string;
  dest_loc: string;
  status: string;
  ls_transfer_id: string | null;
  created_at: string;
};

type ExportResponse = { slipNumber: number; rows: { epc: string; alu: string; name: string; sent: number; received: number; missing: number }[] };

const listFetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load slips");
  return res.json() as Promise<SlipRow[]>;
};

function toCsv(rows: ExportResponse["rows"]) {
  const h = ["ALU", "Name", "Sent", "Received", "Missing", "EPC"];
  const lines = [h.join(",")];
  for (const r of rows) {
    lines.push(
      [r.alu, `"${(r.name || "").replace(/"/g, '""')}"`, r.sent, r.received, r.missing, r.epc].join(","),
    );
  }
  return lines.join("\n");
}

export function TransferSlipsWorkspace({ mode }: { mode: "out" | "in" }) {
  const { data, error, mutate } = useSWR("/api/inventory/transfer-slips", listFetcher);
  const [sourceLoc, setSourceLoc] = useState("");
  const [destLoc, setDestLoc] = useState("");
  const [epcsRaw, setEpcsRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [selectedSlip, setSelectedSlip] = useState<number | null>(null);

  const slips = data ?? [];

  const blurb =
    mode === "out"
      ? "Create a slip, add EPCs (optional), then export CSV for the floor. Slip numbers are assigned from 70000+."
      : "Open an existing slip and export receiving progress. Reconcile counts on the handheld, then update statuses in admin when complete.";

  const createSlip = async () => {
    if (!sourceLoc.trim() || !destLoc.trim()) {
      setMsg("Source and destination are required.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const epcs = epcsRaw
        .split(/[\s,;\n]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      const res = await fetch("/api/inventory/transfer-slips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceLoc: sourceLoc.trim(),
          destLoc: destLoc.trim(),
          epcs: epcs.length ? epcs : undefined,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { slipNumber?: number; error?: string };
      if (!res.ok) throw new Error(j.error ?? "Create failed");
      setMsg(`Created slip #${j.slipNumber ?? "?"}`);
      setEpcsRaw("");
      await mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const downloadCsv = async (slipNumber: number) => {
    const res = await fetch(`/api/inventory/transfer-slips/${slipNumber}?export=csv`);
    if (!res.ok) {
      setMsg("Export failed");
      return;
    }
    const j = (await res.json()) as ExportResponse;
    const blob = new Blob([toCsv(j.rows)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `transfer-slip-${slipNumber}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const printSlip = async (slipNumber: number) => {
    const res = await fetch(`/api/inventory/transfer-slips/${slipNumber}?export=csv`);
    if (!res.ok) return;
    const j = (await res.json()) as ExportResponse;
    const rows = j.rows
      .map(
        (r) =>
          `<tr><td>${r.alu}</td><td>${r.name}</td><td>${r.sent}</td><td>${r.received}</td><td>${r.missing}</td><td class="mono">${r.epc}</td></tr>`,
      )
      .join("");
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><title>Slip ${slipNumber}</title>
      <style>body{font-family:system-ui;padding:24px;} table{border-collapse:collapse;width:100%;} th,td{border:1px solid #ccc;padding:6px;font-size:12px;} th{background:#eee}.mono{font-family:monospace;font-size:11px;}</style></head><body>
      <h1>Transfer slip ${slipNumber}</h1>
      <table><thead><tr><th>ALU</th><th>Name</th><th>Sent</th><th>Received</th><th>Missing</th><th>EPC</th></tr></thead><tbody>${rows}</tbody></table>
      <script>window.onload=function(){window.print();}</script>
      </body></html>`);
    w.document.close();
  };

  const sorted = useMemo(() => [...slips].sort((a, b) => b.slip_number - a.slip_number), [slips]);

  return (
    <div className="flex flex-col gap-6">
      <p className="font-mono text-xs text-[var(--wms-muted)]">{blurb}</p>
      {error ? <p className="font-mono text-xs text-red-500/90">{(error as Error).message}</p> : null}
      {msg ? <p className="font-mono text-xs text-[var(--wms-muted)]">{msg}</p> : null}

      {mode === "out" ? (
        <div className="grid gap-4 rounded-xl border border-[var(--wms-border)] p-4 dark:border-[var(--wms-border)] md:grid-cols-2">
          <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
            Source location code
            <input
              value={sourceLoc}
              onChange={(e) => setSourceLoc(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
            Destination location code
            <input
              value={destLoc}
              onChange={(e) => setDestLoc(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="font-mono text-[0.65rem] uppercase text-[var(--wms-muted)] md:col-span-2">
            EPCs (optional, whitespace-separated)
            <textarea
              value={epcsRaw}
              onChange={(e) => setEpcsRaw(e.target.value)}
              rows={4}
              className="mt-1 w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => void createSlip()}
            className="w-fit rounded-lg bg-[var(--wms-accent)] px-4 py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] disabled:opacity-50 md:col-span-2"
          >
            Generate transfer slip
          </button>
        </div>
      ) : null}

      <div>
        <h2 className="mb-2 font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">Slips</h2>
        <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] dark:border-[var(--wms-border)]">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase text-[var(--wms-muted)]">
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Dest</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">LS</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--wms-border)]/80">
              {sorted.map((s) => (
                <tr key={s.slip_number} className={selectedSlip === s.slip_number ? "bg-[var(--wms-surface-elevated)]/80" : ""}>
                  <td className="px-3 py-2 font-mono text-xs">{s.slip_number}</td>
                  <td className="px-3 py-2 font-mono text-xs">{s.source_loc}</td>
                  <td className="px-3 py-2 font-mono text-xs">{s.dest_loc}</td>
                  <td className="px-3 py-2">{s.status}</td>
                  <td className="px-3 py-2 font-mono text-xs">{s.ls_transfer_id ?? "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" className="mr-2 font-mono text-xs text-blue-500 hover:underline" onClick={() => setSelectedSlip(s.slip_number)}>
                      Select
                    </button>
                    <button type="button" className="mr-2 font-mono text-xs text-teal-600 hover:underline" onClick={() => void downloadCsv(s.slip_number)}>
                      CSV
                    </button>
                    <button type="button" className="font-mono text-xs text-[var(--wms-muted)] hover:underline" onClick={() => void printSlip(s.slip_number)}>
                      PDF/Print
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
