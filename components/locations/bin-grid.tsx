"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Printer, Search, X } from "lucide-react";
import type { BinWithCountRow, BinContentLineRow } from "@/lib/queries/locations";

function parseBinSegments(code: string): { section: string; shelf: string } {
  const parts = code.trim().split("-").filter(Boolean);
  if (parts.length === 0) return { section: "—", shelf: "—" };
  if (parts.length === 1) return { section: parts[0], shelf: "—" };
  const section = parts[0];
  const shelf =
    parts.length === 2 ? parts[1] : parts.slice(1).join("-");
  return { section, shelf };
}

function formatGroupedLine(row: BinContentLineRow): string {
  const attrs = [row.color_code, row.size].filter(Boolean).join("/");
  const tail = attrs ? ` (${attrs})` : "";
  return `${row.qty}× ${row.description}${tail}`;
}

export function BinGrid({ initialBins }: { initialBins: BinWithCountRow[] }) {
  const [bins, setBins] = useState(initialBins);
  const [query, setQuery] = useState("");
  const [drawerBin, setDrawerBin] = useState<BinWithCountRow | null>(null);
  const [contents, setContents] = useState<BinContentLineRow[] | null>(null);
  const [loadingContents, setLoadingContents] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/locations/bins");
    if (!res.ok) return;
    setBins((await res.json()) as BinWithCountRow[]);
  }, []);

  useEffect(() => {
    setBins(initialBins);
  }, [initialBins]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bins;
    return bins.filter((b) => b.code.toLowerCase().includes(q));
  }, [bins, query]);

  const openDrawer = useCallback((bin: BinWithCountRow) => {
    setDrawerBin(bin);
    setContents(null);
    setLoadingContents(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/locations/bins/contents?binId=${encodeURIComponent(bin.id)}`,
        );
        if (!res.ok) {
          setContents([]);
          return;
        }
        setContents((await res.json()) as BinContentLineRow[]);
      } catch {
        setContents([]);
      } finally {
        setLoadingContents(false);
      }
    })();
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerBin(null);
    setContents(null);
  }, []);

  useEffect(() => {
    if (!drawerBin) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [drawerBin, closeDrawer]);

  function mockPrintLabel(bin: BinWithCountRow) {
    window.alert(
      `[Mock] Print bin label\n\nCode: ${bin.code}\nBarcode: *${bin.code}*\nLocation bin id: ${bin.id}`,
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 border-b border-[var(--wms-border)] pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-md flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--wms-muted)]"
            strokeWidth={2}
            aria-hidden
          />
          <input
            type="search"
            placeholder="Filter by bin code (e.g. 1A-03-C)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-2.5 pl-10 pr-3 font-mono text-sm text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)] focus:border-teal-500/50 focus:outline-none focus:ring-1 focus:ring-teal-500/30"
          />
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="shrink-0 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] hover:border-[var(--wms-border)] hover:text-[var(--wms-fg)]"
        >
          Refresh bins
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
              <th className="px-3 py-2.5">Bin code</th>
              <th className="px-3 py-2.5">Row / section</th>
              <th className="px-3 py-2.5">Shelf</th>
              <th className="px-3 py-2.5 text-right">In-stock EPCs</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)] bg-[var(--wms-surface)]">
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-10 text-center font-mono text-xs text-[var(--wms-muted)]"
                >
                  {bins.length === 0
                    ? "No bins for this location. Create bins in the database or seed data."
                    : "No bins match your filter."}
                </td>
              </tr>
            ) : (
              filtered.map((bin) => {
                const { section, shelf } = parseBinSegments(bin.code);
                const hasStock = bin.in_stock_count > 0;
                return (
                  <tr
                    key={bin.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openDrawer(bin)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openDrawer(bin);
                      }
                    }}
                    className="cursor-pointer text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]/80"
                  >
                    <td className="px-3 py-2 align-middle">
                      <span className="font-mono text-sm font-bold tracking-tight text-[var(--wms-fg)]">
                        {bin.code}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-middle font-mono text-xs text-[var(--wms-muted)]">
                      {section}
                    </td>
                    <td className="px-3 py-2 align-middle font-mono text-xs text-[var(--wms-muted)]">
                      {shelf}
                    </td>
                    <td
                      className={`px-3 py-2 text-right align-middle font-mono text-sm font-semibold tabular-nums ${
                        hasStock ? "text-teal-400" : "text-[var(--wms-muted)]"
                      }`}
                    >
                      {bin.in_stock_count}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {drawerBin ? (
        <>
          <button
            type="button"
            aria-label="Close bin detail"
            className="fixed inset-0 z-[60] bg-black/65"
            onClick={closeDrawer}
          />
          <aside
            className="fixed inset-y-0 right-0 z-[70] flex w-full max-w-md flex-col border-l border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bin-drawer-title"
          >
            <div className="flex items-start justify-between gap-3 border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-3">
              <div className="min-w-0">
                <h2
                  id="bin-drawer-title"
                  className="font-mono text-lg font-bold tracking-tight text-[var(--wms-fg)]"
                >
                  {drawerBin.code}
                </h2>
                <p className="mt-1 font-mono text-[0.65rem] text-[var(--wms-muted)]">
                  {drawerBin.in_stock_count} in-stock EPC
                  {drawerBin.in_stock_count === 1 ? "" : "s"}
                </p>
              </div>
              <button
                type="button"
                className="shrink-0 rounded-md p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"
                onClick={closeDrawer}
                aria-label="Close"
              >
                <X className="h-5 w-5" strokeWidth={1.75} />
              </button>
            </div>

            <div className="border-b border-[var(--wms-border)] px-4 py-3">
              <button
                type="button"
                onClick={() => mockPrintLabel(drawerBin)}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-2.5 font-mono text-xs font-medium text-[var(--wms-fg)] hover:border-teal-500/50 hover:text-teal-300"
              >
                <Printer className="h-4 w-4" strokeWidth={2} />
                Print bin label
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <p className="font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
                Contents (matrix / custom SKU)
              </p>
              {loadingContents ? (
                <p className="mt-3 font-mono text-xs text-[var(--wms-muted)]">Loading…</p>
              ) : contents && contents.length === 0 ? (
                <p className="mt-3 font-mono text-xs text-[var(--wms-muted)]">
                  No in-stock items in this bin.
                </p>
              ) : contents ? (
                <ul className="mt-3 space-y-2">
                  {contents.map((row) => (
                    <li
                      key={row.custom_sku_id}
                      className="rounded-md border border-[var(--wms-border)]/80 bg-[var(--wms-surface-elevated)]/60 px-3 py-2 font-mono text-sm leading-snug text-[var(--wms-fg)]"
                    >
                      {formatGroupedLine(row)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}
