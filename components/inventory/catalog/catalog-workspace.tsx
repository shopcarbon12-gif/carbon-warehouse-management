"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { ChevronDown, Radio, X } from "lucide-react";
import type { CatalogGridRow } from "@/lib/server/inventory-catalog";
import type { CatalogItemRow } from "@/lib/queries/catalog";

const PAGE_SIZE = 50;

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

function buildGridUrl(page: number, q: string): string {
  const p = new URLSearchParams({
    view: "grid",
    page: String(page),
    limit: String(PAGE_SIZE),
  });
  if (q.trim()) p.set("q", q.trim());
  return `/api/inventory/catalog?${p}`;
}

function displayUpc(r: CatalogGridRow): string {
  const v = r.sku_upc?.trim();
  if (v) return v;
  return r.matrix_upc?.trim() || "—";
}

function formatAttributes(r: CatalogGridRow): string {
  const c = r.color?.trim() || "—";
  const s = r.size?.trim() || "—";
  return `${c} · ${s}`;
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
    "Item Name",
    "Custom SKU",
    "UPC",
    "Vendor",
    "Color",
    "Size",
    "Retail Price",
    "Quantity (LS)",
  ];
  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((r) =>
      [
        r.name,
        r.sku,
        displayUpc(r),
        r.vendor?.trim() ?? "",
        r.color?.trim() ?? "",
        r.size?.trim() ?? "",
        r.retail_price?.trim() ?? "",
        r.ls_on_hand_total != null && Number.isFinite(r.ls_on_hand_total)
          ? String(r.ls_on_hand_total)
          : "",
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

type TabId = "lightspeed" | "rfid";

export function CatalogWorkspace({
  canTriggerLightspeedSync = false,
  canManageCatalog = false,
}: {
  canTriggerLightspeedSync?: boolean;
  canManageCatalog?: boolean;
}) {
  const [tab, setTab] = useState<TabId>("lightspeed");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [modalSku, setModalSku] = useState<CatalogGridRow | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [catalogMenuOpen, setCatalogMenuOpen] = useState<null | "lightspeed" | "more">(null);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
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
  const catalogToolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 320);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debounced]);

  const url = useMemo(() => buildGridUrl(page, debounced), [page, debounced]);

  const { data, error, isLoading, mutate } = useSWR<{
    rows: CatalogGridRow[];
    total: number;
    brands: string[];
    categories: string[];
    vendors: string[];
  }>(url, fetcher, { revalidateOnFocus: false });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const { data: itemData, isLoading: itemsLoading } = useSWR<CatalogItemRow[]>(
    modalSku
      ? `/api/inventory/catalog?customSkuId=${encodeURIComponent(modalSku.custom_sku_id)}`
      : null,
    fetcher,
    { revalidateOnFocus: false },
  );

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

  useEffect(() => {
    if (!modalSku) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [modalSku, closeModal]);

  const showCatalogEmpty = !isLoading && total === 0 && !debounced;
  const showNoMatches = !isLoading && total === 0 && Boolean(debounced);

  const pagination = !showCatalogEmpty && total > 0 && (
    <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">
      <span>
        {total} row{total === 1 ? "" : "s"} · page {page} / {totalPages}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          className="rounded border border-[var(--wms-border)] px-3 py-1 text-[var(--wms-fg)] disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
          className="rounded border border-[var(--wms-border)] px-3 py-1 text-[var(--wms-fg)] disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Catalog view"
        className="flex flex-wrap gap-2 border-b border-[var(--wms-border)] pb-2"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "lightspeed"}
          onClick={() => setTab("lightspeed")}
          className={`rounded-t-md px-4 py-2 font-mono text-xs uppercase tracking-wide ${
            tab === "lightspeed"
              ? "border border-b-0 border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-teal-300/90"
              : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          }`}
        >
          Lightspeed catalog
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "rfid"}
          onClick={() => setTab("rfid")}
          className={`rounded-t-md px-4 py-2 font-mono text-xs uppercase tracking-wide ${
            tab === "rfid"
              ? "border border-b-0 border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-teal-300/90"
              : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          }`}
        >
          RFID &amp; EPCs
        </button>
      </div>

      {tab === "lightspeed" ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, SKU, UPC, vendor…"
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
                  className="rounded-md bg-emerald-600 px-3 py-2 font-mono text-xs font-semibold text-white hover:bg-emerald-500"
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
                  className="rounded-md bg-blue-600 px-3 py-2 font-mono text-xs font-semibold text-white hover:bg-blue-500"
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
              onClick={() => exportLightspeedCatalogCsv(rows)}
              className="rounded-md bg-emerald-600 px-3 py-2 font-mono text-xs font-semibold text-white hover:bg-emerald-500"
            >
              Export
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
                      void triggerLightspeedSync();
                    }}
                    className="block w-full px-3 py-2 text-left font-mono text-xs text-teal-200 hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50"
                  >
                    {syncBusy ? "Syncing…" : "Sync Lightspeed"}
                  </button>
                  <Link
                    href="/inventory/sync"
                    role="menuitem"
                    onClick={() => setCatalogMenuOpen(null)}
                    className="block w-full px-3 py-2 text-left font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
                  >
                    Open Lightspeed sync workspace
                  </Link>
                  <Link
                    href="/inventory/sync"
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
                className="inline-flex items-center gap-1 rounded-md bg-orange-600 px-3 py-2 font-mono text-xs font-semibold text-white hover:bg-orange-500"
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
              <Link href="/inventory/sync" className="text-teal-500 hover:underline">
                Lightspeed sync
              </Link>
            </p>
          ) : null}
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search system ID, description, SKU, UPC…"
            className="w-full max-w-md rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)] md:max-w-lg"
          />
        </div>
      )}

      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Load failed"}
        </p>
      ) : null}

      {showCatalogEmpty ? (
        <div className="rounded-xl border border-[var(--wms-border)]/90 bg-gradient-to-b from-[var(--wms-surface)] to-[var(--wms-surface-elevated)] px-8 py-16 text-center">
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.25em] text-teal-500/80">
            {tab === "lightspeed" ? "Lightspeed catalog" : "RFID matrix"}
          </p>
          <h2 className="mt-3 text-lg font-semibold tracking-tight text-[var(--wms-fg)]">
            No synchronized catalog yet
          </h2>
          <p className="mx-auto mt-2 max-w-md font-mono text-xs leading-relaxed text-[var(--wms-muted)]">
            {tab === "lightspeed"
              ? "Run Sync Lightspeed (admins) or open the sync dashboard to pull item matrices from Lightspeed. Quantities show total on-hand when the POS API returns stock data (R-Series qoh / shops; X-Series when inventory fields are present)."
              : "Pull matrices and custom SKUs from Lightspeed first. RFID tag counts reflect in-stock EPCs at your active location."}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {canTriggerLightspeedSync ? (
              <button
                type="button"
                onClick={() => void triggerLightspeedSync()}
                className="inline-flex items-center justify-center rounded-lg border border-violet-600/50 bg-violet-950/30 px-6 py-3 font-mono text-sm font-medium text-violet-200 transition-colors hover:bg-violet-900/35"
              >
                Sync Lightspeed
              </button>
            ) : null}
            <Link
              href="/inventory/sync"
              className="inline-flex items-center justify-center rounded-lg border border-[var(--wms-border)]/50 bg-[var(--wms-surface-elevated)]/40 px-6 py-3 font-mono text-sm font-medium text-[var(--wms-fg)] transition-colors hover:bg-[var(--wms-surface-elevated)]/50"
            >
              Sync dashboard
            </Link>
          </div>
        </div>
      ) : tab === "lightspeed" ? (
        <>
          <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
            <table className="w-full min-w-[1000px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
                  <th className="px-2 py-2">Item name</th>
                  <th className="px-2 py-2">Custom SKU</th>
                  <th className="px-2 py-2">UPC</th>
                  <th className="px-2 py-2">Vendor</th>
                  <th className="px-2 py-2">Color</th>
                  <th className="px-2 py-2">Size</th>
                  <th className="px-2 py-2 text-right">Retail price</th>
                  <th className="px-2 py-2 text-right tabular-nums">Qty (LS)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-[0.65rem] text-[var(--wms-fg)]">
                {isLoading ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-[var(--wms-muted)]">
                      Loading catalog…
                    </td>
                  </tr>
                ) : showNoMatches ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-14 text-center text-[var(--wms-muted)]">
                      <p className="font-mono text-sm text-[var(--wms-muted)]">No rows match your search.</p>
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.custom_sku_id} className="hover:bg-[var(--wms-surface-elevated)]/50">
                      <td className="max-w-[220px] truncate px-2 py-1.5 text-[var(--wms-fg)]" title={r.name}>
                        {r.name}
                      </td>
                      <td className="px-2 py-1.5">{r.sku}</td>
                      <td className="px-2 py-1.5 text-[var(--wms-muted)]">{displayUpc(r)}</td>
                      <td className="max-w-[140px] truncate px-2 py-1.5 text-[var(--wms-muted)]" title={r.vendor ?? ""}>
                        {r.vendor?.trim() || "—"}
                      </td>
                      <td className="px-2 py-1.5 text-[var(--wms-muted)]">{r.color?.trim() || "—"}</td>
                      <td className="px-2 py-1.5 text-[var(--wms-muted)]">{r.size?.trim() || "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-[var(--wms-fg)]">
                        {formatPrice(r.retail_price)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-teal-400/85">
                        {r.ls_on_hand_total != null && Number.isFinite(r.ls_on_hand_total)
                          ? r.ls_on_hand_total
                          : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {pagination}
        </>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
            <table className="w-full min-w-[960px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
                  <th className="px-2 py-2">System ID (matrix)</th>
                  <th className="px-2 py-2">Custom SKU</th>
                  <th className="px-2 py-2">UPC</th>
                  <th className="px-2 py-2">Description</th>
                  <th className="px-2 py-2">Attributes</th>
                  <th className="px-2 py-2 text-right tabular-nums">Active EPCs</th>
                  <th className="w-24 px-2 py-2">RFID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-[0.65rem] text-[var(--wms-fg)]">
                {isLoading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-[var(--wms-muted)]">
                      Loading catalog…
                    </td>
                  </tr>
                ) : showNoMatches ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-14 text-center text-[var(--wms-muted)]">
                      <p className="font-mono text-sm text-[var(--wms-muted)]">No rows match your search.</p>
                      <p className="mt-2 text-[0.65rem] text-[var(--wms-muted)]">
                        Try another query or clear the search box.
                      </p>
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.custom_sku_id} className="hover:bg-[var(--wms-surface-elevated)]/50">
                      <td className="px-2 py-1.5 text-teal-400/85">
                        {r.matrix_ls_system_id ?? "—"}
                      </td>
                      <td className="px-2 py-1.5">{r.sku}</td>
                      <td className="px-2 py-1.5 text-[var(--wms-muted)]">{displayUpc(r)}</td>
                      <td className="max-w-[240px] truncate px-2 py-1.5 text-[var(--wms-fg)]" title={r.name}>
                        {r.name}
                      </td>
                      <td className="px-2 py-1.5 text-[var(--wms-muted)]">{formatAttributes(r)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-[var(--wms-fg)]">
                        {r.active_epc_count}
                      </td>
                      <td className="px-2 py-1.5">
                        <button
                          type="button"
                          onClick={() => setModalSku(r)}
                          className="inline-flex items-center gap-1 rounded border border-teal-600/40 bg-teal-950/20 px-2 py-1 text-[0.6rem] text-teal-300/90 hover:bg-teal-900/25"
                        >
                          <Radio className="h-3 w-3" />
                          EPCs
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
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
                  className="rounded-md bg-emerald-600 px-4 py-2 font-mono text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
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
                  className="rounded-md bg-blue-600 px-4 py-2 font-mono text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
                >
                  {importBusy ? "Importing…" : "Run import"}
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {modalSku ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-[60] bg-black/70"
            onClick={closeModal}
          />
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div className="max-h-[min(90vh,560px)] w-full max-w-lg overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
              <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-3">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--wms-fg)]">RFID tags</h3>
                  <p className="mt-0.5 font-mono text-[0.6rem] text-[var(--wms-muted)]">
                    {modalSku.sku} · UPC {displayUpc(modalSku)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="max-h-[420px] overflow-y-auto p-4">
                {itemsLoading ? (
                  <p className="font-mono text-xs text-[var(--wms-muted)]">Loading EPCs…</p>
                ) : !itemData || itemData.length === 0 ? (
                  <p className="py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
                    No items at the active location for this custom SKU.
                  </p>
                ) : (
                  <ul className="space-y-2 font-mono text-[0.65rem]">
                    {itemData.map((it) => (
                      <li
                        key={it.epc}
                        className="rounded border border-[var(--wms-border)]/80 bg-[var(--wms-surface-elevated)]/50 px-3 py-2"
                      >
                        <div className="text-teal-400/90">{it.epc}</div>
                        <div className="mt-1 text-[var(--wms-muted)]">
                          #{it.serial_number} · {it.status} · bin {it.bin_code}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
