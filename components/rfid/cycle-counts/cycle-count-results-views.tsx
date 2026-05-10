"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ChevronDown, X as XIcon, Loader2 } from "lucide-react";
import type { TrackerItemDetail } from "@/lib/rfid-tracker-types";

export type ExpectedRow = {
  epc: string;
  sku: string;
  ls_system_id: string;
  upc: string;
  description: string;
  /** From custom_skus.color_code; may be missing on legacy snapshots. */
  color?: string | null;
  /** From custom_skus.size; may be missing on legacy snapshots. */
  size?: string | null;
  bin_id: string | null;
  bin_code: string | null;
  status: string;
};

export type RowState = "matched" | "missing" | "misplaced" | "unrecognized";

export type FlatRow = {
  epc: string;
  sku: string;
  description: string;
  upc: string;
  color: string;
  size: string;
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
  const fromExpected = (e: ExpectedRow): Omit<FlatRow, "state"> => ({
    epc: e.epc,
    sku: e.sku,
    description: e.description ?? "",
    upc: e.upc ?? "",
    color: e.color ?? "",
    size: e.size ?? "",
    bin: e.bin_code ?? "—",
  });
  const fallback = (epc: string): Omit<FlatRow, "state"> => {
    const e = expByEpc.get(epc);
    if (e) return fromExpected(e);
    return { epc, sku: "—", description: "", upc: "", color: "", size: "", bin: "—" };
  };
  for (const e of expected) {
    rows.push({ ...fromExpected(e), state: matchedSet.has(e.epc) ? "matched" : "missing" });
  }
  for (const epc of variance.misplaced) {
    rows.push({ ...fallback(epc), state: "misplaced" });
  }
  for (const epc of variance.unrecognized) {
    rows.push({ ...fallback(epc), state: "unrecognized" });
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
        r.description.toUpperCase().includes(q) ||
        r.upc.toUpperCase().includes(q) ||
        r.color.toUpperCase().includes(q) ||
        r.size.toUpperCase().includes(q)
      );
    });
  }, [rows, search, stateFilter]);

  const [openEpc, setOpenEpc] = useState<string | null>(null);

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80">
      <div className="border-b border-[var(--wms-border)] px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
        Showing {filtered.length} of {rows.length}
      </div>
      <div className="max-h-[min(60vh,560px)] overflow-auto">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.65rem] uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2 hidden md:table-cell">Description</th>
              <th className="px-3 py-2">UPC</th>
              <th className="px-3 py-2">Color</th>
              <th className="px-3 py-2">Size</th>
              <th className="px-3 py-2">Expected bin</th>
              <th className="px-3 py-2">State</th>
              <th className="px-3 py-2">EPC</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-xs text-[var(--wms-fg)]">
            {filtered.map((r) => (
              <tr key={r.epc + r.state}>
                <td className="px-3 py-2">{r.sku}</td>
                <td className="px-3 py-2 hidden md:table-cell text-[var(--wms-muted)]">
                  {r.description}
                </td>
                <td className="px-3 py-2 text-[var(--wms-muted)]">{r.upc || "—"}</td>
                <td className="px-3 py-2 text-[var(--wms-muted)]">{r.color || "—"}</td>
                <td className="px-3 py-2 text-[var(--wms-muted)]">{r.size || "—"}</td>
                <td className="px-3 py-2 text-[var(--wms-muted)]">{r.bin}</td>
                <td className="px-3 py-2">
                  <span className={STATE_CLS[r.state]}>{STATE_LABEL[r.state]}</span>
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setOpenEpc(r.epc)}
                    className="text-[var(--wms-accent)] underline-offset-2 hover:underline"
                    title="Show item history + last seen"
                  >
                    {r.epc}
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-[var(--wms-muted)]">
                  Nothing to show.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {openEpc ? (
        <EpcHistoryModal epc={openEpc} onClose={() => setOpenEpc(null)} />
      ) : null}
    </div>
  );
}

/** ───────────── EPC history popup ─────────────
 * Reuses /api/rfid/tracker/search?q=<EPC> for item detail + last-seen
 * source, and /api/rfid/tracker/<EPC>/history for the audit trail. Same
 * data the EPC tracker page renders, just lifted into a modal so the
 * operator can drill in without leaving the count.
 */

type HistoryRow = {
  id: string;
  action: string;
  entity: string;
  metadata: unknown;
  created_at: string;
};

type SearchResp = {
  result?:
    | { mode: "direct"; item: TrackerItemDetail }
    | { mode: "pick"; matches: unknown[] };
  error?: string;
};

function EpcHistoryModal({ epc, onClose }: { epc: string; onClose: () => void }) {
  const [item, setItem] = useState<TrackerItemDetail | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const [searchRes, histRes] = await Promise.all([
          fetch(`/api/rfid/tracker/search?q=${encodeURIComponent(epc)}`),
          fetch(`/api/rfid/tracker/${encodeURIComponent(epc)}/history?limit=80`),
        ]);
        const sjson = (await searchRes.json()) as SearchResp;
        const hjson = (await histRes.json()) as { history?: HistoryRow[]; error?: string };
        if (cancelled) return;
        if (sjson.result?.mode === "direct") setItem(sjson.result.item);
        setHistory(hjson.history ?? []);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [epc]);

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[80] bg-black/70"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4">
        <div className="mt-12 w-full max-w-2xl rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-5 shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
                EPC
              </p>
              <p className="truncate font-mono text-sm font-semibold text-[var(--wms-accent)]">
                {epc}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
              aria-label="Close"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>

          {loading ? (
            <div className="mt-4 flex items-center gap-2 font-mono text-xs text-[var(--wms-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : err ? (
            <p className="mt-4 font-mono text-xs text-red-400/90">{err}</p>
          ) : (
            <>
              <div className="mt-4 grid grid-cols-1 gap-y-1.5 font-mono text-[0.7rem] sm:grid-cols-[140px_1fr]">
                <FieldRow label="SKU" value={item?.sku ?? "—"} />
                <FieldRow label="Description" value={item?.description ?? "—"} />
                <FieldRow label="UPC" value={item?.upc || "—"} />
                <FieldRow
                  label="Status"
                  value={item?.status ?? "—"}
                />
                <FieldRow
                  label="Location"
                  value={item ? `${item.location_code} — ${item.location_name}` : "—"}
                />
                <FieldRow
                  label="Bin"
                  value={item?.bin_code ?? "—"}
                />
                <FieldRow
                  label="Entered system"
                  value={fmtTs(item?.first_scanned_at ?? item?.created_at ?? null)}
                />
                <FieldRow
                  label="Source"
                  value={item?.source ?? item?.source_device_label ?? "—"}
                />
                <FieldRow
                  label="Source device"
                  value={item?.source_device_name ?? "—"}
                />
                <FieldRow
                  label="Source antenna"
                  value={item?.source_antenna_name ?? "—"}
                />
                <FieldRow
                  label="Added by"
                  value={item?.created_by_email ?? "—"}
                />
              </div>

              <div className="mt-5">
                <p className="mb-2 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
                  History ({history.length})
                </p>
                <div className="max-h-72 overflow-auto rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]">
                  {history.length === 0 ? (
                    <p className="p-3 font-mono text-xs text-[var(--wms-muted)]">
                      No history rows yet.
                    </p>
                  ) : (
                    <ul className="divide-y divide-[var(--wms-border)]/80 font-mono text-[0.7rem]">
                      {history.map((h) => (
                        <li key={h.id} className="px-3 py-2">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="text-[var(--wms-fg)]">{h.action}</span>
                            <span className="shrink-0 text-[var(--wms-muted)]">
                              {fmtTs(h.created_at)}
                            </span>
                          </div>
                          {h.metadata ? (
                            <pre className="mt-1 whitespace-pre-wrap break-words text-[0.65rem] text-[var(--wms-muted)]">
                              {summarizeMetadata(h.metadata)}
                            </pre>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-[var(--wms-muted)]">{label}</span>
      <span className="break-words text-[var(--wms-fg)]">{value}</span>
    </>
  );
}

function fmtTs(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Compact JSON summary — keep only the keys an operator cares about. */
function summarizeMetadata(m: unknown): string {
  if (m == null || typeof m !== "object") return "";
  const obj = m as Record<string, unknown>;
  const keep = [
    "reader_id",
    "reader_name",
    "antenna_id",
    "antenna_name",
    "device_id",
    "device_name",
    "android_id",
    "from_zone_id",
    "to_zone_id",
    "from_bin_id",
    "to_bin_id",
    "from_location_id",
    "to_location_id",
    "by_user",
    "by_email",
    "source",
    "kind",
    "count",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keep) {
    if (k in obj && obj[k] != null && obj[k] !== "") out[k] = obj[k];
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out, null, 2) : JSON.stringify(obj);
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
