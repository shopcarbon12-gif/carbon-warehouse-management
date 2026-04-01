"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Radio, ScanLine, Shuffle } from "lucide-react";
import { TransferCommitModal, type StagedRow } from "./transfer-commit-modal";

type LocationRow = { id: string; code: string; name: string };
type BinRow = { id: string; code: string; in_stock_count: number };
type LookupRow = {
  epc: string;
  sku: string;
  location_id: string;
  location_code: string;
  bin_id: string | null;
  bin_code: string | null;
  status: string;
};

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

async function postLookup(epcs: string[]): Promise<LookupRow[]> {
  const res = await fetch("/api/operations/transfers/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ epcs }),
  });
  const data = (await res.json()) as { error?: string; rows?: LookupRow[] };
  if (!res.ok) throw new Error(data.error ?? "Lookup failed");
  return data.rows ?? [];
}

export function TransferWorkspace() {
  const [destLocationId, setDestLocationId] = useState("");
  const [destBinId, setDestBinId] = useState("");
  const [scanning, setScanning] = useState(false);
  const [staged, setStaged] = useState<LookupRow[]>([]);
  const [commitOpen, setCommitOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [manualEpc, setManualEpc] = useState("");

  const { data: locData } = useSWR<LocationRow[]>("/api/locations", fetcher);
  const locations = locData ?? [];

  const destBinsUrl =
    destLocationId.length > 0
      ? `/api/locations/bins?locationId=${encodeURIComponent(destLocationId)}`
      : null;
  const { data: destBins } = useSWR<BinRow[]>(destBinsUrl, fetcher);

  const mergeRows = useCallback((existing: LookupRow[], incoming: LookupRow[]) => {
    const map = new Map<string, LookupRow>();
    for (const r of existing) map.set(r.epc, r);
    for (const r of incoming) map.set(r.epc, r);
    return [...map.values()];
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/edge/stream");
    es.onmessage = (ev) => {
      if (!ev.data?.trim() || ev.data.startsWith(":")) return;
      let p: { scanContext?: string; epcs?: string[] };
      try {
        p = JSON.parse(ev.data) as { scanContext?: string; epcs?: string[] };
      } catch {
        return;
      }
      if ((p.scanContext ?? "").toUpperCase() !== "TRANSFER") return;
      const list = (p.epcs ?? [])
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => /^[0-9A-F]{24}$/.test(e));
      if (list.length === 0) return;
      void (async () => {
        try {
          const rows = await postLookup(list);
          if (rows.length === 0) return;
          setStaged((s) => mergeRows(s, rows));
          setScanning(true);
        } catch {
          /* ignore transient lookup errors */
        }
      })();
    };
    return () => es.close();
  }, [mergeRows]);

  const simulateScan = useCallback(async () => {
    setToast(null);
    try {
      const res = await fetch("/api/operations/transfers/sim-seeds?limit=5");
      const data = (await res.json()) as { error?: string; rows?: LookupRow[] };
      if (!res.ok) throw new Error(data.error ?? "Sim failed");
      const rows = data.rows ?? [];
      if (rows.length === 0) {
        setToast("No in-stock tags at this location to simulate.");
        return;
      }
      setStaged((s) => mergeRows(s, rows));
      setScanning(true);
      setToast(`Staged ${rows.length} tag(s) from simulation.`);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Simulation failed");
    }
  }, [mergeRows]);

  const addManualEpc = useCallback(async () => {
    const e = manualEpc.replace(/\s/g, "").toUpperCase();
    if (!/^[0-9A-F]{24}$/.test(e)) {
      setToast("Enter a 24-character hex EPC.");
      return;
    }
    setToast(null);
    try {
      const rows = await postLookup([e]);
      if (rows.length === 0) {
        setToast("EPC not found in tenant.");
        return;
      }
      setStaged((s) => mergeRows(s, rows));
      setManualEpc("");
      setScanning(true);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Lookup failed");
    }
  }, [manualEpc, mergeRows]);

  const stagedTable: StagedRow[] = useMemo(
    () =>
      staged.map((r) => ({
        epc: r.epc,
        sku: r.sku,
        location_code: r.location_code,
      })),
    [staged],
  );

  const destLabel = useMemo(() => {
    const l = locations.find((x) => x.id === destLocationId);
    const b = (destBins ?? []).find((x) => x.id === destBinId);
    if (!l || !b) return "—";
    return `${l.code} / ${b.code}`;
  }, [locations, destBins, destLocationId, destBinId]);

  const doCommit = useCallback(async () => {
    if (!destLocationId || !destBinId) throw new Error("Select destination location and bin.");
    const epcs = staged.map((r) => r.epc);
    if (epcs.length === 0) throw new Error("No EPCs staged.");
    const res = await fetch("/api/operations/transfers/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destinationLocationId: destLocationId,
        destinationBinId: destBinId,
        epcs,
      }),
    });
    const data = (await res.json()) as { error?: string; moved?: number };
    if (!res.ok) throw new Error(data.error ?? "Commit failed");
    setToast(`Transferred ${data.moved ?? epcs.length} item(s). rfid_transfer audit written.`);
    setStaged([]);
    setScanning(false);
  }, [destLocationId, destBinId, staged]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-4 sm:grid-cols-2">
        <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
          Destination location
          <select
            value={destLocationId}
            onChange={(e) => {
              setDestLocationId(e.target.value);
              setDestBinId("");
            }}
            className="mt-1 w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
          >
            <option value="">— Select —</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code} — {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
          Destination bin
          <select
            value={destBinId}
            onChange={(e) => setDestBinId(e.target.value)}
            disabled={!destLocationId}
            className="mt-1 w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)] disabled:opacity-40"
          >
            <option value="">— Select bin —</option>
            {(destBins ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.code}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <button
            type="button"
            onClick={() => {
              setScanning((s) => !s);
              if (scanning) setStaged([]);
            }}
            className={`inline-flex min-h-[3rem] min-w-[10rem] items-center justify-center gap-2 rounded-xl border px-5 py-3 font-mono text-sm font-semibold uppercase tracking-wide transition-colors ${
              scanning
                ? "border-amber-500/60 bg-amber-950/40 text-amber-100"
                : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)] hover:border-teal-500/40"
            }`}
          >
            <Radio className={`h-5 w-5 ${scanning ? "text-amber-400" : "text-[var(--wms-muted)]"}`} />
            {scanning ? "Scanning…" : "Start scan"}
          </button>
          <button
            type="button"
            onClick={() => void simulateScan()}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-2.5 font-mono text-xs text-[var(--wms-fg)] hover:border-violet-500/40"
          >
            <Shuffle className="h-4 w-4" />
            Simulate scan
          </button>
          <button
            type="button"
            disabled={staged.length === 0}
            onClick={() => {
              setStaged([]);
              setScanning(false);
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-border)] px-4 py-2.5 font-mono text-xs text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40"
          >
            <ScanLine className="h-4 w-4" />
            Clear staged
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <input
            type="text"
            value={manualEpc}
            onChange={(e) => setManualEpc(e.target.value)}
            placeholder="Manual EPC (24 hex)"
            className="min-w-[12rem] flex-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)]"
          />
          <button
            type="button"
            onClick={() => void addManualEpc()}
            className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] hover:border-teal-500/40"
          >
            Add EPC
          </button>
        </div>
        <p className="mt-2 font-mono text-[0.6rem] text-[var(--wms-muted)]">
          Live handheld batches with scanContext{" "}
          <span className="text-teal-400/90">TRANSFER</span> (same location as your session) stream in
          over SSE and stage here. Simulated reads use in-stock tags at your active session location.
          Commit moves staged EPCs to the destination bin and logs{" "}
          <span className="text-orange-400/80">rfid_transfer</span>.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80">
        <div className="border-b border-[var(--wms-border)] px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
          Staged payload ({staged.length})
        </div>
        <div className="max-h-[min(50vh,400px)] overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase text-[var(--wms-muted)]">
              <tr>
                <th className="px-3 py-2">EPC</th>
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">Current location</th>
                <th className="px-3 py-2">Bin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-[0.65rem] text-[var(--wms-fg)]">
              {staged.map((r) => (
                <tr key={r.epc}>
                  <td className="px-3 py-2 text-teal-400/85">{r.epc}</td>
                  <td className="px-3 py-2">{r.sku}</td>
                  <td className="px-3 py-2 text-amber-400/80">{r.location_code}</td>
                  <td className="px-3 py-2 text-[var(--wms-muted)]">{r.bin_code ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {staged.length === 0 ? (
            <p className="p-6 text-center font-mono text-xs text-[var(--wms-muted)]">
              Stage tags via edge stream, simulate, manual EPC, or reader SDK.
            </p>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        disabled={
          staged.length === 0 || !destLocationId || !destBinId
        }
        onClick={() => setCommitOpen(true)}
        className="rounded-lg border border-orange-600/50 bg-orange-950/30 px-5 py-2.5 font-mono text-sm text-orange-200 hover:bg-orange-900/25 disabled:opacity-40"
      >
        Review & transfer
      </button>

      {toast ? <p className="font-mono text-xs text-[var(--wms-muted)]">{toast}</p> : null}

      <TransferCommitModal
        open={commitOpen}
        onClose={() => setCommitOpen(false)}
        rows={stagedTable}
        destinationLabel={destLabel}
        onConfirm={doCommit}
      />
    </div>
  );
}
