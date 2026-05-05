"use client";

import { useMemo, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";

export type ExpectedRow = {
  epc: string;
  sku: string;
  ls_system_id: string;
  upc: string;
  description: string;
  bin_id: string | null;
  bin_code: string | null;
  status: string;
};

export type RowState = "matched" | "missing" | "misplaced" | "unrecognized";

export type FlatRow = {
  epc: string;
  sku: string;
  description: string;
  bin: string;
  state: RowState;
};

export type Variance = {
  matched: string[];
  missing: string[];
  misplaced: string[];
  unrecognized: string[];
};

export type StateFilter = RowState | "all";

const STATE_LABEL: Record<RowState, string> = {
  matched: "Matched",
  missing: "Missing",
  misplaced: "Misplaced",
  unrecognized: "Unrecognized",
};

const STATE_CLS: Record<RowState, string> = {
  matched: "wms-status-success",
  missing: "text-amber-400",
  misplaced: "text-orange-400",
  unrecognized: "text-[var(--wms-muted)]",
};

export function buildFlatRows(
  expected: ExpectedRow[],
  variance: Variance,
): FlatRow[] {
  const expByEpc = new Map(expected.map((e) => [e.epc, e]));
  const rows: FlatRow[] = [];
  const matchedSet = new Set(variance.matched);
  for (const e of expected) {
    rows.push({
      epc: e.epc,
      sku: e.sku,
      description: e.description ?? "",
      bin: e.bin_code ?? "—",
      state: matchedSet.has(e.epc) ? "matched" : "missing",
    });
  }
  for (const epc of variance.misplaced) {
    rows.push({
      epc,
      sku: expByEpc.get(epc)?.sku ?? "—",
      description: expByEpc.get(epc)?.description ?? "",
      bin: expByEpc.get(epc)?.bin_code ?? "—",
      state: "misplaced",
    });
  }
  for (const epc of variance.unrecognized) {
    rows.push({
      epc,
      sku: expByEpc.get(epc)?.sku ?? "—",
      description: expByEpc.get(epc)?.description ?? "",
      bin: expByEpc.get(epc)?.bin_code ?? "—",
      state: "unrecognized",
    });
  }
  return rows;
}

/** ───────────── All EPCs view (filterable, searchable flat table) ───────────── */
export function AllEpcsTable({
  rows,
  search,
  stateFilter,
}: {
  rows: FlatRow[];
  search: string;
  stateFilter: StateFilter;
}) {
  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return rows.filter((r) => {
      if (stateFilter !== "all" && r.state !== stateFilter) return false;
      if (!q) return true;
      return (
        r.epc.includes(q) ||
        r.sku.toUpperCase().includes(q) ||
        r.bin.toUpperCase().includes(q) ||
        r.description.toUpperCase().includes(q)
      );
    });
  }, [rows, search, stateFilter]);

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80">
      <div className="border-b border-[var(--wms-border)] px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
        Showing {filtered.length} of {rows.length}
      </div>
      <div className="max-h-[min(60vh,560px)] overflow-auto">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.65rem] uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2">EPC</th>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2 hidden md:table-cell">Description</th>
              <th className="px-3 py-2">Expected bin</th>
              <th className="px-3 py-2">State</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-xs text-[var(--wms-fg)]">
            {filtered.map((r) => (
              <tr key={r.epc + r.state}>
                <td className="px-3 py-2 text-[var(--wms-accent)]">{r.epc}</td>
                <td className="px-3 py-2">{r.sku}</td>
                <td className="px-3 py-2 hidden md:table-cell text-[var(--wms-muted)]">
                  {r.description}
                </td>
                <td className="px-3 py-2 text-[var(--wms-muted)]">{r.bin}</td>
                <td className="px-3 py-2">
                  <span className={STATE_CLS[r.state]}>{STATE_LABEL[r.state]}</span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-6 text-center text-[var(--wms-muted)]">
                  Nothing to show.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** ───────────── By-SKU rollup (where pros work) ───────────── */
export function BySkuTable({
  expected,
  variance,
  search,
}: {
  expected: ExpectedRow[];
  variance: Variance;
  search: string;
}) {
  const matchedSet = new Set(variance.matched);
  type SkuAgg = {
    sku: string;
    description: string;
    expected: number;
    matched: number;
    missing: number;
    bins: { bin_code: string; expected: number; matched: number }[];
  };

  const agg = useMemo(() => {
    const map = new Map<string, SkuAgg>();
    for (const e of expected) {
      let v = map.get(e.sku);
      if (!v) {
        v = { sku: e.sku, description: e.description ?? "", expected: 0, matched: 0, missing: 0, bins: [] };
        map.set(e.sku, v);
      }
      v.expected += 1;
      if (matchedSet.has(e.epc)) v.matched += 1;
      else v.missing += 1;
      const binCode = e.bin_code ?? "—";
      let b = v.bins.find((x) => x.bin_code === binCode);
      if (!b) {
        b = { bin_code: binCode, expected: 0, matched: 0 };
        v.bins.push(b);
      }
      b.expected += 1;
      if (matchedSet.has(e.epc)) b.matched += 1;
    }
    const out = [...map.values()].sort((a, b) => b.missing - a.missing || a.sku.localeCompare(b.sku));
    return out;
  }, [expected, matchedSet]);

  const q = search.trim().toUpperCase();
  const filtered = q
    ? agg.filter(
        (a) =>
          a.sku.toUpperCase().includes(q) ||
          a.description.toUpperCase().includes(q),
      )
    : agg;

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80">
      <div className="border-b border-[var(--wms-border)] px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
        {filtered.length} SKU{filtered.length === 1 ? "" : "s"} — sorted by missing first
      </div>
      <div className="max-h-[min(60vh,560px)] overflow-auto">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.65rem] uppercase tracking-wide">
            <tr>
              <th className="w-6 px-1 py-2"></th>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2 hidden md:table-cell">Description</th>
              <th className="px-3 py-2 text-right">Expected</th>
              <th className="px-3 py-2 text-right">Matched</th>
              <th className="px-3 py-2 text-right">Missing</th>
              <th className="px-3 py-2 text-right">Coverage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-xs">
            {filtered.map((a) => (
              <SkuRow key={a.sku} a={a} />
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-6 text-center text-[var(--wms-muted)]">
                  No SKUs match.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SkuRow({
  a,
}: {
  a: {
    sku: string;
    description: string;
    expected: number;
    matched: number;
    missing: number;
    bins: { bin_code: string; expected: number; matched: number }[];
  };
}) {
  const [open, setOpen] = useState(false);
  const cov = a.expected === 0 ? 0 : Math.round((a.matched / a.expected) * 100);
  const covCls =
    cov === 100 ? "wms-status-success" : cov >= 80 ? "text-amber-400" : "text-red-400";
  return (
    <>
      <tr className="hover:bg-[var(--wms-surface-elevated)]/40">
        <td className="px-1 py-2 text-center">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[var(--wms-muted)]"
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </td>
        <td className="px-3 py-2 text-[var(--wms-accent)]">{a.sku}</td>
        <td className="px-3 py-2 hidden md:table-cell text-[var(--wms-muted)]">
          {a.description}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{a.expected}</td>
        <td className="px-3 py-2 text-right tabular-nums wms-status-success">{a.matched}</td>
        <td
          className={`px-3 py-2 text-right tabular-nums ${a.missing > 0 ? "text-amber-400" : "text-[var(--wms-muted)]"}`}
        >
          {a.missing}
        </td>
        <td className={`px-3 py-2 text-right tabular-nums ${covCls}`}>{cov}%</td>
      </tr>
      {open
        ? a.bins.map((b) => (
            <tr key={a.sku + b.bin_code} className="bg-[var(--wms-surface)]/40">
              <td></td>
              <td className="px-3 py-1.5 pl-9 text-[var(--wms-muted)]">↳ {b.bin_code}</td>
              <td className="px-3 py-1.5 hidden md:table-cell"></td>
              <td className="px-3 py-1.5 text-right tabular-nums text-[var(--wms-muted)]">{b.expected}</td>
              <td className="px-3 py-1.5 text-right tabular-nums wms-status-success">{b.matched}</td>
              <td
                className={`px-3 py-1.5 text-right tabular-nums ${
                  b.expected - b.matched > 0 ? "text-amber-400" : "text-[var(--wms-muted)]"
                }`}
              >
                {b.expected - b.matched}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-[var(--wms-muted)]">
                {b.expected === 0 ? 0 : Math.round((b.matched / b.expected) * 100)}%
              </td>
            </tr>
          ))
        : null}
    </>
  );
}

/** ───────────── By-Bin rollup (operator walk-list) ───────────── */
export function ByBinTable({
  expected,
  variance,
}: {
  expected: ExpectedRow[];
  variance: Variance;
}) {
  const matchedSet = new Set(variance.matched);
  type BinAgg = {
    bin_code: string;
    expected: number;
    matched: number;
    missing: number;
  };
  const agg = useMemo(() => {
    const map = new Map<string, BinAgg>();
    for (const e of expected) {
      const k = e.bin_code ?? "—";
      let v = map.get(k);
      if (!v) {
        v = { bin_code: k, expected: 0, matched: 0, missing: 0 };
        map.set(k, v);
      }
      v.expected += 1;
      if (matchedSet.has(e.epc)) v.matched += 1;
      else v.missing += 1;
    }
    return [...map.values()].sort(
      (a, b) => b.missing - a.missing || a.bin_code.localeCompare(b.bin_code),
    );
  }, [expected, matchedSet]);

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80">
      <div className="border-b border-[var(--wms-border)] px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
        {agg.length} bin{agg.length === 1 ? "" : "s"} — sorted by missing first
      </div>
      <div className="max-h-[min(60vh,560px)] overflow-auto">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.65rem] uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2">Bin</th>
              <th className="px-3 py-2 text-right">Expected</th>
              <th className="px-3 py-2 text-right">Matched</th>
              <th className="px-3 py-2 text-right">Missing</th>
              <th className="px-3 py-2 text-right">Coverage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-xs">
            {agg.map((b) => {
              const cov = b.expected === 0 ? 0 : Math.round((b.matched / b.expected) * 100);
              const cls =
                cov === 100 ? "wms-status-success" : cov >= 80 ? "text-amber-400" : "text-red-400";
              return (
                <tr key={b.bin_code} className="hover:bg-[var(--wms-surface-elevated)]/40">
                  <td className="px-3 py-2 text-[var(--wms-accent)]">{b.bin_code}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{b.expected}</td>
                  <td className="px-3 py-2 text-right tabular-nums wms-status-success">
                    {b.matched}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${
                      b.missing > 0 ? "text-amber-400" : "text-[var(--wms-muted)]"
                    }`}
                  >
                    {b.missing}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${cls}`}>{cov}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
