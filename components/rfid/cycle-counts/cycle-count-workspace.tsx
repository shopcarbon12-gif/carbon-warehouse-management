"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { Radio, ScanLine, Shuffle } from "lucide-react";
import {
  CycleCountCommitModal,
  type VarianceSummary,
} from "./cycle-count-commit-modal";

type LocationRow = { id: string; code: string; name: string };
type BinRow = { id: string; code: string; in_stock_count: number };
type ExpectedRow = {
  epc: string;
  sku: string;
  ls_system_id: string;
  upc: string;
  description: string;
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

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function classify(
  expected: ExpectedRow[],
  scanned: string[],
  misplacedSeed: Set<string>,
  unrecognizedSeed: Set<string>,
) {
  const exp = new Set(expected.map((e) => e.epc));
  const sc = new Set(scanned.map((s) => s.replace(/\s/g, "").toUpperCase()));
  const matched = [...exp].filter((e) => sc.has(e));
  const missing = [...exp].filter((e) => !sc.has(e));
  const extras = [...sc].filter((e) => !exp.has(e));
  const misplaced: string[] = [];
  const unrecognized: string[] = [];
  for (const e of extras) {
    if (misplacedSeed.has(e)) misplaced.push(e);
    else if (unrecognizedSeed.has(e)) unrecognized.push(e);
    else unrecognized.push(e);
  }
  return { matched, missing, misplaced, unrecognized };
}

type RowState = "matched" | "missing" | "misplaced" | "unrecognized";

export function CycleCountWorkspace() {
  const [locationId, setLocationId] = useState("");
  const [binId, setBinId] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState<string[]>([]);
  const [misplacedSeed, setMisplacedSeed] = useState<Set<string>>(() => new Set());
  const [unrecognizedSeed, setUnrecognizedSeed] = useState<Set<string>>(
    () => new Set(),
  );
  const [commitOpen, setCommitOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const { data: locData } = useSWR<{ id: string; code: string; name: string }[]>(
    "/api/locations",
    fetcher,
  );
  const locations: LocationRow[] = locData ?? [];

  const binsUrl =
    locationId.length > 0
      ? `/api/locations/bins?locationId=${encodeURIComponent(locationId)}`
      : null;
  const { data: binRows } = useSWR<BinRow[]>(binsUrl, fetcher);

  const expectedUrl =
    locationId.length > 0
      ? `/api/rfid/cycle-counts/expected?locationId=${encodeURIComponent(locationId)}${binId ? `&binId=${encodeURIComponent(binId)}` : ""}`
      : null;
  const { data: expectedPayload, mutate: mutateExpected } = useSWR<{
    expected: ExpectedRow[];
  }>(expectedUrl, fetcher);

  const expected = expectedPayload?.expected ?? [];

  const resetScans = useCallback(() => {
    setScanned([]);
    setMisplacedSeed(new Set());
    setUnrecognizedSeed(new Set());
  }, []);

  const c = useMemo(
    () => classify(expected, scanned, misplacedSeed, unrecognizedSeed),
    [expected, scanned, misplacedSeed, unrecognizedSeed],
  );

  const kpi: VarianceSummary = useMemo(
    () => ({
      matched: c.matched.length,
      missing: c.missing.length,
      misplaced: c.misplaced.length,
      unrecognized: c.unrecognized.length,
    }),
    [c],
  );

  const simulateScan = useCallback(async () => {
    if (!locationId || expected.length === 0) {
      setToast("Select a location and load expected tags first.");
      return;
    }
    setToast(null);
    try {
      const simRes = await fetch(
        `/api/rfid/cycle-counts/sim-seeds?locationId=${encodeURIComponent(locationId)}${binId ? `&binId=${encodeURIComponent(binId)}` : ""}`,
      );
      if (!simRes.ok) {
        const j = (await simRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Sim seeds failed");
      }
      const sim = (await simRes.json()) as {
        misplaced: string[];
        unrecognized: string[];
      };
      const shuffled = shuffle(expected);
      const n = Math.max(1, Math.floor(expected.length * 0.9));
      const take = shuffled.slice(0, n).map((r) => r.epc);
      const mis = sim.misplaced.map((e) => e.replace(/\s/g, "").toUpperCase());
      const un = sim.unrecognized.map((e) => e.replace(/\s/g, "").toUpperCase());
      setMisplacedSeed(new Set(mis));
      setUnrecognizedSeed(new Set(un));
      setScanned([...take, ...mis, ...un]);
      setScanning(true);
      setToast("Simulated scan loaded (≈90% matched + misplaced + ghost).");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Simulation failed");
    }
  }, [locationId, binId, expected]);

  const doCommit = useCallback(async () => {
    if (c.misplaced.length > 0 && !binId) {
      throw new Error("Select a bin before committing misplaced tags.");
    }
    const res = await fetch("/api/rfid/cycle-counts/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locationId,
        binId: binId || null,
        matched: c.matched,
        missing: c.missing,
        misplaced: c.misplaced,
        unrecognized: c.unrecognized,
      }),
    });
    const data = (await res.json()) as { error?: string; ok?: boolean };
    if (!res.ok) throw new Error(data.error ?? "Commit failed");
    setToast(
      `Committed — missing updated: ${(data as { updated_missing?: number }).updated_missing ?? 0}, misplaced moves: ${(data as { updated_misplaced?: number }).updated_misplaced ?? 0}`,
    );
    resetScans();
    setScanning(false);
    await mutateExpected();
  }, [binId, c, locationId, mutateExpected, resetScans]);

  const scanSet = useMemo(
    () => new Set(scanned.map((s) => s.replace(/\s/g, "").toUpperCase())),
    [scanned],
  );

  const gridRows = useMemo(() => {
    const map = new Map<string, ExpectedRow>();
    for (const r of expected) map.set(r.epc, r);
    const seen = new Set<string>();
    const rows: {
      epc: string;
      sku: string;
      bin: string;
      expected: boolean;
      scanned: boolean;
      state: RowState;
    }[] = [];

    for (const r of expected) {
      seen.add(r.epc);
      const isScanned = scanSet.has(r.epc);
      rows.push({
        epc: r.epc,
        sku: r.sku,
        bin: r.bin_code ?? "—",
        expected: true,
        scanned: isScanned,
        state: isScanned ? "matched" : "missing",
      });
    }

    for (const epc of scanSet) {
      if (seen.has(epc)) continue;
      seen.add(epc);
      const st: RowState = c.misplaced.includes(epc) ? "misplaced" : "unrecognized";
      const base = map.get(epc);
      rows.push({
        epc,
        sku: base?.sku ?? "—",
        bin: base?.bin_code ?? "—",
        expected: false,
        scanned: true,
        state: st,
      });
    }

    return rows;
  }, [expected, scanSet, c]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 rounded-lg border border-slate-800 bg-zinc-950/80 p-4 sm:grid-cols-2">
        <label className="block font-mono text-[0.65rem] uppercase text-slate-500">
          Location
          <select
            value={locationId}
            onChange={(e) => {
              setLocationId(e.target.value);
              setBinId("");
              resetScans();
            }}
            className="mt-1 w-full rounded-md border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100"
          >
            <option value="">— Select —</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code} — {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block font-mono text-[0.65rem] uppercase text-slate-500">
          Bin (optional)
          <select
            value={binId}
            onChange={(e) => {
              setBinId(e.target.value);
              resetScans();
            }}
            disabled={!locationId}
            className="mt-1 w-full rounded-md border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100 disabled:opacity-40"
          >
            <option value="">All bins at location</option>
            {(binRows ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} ({b.in_stock_count} in-stock)
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="rounded-lg border border-slate-800 bg-zinc-950/80 p-4">
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            disabled={!locationId}
            onClick={() => {
              setScanning((s) => !s);
              if (scanning) resetScans();
            }}
            className={`inline-flex min-h-[3rem] min-w-[10rem] items-center justify-center gap-2 rounded-xl border px-5 py-3 font-mono text-sm font-semibold uppercase tracking-wide transition-colors ${
              scanning
                ? "border-amber-500/60 bg-amber-950/40 text-amber-100"
                : "border-slate-600 bg-zinc-900 text-slate-200 hover:border-teal-500/40"
            } disabled:opacity-40`}
          >
            <Radio
              className={`h-5 w-5 ${scanning ? "text-amber-400" : "text-slate-500"}`}
            />
            {scanning ? "Scanning…" : "Start scan"}
          </button>
          <button
            type="button"
            disabled={!locationId || expected.length === 0}
            onClick={() => void simulateScan()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-600 bg-zinc-900 px-4 py-2.5 font-mono text-xs text-slate-200 hover:border-violet-500/40 disabled:opacity-40"
          >
            <Shuffle className="h-4 w-4" />
            Simulate scan
          </button>
          <button
            type="button"
            disabled={!locationId || scanned.length === 0}
            onClick={resetScans}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2.5 font-mono text-xs text-slate-400 hover:bg-zinc-900"
          >
            <ScanLine className="h-4 w-4" />
            Clear scans
          </button>
        </div>
        <p className="mt-3 font-mono text-[0.6rem] text-slate-600">
          Hardware SDK can feed EPCs while scanning is active. Use Simulate scan to load ~90% of
          expected plus sample misplaced and unrecognized tags.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(
          [
            ["Matched", kpi.matched, "text-emerald-400/90"],
            ["Missing", kpi.missing, "text-amber-400/90"],
            ["Misplaced", kpi.misplaced, "text-orange-400/90"],
            ["Unrecognized", kpi.unrecognized, "text-slate-400"],
          ] as const
        ).map(([label, n, cls]) => (
          <div
            key={label}
            className="rounded-lg border border-slate-800 bg-zinc-950/60 px-3 py-3 text-center"
          >
            <div className="font-mono text-[0.6rem] uppercase tracking-wide text-slate-500">
              {label}
            </div>
            <div className={`mt-1 font-mono text-2xl tabular-nums ${cls}`}>{n}</div>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-800 bg-zinc-950/80">
        <div className="border-b border-slate-800 px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wide text-slate-500">
          Results ({gridRows.length} rows)
        </div>
        <div className="max-h-[min(60vh,480px)] overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-zinc-900 font-mono text-[0.6rem] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">EPC</th>
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">Bin</th>
                <th className="px-3 py-2">Expected</th>
                <th className="px-3 py-2">Scanned</th>
                <th className="px-3 py-2">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 font-mono text-[0.65rem] text-slate-300">
              {gridRows.map((r) => (
                <tr key={r.epc}>
                  <td className="px-3 py-2 text-teal-400/85">{r.epc}</td>
                  <td className="px-3 py-2">{r.sku}</td>
                  <td className="px-3 py-2 text-slate-500">{r.bin}</td>
                <td className="px-3 py-2">{r.expected ? "Yes" : "No"}</td>
                <td className="px-3 py-2">{r.scanned ? "Yes" : "No"}</td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        r.state === "matched"
                          ? "text-emerald-400/90"
                          : r.state === "missing"
                            ? "text-amber-400/90"
                            : r.state === "misplaced"
                              ? "text-orange-400/90"
                              : "text-slate-500"
                      }
                    >
                      {r.state.toUpperCase()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {gridRows.length === 0 ? (
            <p className="p-6 text-center font-mono text-xs text-slate-600">
              Select a location to load expected in-stock EPCs.
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={
            !locationId ||
            scanned.length === 0 ||
            (c.misplaced.length > 0 && !binId)
          }
          onClick={() => setCommitOpen(true)}
          className="rounded-lg border border-teal-600/50 bg-teal-950/40 px-5 py-2.5 font-mono text-sm text-teal-200 hover:bg-teal-900/30 disabled:opacity-40"
        >
          Review & commit
        </button>
        {c.misplaced.length > 0 && !binId ? (
          <span className="self-center font-mono text-[0.65rem] text-amber-500/90">
            Select a bin to commit misplaced corrections.
          </span>
        ) : null}
      </div>

      {toast ? (
        <p className="font-mono text-xs text-slate-400">{toast}</p>
      ) : null}

      <CycleCountCommitModal
        open={commitOpen}
        onClose={() => setCommitOpen(false)}
        summary={kpi}
        onCommit={doCommit}
      />
    </div>
  );
}
