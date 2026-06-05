"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronDown, X as XIcon, Loader2 } from "lucide-react";
import type { TrackerItemDetail } from "@/lib/rfid-tracker-types";
import { shortName } from "@/lib/format-name";
import {
  cellTruncate,
  DataTableContainer,
  pickTableLayout,
  ResizeHandle,
  useColResize,
} from "@/components/shared/data-table";

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

export type RowState = "matched" | "missing" | "added_here" | "defective" | "locked";

export type LiveScanRow = {
  epc: string;
  sku: string | null;
  description: string | null;
  upc: string | null;
  color: string | null;
  size: string | null;
  bin_id: string | null;
  bin_code: string | null;
  current_status: string;
  current_location_id: string | null;
  current_location_code: string | null;
};

export type FlatRow = {
  epc: string;
  sku: string;
  description: string;
  upc: string;
  color: string;
  size: string;
  bin: string;
  current_status: string;
  state: RowState;
};

export type Variance = {
  matched: ExpectedRow[];
  missing: ExpectedRow[];
  added_here: LiveScanRow[];
  defective: LiveScanRow[];
  locked: LiveScanRow[];
};

export type StateFilter = RowState | "all";

export const STATE_LABEL: Record<RowState, string> = {
  matched: "Matched",
  missing: "Missing",
  added_here: "Added here",
  defective: "Defective",
  locked: "Locked",
};

const STATE_CLS: Record<RowState, string> = {
  matched: "wms-status-success",
  missing: "text-amber-400",
  added_here: "text-sky-300",
  defective: "text-red-400",
  locked: "text-fuchsia-300",
};

function fromExpected(e: ExpectedRow, state: "matched" | "missing"): FlatRow {
  return {
    epc: e.epc,
    sku: e.sku,
    description: e.description ?? "",
    upc: e.upc ?? "",
    color: e.color ?? "",
    size: e.size ?? "",
    bin: e.bin_code ?? "—",
    current_status: e.status,
    state,
  };
}

function fromLive(r: LiveScanRow, state: "added_here" | "defective" | "locked"): FlatRow {
  return {
    epc: r.epc,
    sku: r.sku ?? "—",
    description: r.description ?? "",
    upc: r.upc ?? "",
    color: r.color ?? "",
    size: r.size ?? "",
    bin: r.bin_code ?? "—",
    current_status: r.current_status,
    state,
  };
}

export function buildFlatRows(
  _expected: ExpectedRow[],
  variance: Variance,
): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const e of variance.matched) rows.push(fromExpected(e, "matched"));
  for (const e of variance.missing) rows.push(fromExpected(e, "missing"));
  for (const r of variance.added_here) rows.push(fromLive(r, "added_here"));
  for (const r of variance.defective) rows.push(fromLive(r, "defective"));
  for (const r of variance.locked) rows.push(fromLive(r, "locked"));
  return rows;
}

/** ───────────── All EPCs view (filterable, searchable flat table) ───────────── */
/* Initial / incremental row caps. The full flat list can be 5K–10K rows on
   a big count, and rendering all of them blows up the DOM (the parent gets
   stuck on layout). We render the first PAGE_SIZE rows, with a button to
   reveal more on demand. Sessions are usually navigated by SKU / bin / a
   targeted search, so the operator hits the limit only when they actually
   want to scroll. Filter changes reset the cap so the first page of every
   new filter is always visible. */
const PAGE_SIZE = 200;
const PAGE_STEP = 500;

export type EpcSourceRecord = Record<
  string,
  { kind: "mobile" | "reader"; name: string; ts: string }
>;
export type EpcSourceFilter =
  | { kind: "all" }
  | { kind: "mobile"; name: string | null }
  | { kind: "reader"; name: string | null };

export function AllEpcsTable({
  rows,
  search,
  stateFilter,
  sources,
  sourceFilter,
}: {
  rows: FlatRow[];
  search: string;
  stateFilter: StateFilter;
  /** Per-EPC source map from the session; `{}` on pre-migration sessions. */
  sources?: EpcSourceRecord;
  /** Workspace source filter (All / Mobile / specific reader name). */
  sourceFilter?: EpcSourceFilter;
}) {
  const srcMap = sources ?? {};
  const srcFilter = sourceFilter ?? { kind: "all" as const };

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return rows.filter((r) => {
      if (stateFilter !== "all" && r.state !== stateFilter) return false;
      // Source filter — applied AFTER state so the operator can stack
      // "missing AND from this reader" queries naturally. Rows whose
      // EPC isn't in the source map fail any non-"all" source filter
      // (we can't show what we don't know).
      if (srcFilter.kind !== "all") {
        const src = srcMap[r.epc.toUpperCase()];
        if (!src) return false;
        if (src.kind !== srcFilter.kind) return false;
        if (srcFilter.name != null && src.name !== srcFilter.name) return false;
      }
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
  }, [rows, search, stateFilter, srcMap, srcFilter]);

  /* Reset the visible cap whenever the filter set changes so the operator
     always lands on the first page of the new query. */
  const [visibleCap, setVisibleCap] = useState(PAGE_SIZE);
  useEffect(() => {
    setVisibleCap(PAGE_SIZE);
  }, [search, stateFilter, rows, srcFilter]);
  const visibleRows = useMemo(
    () => filtered.slice(0, visibleCap),
    [filtered, visibleCap],
  );
  const hiddenCount = Math.max(0, filtered.length - visibleRows.length);

  const [openEpc, setOpenEpc] = useState<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 9);

  const cols: { label: string; align?: "right" | "center"; mdOnly?: boolean }[] = [
    { label: "SKU" },
    { label: "Description", mdOnly: true },
    { label: "UPC" },
    { label: "Color" },
    { label: "Size" },
    { label: "Expected bin" },
    { label: "State" },
    { label: "Source" },
    { label: "EPC" },
  ];

  return (
    <>
      <DataTableContainer
        caption={
          hiddenCount > 0
            ? `Showing ${visibleRows.length} of ${filtered.length} (${rows.length} total) — ${hiddenCount} hidden for speed`
            : `Showing ${filtered.length} of ${rows.length}`
        }
      >
        <table
          ref={tableRef}
          className="w-full min-w-[1100px] border-collapse text-left"
          style={{ tableLayout: pickTableLayout(colWidths) }}
        >
          <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.65rem] uppercase tracking-wide">
            <tr>
              {cols.map((c, i) => {
                const w = colWidths[i];
                return (
                  <th
                    key={c.label}
                    style={w !== null ? { width: w, minWidth: w } : undefined}
                    className={`relative overflow-hidden px-3 py-2 ${
                      c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : ""
                    } ${c.mdOnly ? "hidden md:table-cell" : ""}`}
                  >
                    <span>{c.label}</span>
                    <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-xs text-[var(--wms-fg)]">
            {visibleRows.map((r) => (
              <tr key={r.epc + r.state}>
                <td className={`${cellTruncate} px-3 py-2`} title={r.sku}>{r.sku}</td>
                <td
                  className={`${cellTruncate} hidden px-3 py-2 text-[var(--wms-muted)] md:table-cell`}
                  title={r.description}
                >
                  {r.description}
                </td>
                <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`} title={r.upc}>{r.upc || "—"}</td>
                <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`} title={r.color}>{r.color || "—"}</td>
                <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`} title={r.size}>{r.size || "—"}</td>
                <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`} title={r.bin}>{r.bin}</td>
                <td className="overflow-hidden px-3 py-2">
                  <span className={STATE_CLS[r.state]}>{STATE_LABEL[r.state]}</span>
                  {r.state === "locked" || r.state === "defective" ? (
                    <span className="ml-1 text-[0.6rem] text-[var(--wms-muted)]">
                      ({r.current_status})
                    </span>
                  ) : null}
                </td>
                <td
                  className={`${cellTruncate} px-3 py-2 text-[var(--wms-muted)]`}
                  title={(() => {
                    const s = srcMap[r.epc.toUpperCase()];
                    return s ? `${s.kind} · ${s.name} · ${new Date(s.ts).toLocaleString()}` : "—";
                  })()}
                >
                  {(() => {
                    const s = srcMap[r.epc.toUpperCase()];
                    if (!s) return "—";
                    const tag =
                      s.kind === "mobile"
                        ? "📱"
                        : "📡";
                    return `${tag} ${s.name}`;
                  })()}
                </td>
                <td className={`${cellTruncate} px-3 py-2`}>
                  <button
                    type="button"
                    onClick={() => setOpenEpc(r.epc)}
                    className="text-[var(--wms-accent)] underline-offset-2 hover:underline"
                    title={`${r.epc} — click for history`}
                  >
                    {r.epc}
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-6 text-center text-[var(--wms-muted)]">
                  Nothing to show.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </DataTableContainer>
      {hiddenCount > 0 ? (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">
          <span>
            {hiddenCount} more row{hiddenCount === 1 ? "" : "s"} match — refine
            search or load below.
          </span>
          <button
            type="button"
            onClick={() => setVisibleCap((n) => n + PAGE_STEP)}
            className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1 text-[var(--wms-fg)] hover:bg-[var(--wms-surface)]"
          >
            Show {Math.min(PAGE_STEP, hiddenCount)} more
          </button>
          <button
            type="button"
            onClick={() => setVisibleCap(filtered.length)}
            title="Render every matching row — slow on big counts (intentional)."
            className="rounded-md border border-amber-500/40 bg-amber-950/40 px-3 py-1 text-amber-200 hover:bg-amber-900/40"
          >
            Show all ({filtered.length})
          </button>
        </div>
      ) : null}
      {openEpc ? (
        <EpcHistoryModal epc={openEpc} onClose={() => setOpenEpc(null)} />
      ) : null}
    </>
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
                  value={shortName(
                    item?.created_by_first,
                    item?.created_by_last,
                    item?.created_by_email,
                  )}
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
  /* matchedSet MUST be memoized — the agg useMemo below depends on it, and
     without this wrap the Set was reconstructed on every parent render,
     busting agg's cache and re-aggregating thousands of expected rows on
     every 200 ms scan-tick. */
  const matchedSet = useMemo(
    () => new Set(variance.matched.map((m) => m.epc)),
    [variance.matched],
  );
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
    const out = [...map.values()].sort(
      (a, b) => b.missing - a.missing || (a.sku ?? "").localeCompare(b.sku ?? ""),
    );
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

  return <BySkuTableInner filtered={filtered} />;
}

function BySkuTableInner({
  filtered,
}: {
  filtered: {
    sku: string;
    description: string;
    expected: number;
    matched: number;
    missing: number;
    bins: { bin_code: string; expected: number; matched: number }[];
  }[];
}) {
  const tableRef = useRef<HTMLTableElement>(null);
  // 7 columns: chevron, SKU, Description, Expected, Matched, Missing, Coverage
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 7);
  const cols: {
    label: string;
    align?: "right" | "center";
    mdOnly?: boolean;
    width?: number;
  }[] = [
    { label: "" },
    { label: "SKU" },
    { label: "Description", mdOnly: true },
    { label: "Expected", align: "right" },
    { label: "Matched", align: "right" },
    { label: "Missing", align: "right" },
    { label: "Coverage", align: "right" },
  ];

  return (
    <DataTableContainer
      caption={`${filtered.length} SKU${filtered.length === 1 ? "" : "s"} — sorted by missing first`}
    >
      <table
        ref={tableRef}
        className="w-full min-w-[800px] border-collapse text-left"
        style={{ tableLayout: pickTableLayout(colWidths) }}
      >
        <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.65rem] uppercase tracking-wide">
          <tr>
            {cols.map((c, i) => {
              const w = colWidths[i];
              return (
                <th
                  key={c.label || `col-${i}`}
                  style={w !== null ? { width: w, minWidth: w } : undefined}
                  className={`relative overflow-hidden ${i === 0 ? "w-6 px-1 py-2" : "px-3 py-2"} ${
                    c.align === "right" ? "text-right" : ""
                  } ${c.mdOnly ? "hidden md:table-cell" : ""}`}
                >
                  <span>{c.label}</span>
                  {i > 0 ? (
                    <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                  ) : null}
                </th>
              );
            })}
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
    </DataTableContainer>
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
  /* Same memoization concern as BySkuTable — without this wrap, agg's
     useMemo cache is busted on every parent render. */
  const matchedSet = useMemo(
    () => new Set(variance.matched.map((m) => m.epc)),
    [variance.matched],
  );
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
      (a, b) =>
        b.missing - a.missing || (a.bin_code ?? "").localeCompare(b.bin_code ?? ""),
    );
  }, [expected, matchedSet]);

  return <ByBinTableInner agg={agg} />;
}

function ByBinTableInner({
  agg,
}: {
  agg: { bin_code: string; expected: number; matched: number; missing: number }[];
}) {
  const tableRef = useRef<HTMLTableElement>(null);
  const { colWidths, startDrag, autoFit } = useColResize(tableRef, 5);
  const cols: { label: string; align?: "right" }[] = [
    { label: "Bin" },
    { label: "Expected", align: "right" },
    { label: "Matched", align: "right" },
    { label: "Missing", align: "right" },
    { label: "Coverage", align: "right" },
  ];

  return (
    <DataTableContainer
      caption={`${agg.length} bin${agg.length === 1 ? "" : "s"} — sorted by missing first`}
    >
      <table
        ref={tableRef}
        className="w-full min-w-[600px] border-collapse text-left"
        style={{ tableLayout: pickTableLayout(colWidths) }}
      >
        <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.65rem] uppercase tracking-wide">
          <tr>
            {cols.map((c, i) => {
              const w = colWidths[i];
              return (
                <th
                  key={c.label}
                  style={w !== null ? { width: w, minWidth: w } : undefined}
                  className={`relative overflow-hidden px-3 py-2 ${
                    c.align === "right" ? "text-right" : ""
                  }`}
                >
                  <span>{c.label}</span>
                  <ResizeHandle colIdx={i} startDrag={startDrag} autoFit={autoFit} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-xs">
          {agg.map((b) => {
            const cov = b.expected === 0 ? 0 : Math.round((b.matched / b.expected) * 100);
            const cls =
              cov === 100 ? "wms-status-success" : cov >= 80 ? "text-amber-400" : "text-red-400";
            return (
              <tr key={b.bin_code} className="hover:bg-[var(--wms-surface-elevated)]/40">
                <td className={`${cellTruncate} px-3 py-2 text-[var(--wms-accent)]`} title={b.bin_code}>
                  {b.bin_code}
                </td>
                <td className="overflow-hidden px-3 py-2 text-right tabular-nums">{b.expected}</td>
                <td className="overflow-hidden px-3 py-2 text-right tabular-nums wms-status-success">
                  {b.matched}
                </td>
                <td
                  className={`overflow-hidden px-3 py-2 text-right tabular-nums ${
                    b.missing > 0 ? "text-amber-400" : "text-[var(--wms-muted)]"
                  }`}
                >
                  {b.missing}
                </td>
                <td className={`overflow-hidden px-3 py-2 text-right tabular-nums ${cls}`}>{cov}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </DataTableContainer>
  );
}
