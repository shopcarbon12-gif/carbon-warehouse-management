"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Archive, ChevronDown, ChevronUp, ChevronsUpDown, PackageOpen, Pin, Radio } from "lucide-react";
import type { CatalogGridRow } from "@/lib/server/inventory-catalog";
import { computeSkuPrefix } from "@/lib/queries/bin-code";
import { RfidTagsModal } from "@/components/inventory/catalog/rfid-tags-modal";
import { DefectiveEpcsModal } from "@/components/inventory/catalog/defective-epcs-modal";
import { ManualItemsModal } from "@/components/inventory/catalog/manual-items-modal";
import { ItemHistoryModal } from "@/components/inventory/catalog/item-history-modal";
import { CatalogItemDetailsModal } from "@/components/inventory/catalog/catalog-item-details-modal";
import { CatalogBinMoveDialog } from "@/components/inventory/catalog/catalog-bin-move-dialog";
import { SyncPreviewModal } from "@/components/inventory/sync/sync-preview-modal";
import { startSyncJobTracking } from "@/components/inventory/sync/sync-progress-floater";
import {
  ResizeHandle,
  ThickScrollbars,
  useColResize as useSharedColResize,
} from "@/components/shared/data-table";

const PAGE_SIZE_OPTIONS = [100, 300, 500, 1000, "ALL"] as const;
const DEFAULT_PAGE_SIZE = 300;
const ALL_LIMIT = 5000; // matches API cap

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

type SortDir = "asc" | "desc";

function buildGridUrl(
  page: number,
  q: string,
  sortBy: string,
  sortDir: SortDir,
  showArchived: boolean,
  manualOnly: boolean,
  limit: number,
): string {
  const p = new URLSearchParams({
    view: "grid",
    page: String(page),
    limit: String(limit),
  });
  if (q.trim()) p.set("q", q.trim());
  if (sortBy) { p.set("sortBy", sortBy); p.set("sortDir", sortDir); }
  if (showArchived) p.set("showArchived", "1");
  if (manualOnly) p.set("manualOnly", "1");
  return `/api/inventory/catalog?${p}`;
}

function displayUpc(r: CatalogGridRow): string {
  const v = r.sku_upc?.trim();
  if (v) return v;
  return r.matrix_upc?.trim() || "—";
}

function formatPrice(raw: string | null): string {
  if (raw == null || raw.trim() === "") return "—";
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return raw;
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(n);
}

function escapeCsvCell(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function exportLightspeedCatalogCsv(rows: CatalogGridRow[]) {
  const headers = [
    "System ID",
    "Item Name",
    "Custom SKU",
    "UPC",
    "Vendor",
    "Color",
    "Size",
    "Default Cost",
    "Retail Price",
    "Bin",
    "Qty (EPC)",
    "Category",
    "Subcategory 1",
  ];
  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((r) =>
      [
        r.sku_ls_system_id ?? "",
        r.name,
        r.sku,
        displayUpc(r),
        r.vendor?.trim() ?? "",
        r.color?.trim() ?? "",
        r.size?.trim() ?? "",
        r.default_cost?.trim() ?? "",
        r.retail_price?.trim() ?? "",
        r.bin_location ?? "",
        String(r.active_epc_count ?? 0),
        r.category?.trim() ?? "",
        r.subcategory_1?.trim() ?? "",
      ]
        .map((c) => escapeCsvCell(String(c)))
        .join(","),
    ),
  ];
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lightspeed-catalog-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

type SortKey =
  | "system_id" | "name" | "sku" | "upc"
  | "color" | "size" | "default_cost" | "retail_price" | "bin"
  | "qty_epc" | "category" | "subcategory_1";

const COL_COUNT = 13;

/**
 * Default column widths — same order as the header config below
 * (system_id is hidden so its width is irrelevant). Picked to fit the
 * longest content seen in real catalogs without extra slack. Operators
 * can drag the resize handle on any column header to adjust.
 *
 * NOTE: catalog is the only table with hardcoded defaults — every other
 * table that adopts the shared resize primitive starts with all-null
 * (browser-sized) widths and lets the operator drag/auto-fit on demand.
 */
const DEFAULT_COL_WIDTHS: (number | null)[] = [
  null, // system_id (hidden)
  130,  // sku
  90,   // upc
  200,  // name
  130,  // color (fits "GREY WASHED" + chevron)
  70,   // size
  100,  // default cost (fits header + "$XXX.XX")
  100,  // retail price (fits header + "$XXX.XX")
  80,   // bin
  90,   // qty (epc) — centered numerals
  90,   // rfid (fits 78px badge + table padding)
  110,  // category
  120,  // subcategory 1
];

function useColResize(tableRef: React.RefObject<HTMLTableElement | null>) {
  return useSharedColResize(tableRef, COL_COUNT, {
    initialWidths: DEFAULT_COL_WIDTHS,
  });
}

export function CatalogWorkspace({
  canTriggerLightspeedSync = false,
  canManageCatalog = false,
}: {
  canTriggerLightspeedSync?: boolean;
  canManageCatalog?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sortBy, setSortBy] = useState("");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [modalSku, setModalSku] = useState<CatalogGridRow | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncPreviewOpen, setSyncPreviewOpen] = useState(false);
  const [catalogMenuOpen, setCatalogMenuOpen] = useState<null | "lightspeed" | "more">(null);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [defectiveOpen, setDefectiveOpen] = useState(false);
  const [manualItemsOpen, setManualItemsOpen] = useState(false);
  const [historyForSku, setHistoryForSku] = useState<string | null>(null);
  const [detailsRow, setDetailsRow] = useState<CatalogGridRow | null>(null);
  const [movingRow, setMovingRow] = useState<CatalogGridRow | null>(null);
  const [manualMatrixUpc, setManualMatrixUpc] = useState("");
  const [manualDesc, setManualDesc] = useState("");
  const [manualSku, setManualSku] = useState("");
  const [manualVendor, setManualVendor] = useState("");
  const [manualColor, setManualColor] = useState("");
  const [manualSize, setManualSize] = useState("");
  const [manualRetail, setManualRetail] = useState("");
  const [manualVariantUpc, setManualVariantUpc] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualErr, setManualErr] = useState<string | null>(null);
  const [importCsvText, setImportCsvText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [manualOnly, setManualOnly] = useState(false);
  const [pageSizeChoice, setPageSizeChoice] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(
    DEFAULT_PAGE_SIZE,
  );
  const effectivePageSize =
    pageSizeChoice === "ALL" ? ALL_LIMIT : (pageSizeChoice as number);
  const catalogToolbarRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { colWidths, autoFit, startDrag } = useColResize(tableRef);
  const autoFitDoneRef = useRef(false);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 320);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debounced]);

  useEffect(() => {
    setPage(1);
  }, [sortBy, sortDir]);

  const url = useMemo(
    () => buildGridUrl(page, debounced, sortBy, sortDir, showArchived, manualOnly, effectivePageSize),
    [page, debounced, sortBy, sortDir, showArchived, manualOnly, effectivePageSize],
  );

  useEffect(() => {
    setPage(1);
  }, [showArchived]);

  useEffect(() => {
    setPage(1);
  }, [manualOnly]);

  useEffect(() => {
    setPage(1);
  }, [pageSizeChoice]);

  const { data, error, isLoading, mutate } = useSWR<{
    rows: CatalogGridRow[];
    total: number;
    brands: string[];
    categories: string[];
    vendors: string[];
  }>(url, fetcher, { revalidateOnFocus: false });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / effectivePageSize));

  // Auto-fit on load is disabled — we ship with hardcoded DEFAULT_COL_WIDTHS
  // (see top of file) so layout is predictable across reloads. Operators can
  // still double-click a header to fit one column to its content, or drag the
  // resize handle. autoFitDoneRef remains because autoFit() still uses it.
  void autoFitDoneRef;
  void autoFit;

  const closeModal = useCallback(() => setModalSku(null), []);

  const submitManualCatalogLine = useCallback(async () => {
    setManualErr(null);
    setManualBusy(true);
    try {
      const res = await fetch("/api/inventory/catalog/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matrixUpc: manualMatrixUpc.trim(),
          matrixDescription: manualDesc.trim(),
          sku: manualSku.trim(),
          vendor: manualVendor.trim() || null,
          color: manualColor.trim() || null,
          size: manualSize.trim() || null,
          retailPrice: manualRetail.trim() || null,
          variantUpc: manualVariantUpc.trim() || null,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Create failed");
      setManualMatrixUpc("");
      setManualDesc("");
      setManualSku("");
      setManualVendor("");
      setManualColor("");
      setManualSize("");
      setManualRetail("");
      setManualVariantUpc("");
      setNewItemOpen(false);
      setSyncMsg("Manual catalog line created.");
      await mutate();
    } catch (e) {
      setManualErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setManualBusy(false);
    }
  }, [
    manualMatrixUpc,
    manualDesc,
    manualSku,
    manualVendor,
    manualColor,
    manualSize,
    manualRetail,
    manualVariantUpc,
    mutate,
  ]);

  const runCatalogCsvImport = useCallback(async () => {
    setImportErr(null);
    setImportSummary(null);
    setImportBusy(true);
    try {
      const res = await fetch("/api/inventory/catalog/import-csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText: importCsvText }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        rowsCreated?: number;
        rowResults?: { line: number; ok: boolean; error?: string }[];
      };
      if (!res.ok) throw new Error(j.error ?? "Import failed");
      const failed = (j.rowResults ?? []).filter((r) => !r.ok);
      const failNote =
        failed.length > 0
          ? ` ${failed.length} row(s) failed. First errors: ${failed
              .slice(0, 5)
              .map((r) => `L${r.line}: ${r.error ?? "?"}`)
              .join("; ")}`
          : "";
      setImportSummary(`Imported ${j.rowsCreated ?? 0} line(s).${failNote}`);
      await mutate();
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setImportBusy(false);
    }
  }, [importCsvText, mutate]);

  const triggerLightspeedSync = useCallback(async () => {
    setSyncBusy(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/inventory/sync/trigger", { method: "POST" });
      const j = (await res.json()) as {
        error?: string;
        message?: string;
        records_updated?: number;
        source?: string;
      };
      if (!res.ok) throw new Error(j.error ?? "Sync failed");
      const parts = [j.message ?? "Sync finished."];
      if (typeof j.records_updated === "number") parts.push(`${j.records_updated} row(s) updated.`);
      if (j.source) parts.push(`Source: ${j.source}.`);
      setSyncMsg(parts.join(" "));
      await mutate();
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncBusy(false);
    }
  }, [mutate]);

  useEffect(() => {
    if (!catalogMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const el = catalogToolbarRef.current;
      if (!el || !(e.target instanceof Node) || el.contains(e.target)) return;
      setCatalogMenuOpen(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [catalogMenuOpen]);

  const showCatalogEmpty = !isLoading && total === 0 && !debounced;
  const showNoMatches = !isLoading && total === 0 && Boolean(debounced);

  const pagination = !showCatalogEmpty && total > 0 && (
    <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">
      <div className="flex flex-wrap items-center gap-3">
        <span>
          {total} row{total === 1 ? "" : "s"} · page {page} / {totalPages}
        </span>
        <label className="flex items-center gap-1.5">
          <span className="uppercase tracking-wide">per page</span>
          <select
            value={String(pageSizeChoice)}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "ALL") setPageSizeChoice("ALL");
              else setPageSizeChoice(Number(v) as (typeof PAGE_SIZE_OPTIONS)[number]);
            }}
            className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-0.5 font-mono text-[0.65rem] text-[var(--wms-fg)]"
          >
            {PAGE_SIZE_OPTIONS.map((opt) => (
              <option key={String(opt)} value={String(opt)}>
                {opt === "ALL" ? "ALL" : opt}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          className="rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] px-3 py-1 font-medium text-[var(--wms-fg)] shadow-sm hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))] disabled:opacity-45 disabled:text-[var(--wms-muted)]"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
          className="rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] px-3 py-1 font-medium text-[var(--wms-fg)] shadow-sm hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))] disabled:opacity-45 disabled:text-[var(--wms-muted)]"
        >
          Next
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, SKU, UPC, system ID…"
              className="w-full max-w-md rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)] md:max-w-lg"
            />
          </div>

          <div
            ref={catalogToolbarRef}
            className="flex flex-wrap items-center justify-end gap-2 border-b border-[var(--wms-border)]/80 pb-3"
          >
            {canManageCatalog ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setManualErr(null);
                    setNewItemOpen(true);
                  }}
                  className="rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-3 py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90"
                >
                  New
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setImportErr(null);
                    setImportSummary(null);
                    setImportOpen(true);
                  }}
                  className="rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-3 py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90"
                >
                  Import
                </button>
              </>
            ) : (
              <span className="font-mono text-[0.6rem] text-[var(--wms-muted)]" title="Admin scope required">
                New / Import · admin only
              </span>
            )}
            <button
              type="button"
              aria-pressed={showArchived}
              onClick={() => setShowArchived((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 font-mono text-xs font-semibold shadow-sm ${
                showArchived
                  ? "border-amber-500/55 bg-amber-500/15 text-amber-200 hover:opacity-90 dark:bg-amber-950/40"
                  : "border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] text-[var(--wms-fg)] hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))]"
              }`}
              title={
                showArchived
                  ? "Archived items are visible — click to hide"
                  : "Archived items are hidden — click to include them"
              }
            >
              <Archive className="h-3.5 w-3.5" />
              {showArchived ? "Archived: ON" : "Show archived"}
            </button>
            <button
              type="button"
              onClick={() => exportLightspeedCatalogCsv(rows)}
              className="rounded-md border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-xs font-semibold text-[var(--wms-fg)] shadow-sm hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))]"
            >
              Export
            </button>
            <button
              type="button"
              aria-pressed={manualOnly}
              onClick={() => setManualOnly((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 font-mono text-xs font-semibold tracking-widest shadow-sm hover:opacity-90 ${
                manualOnly ? "" : "transition-colors"
              }`}
              style={
                manualOnly
                  ? {
                      borderColor: "color-mix(in srgb, oklch(82.8% 0.111 230.318) 55%, transparent)",
                      backgroundColor: "color-mix(in srgb, oklch(82.8% 0.111 230.318) 22%, var(--wms-surface-elevated))",
                      color: "oklch(82.8% 0.111 230.318)",
                    }
                  : {
                      borderColor: "color-mix(in srgb, oklch(82.8% 0.111 230.318) 45%, transparent)",
                      backgroundColor: "color-mix(in srgb, oklch(82.8% 0.111 230.318) 12%, var(--wms-surface-elevated))",
                      color: "oklch(82.8% 0.111 230.318)",
                    }
              }
              title={
                manualOnly
                  ? "Showing manual (non-RFID) items only — click to show all"
                  : "Show only manual (non-RFID) items"
              }
            >
              MANUAL ITEMS{manualOnly ? ": ON" : ""}
            </button>

            <div className="relative">
              <button
                type="button"
                onClick={() =>
                  setCatalogMenuOpen((m) => (m === "lightspeed" ? null : "lightspeed"))
                }
                className="inline-flex items-center gap-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs font-medium text-[var(--wms-fg)] hover:bg-[var(--wms-border)]"
              >
                Lightspeed
                <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
              </button>
              {catalogMenuOpen === "lightspeed" ? (
                <div
                  className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-1 shadow-xl"
                  role="menu"
                >
                  <button
                    type="button"
                    role="menuitem"
                    disabled={syncBusy || !canTriggerLightspeedSync}
                    onClick={() => {
                      setCatalogMenuOpen(null);
                      setSyncPreviewOpen(true);
                    }}
                    className="block w-full px-3 py-2 text-left font-mono text-xs font-medium text-[var(--wms-accent)] hover:bg-[color-mix(in_srgb,var(--wms-accent)_10%,var(--wms-surface-elevated))] disabled:opacity-50"
                  >
                    {syncBusy ? "Syncing…" : "Sync Lightspeed"}
                  </button>
                  <Link
                    href="/integrations/sync"
                    role="menuitem"
                    onClick={() => setCatalogMenuOpen(null)}
                    className="block w-full px-3 py-2 text-left font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
                  >
                    Open Lightspeed sync workspace
                  </Link>
                  <Link
                    href="/integrations/sync"
                    role="menuitem"
                    onClick={() => setCatalogMenuOpen(null)}
                    className="block w-full px-3 py-2 text-left font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
                  >
                    Job queue &amp; history
                  </Link>
                </div>
              ) : null}
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() => setCatalogMenuOpen((m) => (m === "more" ? null : "more"))}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-xs font-semibold text-[var(--wms-fg)] shadow-sm hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))]"
              >
                More
                <ChevronDown className="h-3.5 w-3.5 opacity-90" aria-hidden />
              </button>
              {catalogMenuOpen === "more" ? (
                <div
                  className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-1 shadow-xl"
                  role="menu"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setCatalogMenuOpen(null);
                      setManualItemsOpen(true);
                    }}
                    className="block w-full px-3 py-2 text-left font-mono text-xs text-[var(--wms-fg)] hover:bg-[color-mix(in_srgb,var(--wms-muted)_18%,var(--wms-surface-elevated))]"
                  >
                    Manual Items
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setCatalogMenuOpen(null);
                      setDefectiveOpen(true);
                    }}
                    className="block w-full px-3 py-2 text-left font-mono text-xs text-[var(--wms-fg)] hover:bg-[color-mix(in_srgb,var(--wms-muted)_18%,var(--wms-surface-elevated))]"
                  >
                    Defective EPC&apos;s
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled
                    title="Not implemented yet"
                    onClick={() => setCatalogMenuOpen(null)}
                    className="block w-full cursor-not-allowed px-3 py-2 text-left font-mono text-xs text-[var(--wms-muted)]"
                  >
                    Bulk tag assign (soon)
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled
                    title="Not implemented yet"
                    onClick={() => setCatalogMenuOpen(null)}
                    className="block w-full cursor-not-allowed px-3 py-2 text-left font-mono text-xs text-[var(--wms-muted)]"
                  >
                    Bulk archive (soon)
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {syncMsg ? (
            <p className="font-mono text-xs text-[var(--wms-muted)]" role="status">
              {syncMsg}
            </p>
          ) : null}
          {!canTriggerLightspeedSync ? (
            <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
              Full sync API may require admin.{" "}
              <Link href="/integrations/sync" className="text-teal-500 hover:underline">
                Lightspeed sync
              </Link>
            </p>
          ) : null}
      </div>

      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Load failed"}
        </p>
      ) : null}

      {showCatalogEmpty ? (
        <div className="rounded-xl border border-[var(--wms-border)]/90 bg-gradient-to-b from-[var(--wms-surface)] to-[var(--wms-surface-elevated)] px-8 py-16 text-center">
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.25em] text-teal-500/80">
            Lightspeed catalog
          </p>
          <h2 className="mt-3 text-lg font-semibold tracking-tight text-[var(--wms-fg)]">
            No synchronized catalog yet
          </h2>
          <p className="mx-auto mt-2 max-w-md font-mono text-xs leading-relaxed text-[var(--wms-muted)]">
            Run Sync Lightspeed (admins) or open the sync dashboard to pull item matrices from Lightspeed. Quantities show total on-hand when the POS API returns stock data (R-Series qoh / shops; X-Series when inventory fields are present). Active EPC counts reflect in-stock RFID tags at your active location.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {canTriggerLightspeedSync ? (
              <button
                type="button"
                onClick={() => void triggerLightspeedSync()}
                className="inline-flex items-center justify-center rounded-lg border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-6 py-3 font-mono text-sm font-semibold text-[var(--wms-accent-fg)] shadow-sm transition-opacity hover:opacity-90"
              >
                Sync Lightspeed
              </button>
            ) : null}
            <Link
              href="/integrations/sync"
              className="inline-flex items-center justify-center rounded-lg border border-[var(--wms-border)]/50 bg-[var(--wms-surface-elevated)]/40 px-6 py-3 font-mono text-sm font-medium text-[var(--wms-fg)] transition-colors hover:bg-[var(--wms-surface-elevated)]/50"
            >
              Sync dashboard
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="relative">
            <style>{`
              .wms-catalog-scroll { scrollbar-width: none; }
              .wms-catalog-scroll::-webkit-scrollbar { display: none; }
            `}</style>
            <div ref={scrollRef} className="wms-catalog-scroll overflow-auto rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]" style={{ maxHeight: "calc(100vh - 200px)" }}>
            <table
              ref={tableRef}
              className="w-full min-w-[1200px] border-collapse text-left"
              style={{ tableLayout: "auto" }}
            >
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono uppercase tracking-wide">
                  {(
                    [
                      // System ID column kept in DOM for data access but
                      // hidden from UI per stakeholder request — still pulled
                      // by the API and present on every row object.
                      { key: "system_id", label: "System ID", cls: "text-teal-400/80", hidden: true },
                      { key: "sku", label: "Custom SKU", noClip: true },
                      { key: "upc", label: "UPC", noClip: true },
                      { key: "name", label: "Item name", noClip: true },
                      { key: "color", label: "Color", noClip: true },
                      { key: "size", label: "Size" },
                      { key: "default_cost", label: "Default cost" },
                      { key: "retail_price", label: "Retail price" },
                      { key: "bin", label: "Bin" },
                      { key: "qty_epc", label: "Qty (EPC)", align: "center" },
                      { key: "rfid", label: "RFID", sortable: false },
                      { key: "category", label: "Category" },
                      { key: "subcategory_1", label: "Subcategory 1" },
                    ] as { key: SortKey | "rfid"; label: string; cls?: string; align?: string; sortable?: boolean; hidden?: boolean; noClip?: boolean }[]
                  ).map(({ key, label, cls, align, sortable, hidden, noClip }, colIdx) => {
                    const isSortable = sortable !== false;
                    const active = isSortable && sortBy === key;
                    const next = active && sortDir === "asc" ? "desc" : "asc";
                    const Icon = active ? (sortDir === "asc" ? ChevronUp : ChevronDown) : ChevronsUpDown;
                    const w = colWidths[colIdx];
                    /* noClip columns (Custom SKU, UPC, Item name, Color): operator
                       wants full text always visible. We give them minWidth (so
                       defaults still apply) but no width cap, and drop the
                       overflow-hidden so content can push the column wider in
                       table-layout: auto. */
                    const widthStyle = w !== null
                      ? noClip
                        ? { minWidth: w }
                        : { width: w, minWidth: w }
                      : undefined;
                    return (
                      <th
                        key={key}
                        style={widthStyle}
                        className={`relative px-2 py-2 ${noClip ? "" : "overflow-hidden"} ${align === "right" ? "text-right" : align === "center" ? "text-center" : ""} ${cls ?? ""} ${hidden ? "hidden" : ""}`}
                      >
                        {isSortable ? (
                          <button
                            type="button"
                            onClick={() => { setSortBy(key as SortKey); setSortDir(active ? next : "asc"); }}
                            className={`inline-flex items-center gap-1 hover:text-[var(--wms-fg)] ${active ? "text-[var(--wms-accent)]" : "text-[var(--wms-muted)]"}`}
                          >
                            {label}
                            <Icon className="h-3 w-3 shrink-0 opacity-70" />
                          </button>
                        ) : (
                          <span className="text-[var(--wms-muted)]">{label}</span>
                        )}
                        <ResizeHandle colIdx={colIdx} startDrag={startDrag} autoFit={autoFit} />
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-[var(--wms-fg)]">
                {isLoading ? (
                  <tr>
                    <td colSpan={13} className="px-4 py-10 text-center text-[var(--wms-muted)]">
                      Loading catalog…
                    </td>
                  </tr>
                ) : showNoMatches ? (
                  <tr>
                    <td colSpan={13} className="px-4 py-14 text-center text-[var(--wms-muted)]">
                      <p className="font-mono text-sm text-[var(--wms-muted)]">No rows match your search.</p>
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => {
                    const isArchived = r.archived || r.matrix_archived;
                    const archivedRowCls = isArchived
                      ? "bg-[var(--wms-surface-elevated)]/40 italic text-[var(--wms-muted)]"
                      : "";
                    return (
                    <tr
                      key={r.custom_sku_id}
                      className={`hover:bg-[var(--wms-surface-elevated)]/50 ${archivedRowCls}`}
                      title={isArchived ? "Archived in Lightspeed" : undefined}
                    >
                      <td className="hidden overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1.5 tabular-nums text-teal-400/85">
                        {r.sku_ls_system_id ?? "—"}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <button
                          type="button"
                          onClick={() => setDetailsRow(r)}
                          className="text-left text-[var(--wms-accent)] underline-offset-2 hover:underline"
                          title="View item details"
                        >
                          {r.sku}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-[var(--wms-muted)]">{displayUpc(r)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-[var(--wms-fg)]" title={r.name}>
                        {r.pinned_bin_code ? (
                          <span
                            className="mr-1.5 inline-block align-[-2px] text-emerald-400"
                            title={`item in "${r.pinned_bin_code.toLowerCase()}" bin`}
                            aria-label={`pinned to ${r.pinned_bin_code} bin`}
                          >
                            <Pin className="inline h-3.5 w-3.5" />
                          </span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => setDetailsRow(r)}
                          className="text-left text-[var(--wms-fg)] underline-offset-2 hover:underline"
                          title="View item details"
                        >
                          {r.name}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-[var(--wms-muted)]">{r.color?.trim() || "—"}</td>
                      <td className="overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1.5 text-[var(--wms-muted)]">{r.size?.trim() || "—"}</td>
                      <td className="overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1.5 tabular-nums text-[var(--wms-fg)]">
                        {formatPrice(r.default_cost)}
                      </td>
                      <td className="overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1.5 tabular-nums text-[var(--wms-fg)]">
                        {formatPrice(r.retail_price)}
                      </td>
                      <td className="overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1.5 text-[var(--wms-muted)]">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="truncate">{r.bin_location ?? "—"}</span>
                          {r.is_manual_only ? null : (
                            <button
                              type="button"
                              onClick={() => setMovingRow(r)}
                              title="Move all in-stock EPCs of this (UPC, color) — all sizes — into a bin"
                              aria-label="Move to bin"
                              className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-[var(--wms-accent)]/45 bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] text-[var(--wms-accent)] hover:opacity-90"
                            >
                              <PackageOpen className="h-3 w-3" strokeWidth={2} />
                            </button>
                          )}
                        </span>
                      </td>
                      <td className="overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1.5 text-center tabular-nums text-[var(--wms-fg)]">
                        {r.active_epc_count}
                      </td>
                      <td className="overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1.5">
                        {r.is_manual_only ? (
                          <button
                            type="button"
                            onClick={() => setHistoryForSku(r.custom_sku_id)}
                            className="inline-flex h-[22px] w-[78px] items-center justify-center rounded border border-sky-400/45 bg-sky-400/15 px-2 text-[0.6rem] font-medium leading-none tracking-widest text-sky-400 hover:opacity-90"
                            title="Manual (non-RFID) item — view qty history"
                            aria-label="Manual item — view qty history"
                          >
                            MANUAL
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setModalSku(r)}
                            className="inline-flex h-[22px] w-[78px] items-center justify-center gap-1 rounded border border-[var(--wms-accent)]/45 bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] px-2 text-[0.6rem] font-medium text-[var(--wms-accent)] hover:opacity-90 dark:text-[var(--wms-accent)]"
                            title="RFID item — view EPCs"
                            aria-label="RFID item — view EPCs"
                          >
                            <Radio className="h-3 w-3" />
                            EPCs
                          </button>
                        )}
                      </td>
                      <td className="overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1.5 text-[var(--wms-muted)]" title={r.category ?? undefined}>
                        {r.category?.trim() || "—"}
                      </td>
                      <td className="overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1.5 text-[var(--wms-muted)]" title={r.subcategory_1 ?? undefined}>
                        {r.subcategory_1?.trim() || "—"}
                      </td>
                    </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            </div>
            <ThickScrollbars scrollRef={scrollRef} />
          </div>
          {pagination}
        </>
      )}

      {newItemOpen ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-[60] bg-black/70"
            onClick={() => setNewItemOpen(false)}
          />
          <div className="fixed inset-0 z-[70] flex max-h-screen items-center justify-center overflow-y-auto p-4">
            <div className="my-4 w-full max-w-lg rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-6 shadow-2xl">
              <h3 className="text-sm font-semibold text-[var(--wms-fg)]">New catalog item</h3>
              <p className="mt-2 font-mono text-xs leading-relaxed text-[var(--wms-muted)]">
                Creates or updates a matrix by UPC and adds a custom SKU (synthetic negative Lightspeed id).
                No EPCs until you encode tags.
              </p>
              <div className="mt-4 grid gap-3 font-mono text-xs">
                <label className="grid gap-1">
                  <span className="text-[var(--wms-muted)]">Matrix UPC (required)</span>
                  <input
                    value={manualMatrixUpc}
                    onChange={(e) => setManualMatrixUpc(e.target.value)}
                    className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-[var(--wms-muted)]">Description (required)</span>
                  <input
                    value={manualDesc}
                    onChange={(e) => setManualDesc(e.target.value)}
                    className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-[var(--wms-muted)]">Custom SKU (required)</span>
                  <input
                    value={manualSku}
                    onChange={(e) => setManualSku(e.target.value)}
                    className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-[var(--wms-muted)]">Variant UPC (optional)</span>
                  <input
                    value={manualVariantUpc}
                    onChange={(e) => setManualVariantUpc(e.target.value)}
                    className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="grid gap-1">
                    <span className="text-[var(--wms-muted)]">Vendor</span>
                    <input
                      value={manualVendor}
                      onChange={(e) => setManualVendor(e.target.value)}
                      className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-[var(--wms-muted)]">Retail price</span>
                    <input
                      value={manualRetail}
                      onChange={(e) => setManualRetail(e.target.value)}
                      placeholder="29.99"
                      className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="grid gap-1">
                    <span className="text-[var(--wms-muted)]">Color</span>
                    <input
                      value={manualColor}
                      onChange={(e) => setManualColor(e.target.value)}
                      className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-[var(--wms-muted)]">Size</span>
                    <input
                      value={manualSize}
                      onChange={(e) => setManualSize(e.target.value)}
                      className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-fg)]"
                    />
                  </label>
                </div>
              </div>
              {manualErr ? (
                <p className="mt-3 font-mono text-xs text-red-400/90">{manualErr}</p>
              ) : null}
              <div className="mt-6 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setNewItemOpen(false)}
                  className="rounded-md border border-[var(--wms-border)] px-4 py-2 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={
                    manualBusy ||
                    !manualMatrixUpc.trim() ||
                    !manualDesc.trim() ||
                    !manualSku.trim()
                  }
                  onClick={() => void submitManualCatalogLine()}
                  className="rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-4 py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90 disabled:opacity-40"
                >
                  {manualBusy ? "Creating…" : "Create"}
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {importOpen ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-[60] bg-black/70"
            onClick={() => setImportOpen(false)}
          />
          <div className="fixed inset-0 z-[70] flex max-h-screen items-center justify-center overflow-y-auto p-4">
            <div className="my-4 w-full max-w-2xl rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-6 shadow-2xl">
              <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Import catalog (CSV)</h3>
              <p className="mt-2 font-mono text-xs leading-relaxed text-[var(--wms-muted)]">
                Headers must include <span className="text-teal-500/90">matrix_upc</span> (or upc),{" "}
                <span className="text-teal-500/90">sku</span>, and{" "}
                <span className="text-teal-500/90">name</span> (or description). Optional: vendor, color,
                size, retail_price.
              </p>
              <input
                type="file"
                className="mt-3 block w-full font-mono text-xs text-[var(--wms-muted)] file:mr-3 file:rounded file:border file:border-[var(--wms-border)] file:bg-[var(--wms-surface-elevated)] file:px-3 file:py-1.5 file:text-[var(--wms-fg)]"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () => setImportCsvText(String(reader.result ?? ""));
                  reader.readAsText(f, "UTF-8");
                }}
              />
              <textarea
                value={importCsvText}
                onChange={(e) => setImportCsvText(e.target.value)}
                placeholder="Or paste CSV here…"
                rows={10}
                className="mt-3 w-full resize-y rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-[0.65rem] text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)]"
              />
              {importErr ? (
                <p className="mt-2 font-mono text-xs text-red-400/90">{importErr}</p>
              ) : null}
              {importSummary ? (
                <p className="mt-2 font-mono text-xs text-[var(--wms-muted)]">{importSummary}</p>
              ) : null}
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setImportOpen(false)}
                  className="rounded-md border border-[var(--wms-border)] px-4 py-2 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
                >
                  Close
                </button>
                <button
                  type="button"
                  disabled={importBusy || !importCsvText.trim()}
                  onClick={() => void runCatalogCsvImport()}
                  className="rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-4 py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90 disabled:opacity-40"
                >
                  {importBusy ? "Importing…" : "Run import"}
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {modalSku ? (
        <RfidTagsModal
          modalSku={modalSku}
          onClose={closeModal}
          onMutated={() => void mutate()}
        />
      ) : null}

      {defectiveOpen ? (
        <DefectiveEpcsModal onClose={() => setDefectiveOpen(false)} />
      ) : null}

      {manualItemsOpen ? (
        <ManualItemsModal
          onClose={() => setManualItemsOpen(false)}
          onMutated={() => void mutate()}
        />
      ) : null}

      {historyForSku ? (
        <ItemHistoryModal
          customSkuId={historyForSku}
          onClose={() => setHistoryForSku(null)}
          onMutated={() => void mutate()}
        />
      ) : null}

      {detailsRow ? (
        <CatalogItemDetailsModal
          row={detailsRow}
          canManage={canManageCatalog}
          onClose={() => setDetailsRow(null)}
          onMutated={() => void mutate()}
        />
      ) : null}

      {movingRow ? (
        <CatalogBinMoveDialog
          skuPrefix={computeSkuPrefix(movingRow.sku)}
          name={movingRow.name}
          color={movingRow.color}
          onClose={() => setMovingRow(null)}
          onDone={() => {
            setMovingRow(null);
            void mutate();
          }}
        />
      ) : null}

      <SyncPreviewModal
        open={syncPreviewOpen}
        onClose={() => setSyncPreviewOpen(false)}
        onConfirmed={(jobId) => {
          startSyncJobTracking(jobId);
          setSyncMsg(null);
          // Catalog list refreshes when job completes; the floater handles user-facing feedback.
          // We trigger an immediate first refresh in case the apply finishes quickly.
          void mutate();
        }}
      />
    </div>
  );
}
