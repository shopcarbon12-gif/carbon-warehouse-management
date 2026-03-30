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

export function CatalogWorkspace({ canTriggerLightspeedSync = false }: { canTriggerLightspeedSync?: boolean }) {
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
    <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[0.65rem] text-slate-500">
      <span>
        {total} row{total === 1 ? "" : "s"} · page {page} / {totalPages}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          className="rounded border border-slate-700 px-3 py-1 text-slate-300 disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
          className="rounded border border-slate-700 px-3 py-1 text-slate-300 disabled:opacity-40"
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
        className="flex flex-wrap gap-2 border-b border-slate-800 pb-2"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "lightspeed"}
          onClick={() => setTab("lightspeed")}
          className={`rounded-t-md px-4 py-2 font-mono text-xs uppercase tracking-wide ${
            tab === "lightspeed"
              ? "border border-b-0 border-slate-700 bg-zinc-900 text-teal-300/90"
              : "text-slate-500 hover:text-slate-300"
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
              ? "border border-b-0 border-slate-700 bg-zinc-900 text-teal-300/90"
              : "text-slate-500 hover:text-slate-300"
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
              className="w-full max-w-md rounded-md border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 md:max-w-lg"
            />
          </div>

          <div
            ref={catalogToolbarRef}
            className="flex flex-wrap items-center justify-end gap-2 border-b border-slate-800/80 pb-3"
          >
            <button
              type="button"
              onClick={() => {
                console.log("[catalog] New — manual item creation (placeholder)");
                setNewItemOpen(true);
              }}
              className="rounded-md bg-emerald-600 px-3 py-2 font-mono text-xs font-semibold text-white hover:bg-emerald-500"
            >
              New
            </button>
            <button
              type="button"
              onClick={() => {
                console.log("[catalog] Import — open file modal (placeholder)");
                setImportOpen(true);
              }}
              className="rounded-md bg-blue-600 px-3 py-2 font-mono text-xs font-semibold text-white hover:bg-blue-500"
            >
              Import
            </button>
            <button
              type="button"
              onClick={() => {
                console.log("[catalog] Export CSV");
                exportLightspeedCatalogCsv(rows);
              }}
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
                className="inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-800 px-3 py-2 font-mono text-xs font-medium text-slate-100 hover:bg-slate-700"
              >
                Lightspeed
                <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
              </button>
              {catalogMenuOpen === "lightspeed" ? (
                <div
                  className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-slate-700 bg-zinc-900 py-1 shadow-xl"
                  role="menu"
                >
                  <button
                    type="button"
                    role="menuitem"
                    disabled={syncBusy || !canTriggerLightspeedSync}
                    onClick={() => {
                      console.log("[catalog] Lightspeed → Sync Lightspeed");
                      setCatalogMenuOpen(null);
                      void triggerLightspeedSync();
                    }}
                    className="block w-full px-3 py-2 text-left font-mono text-xs text-teal-200 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {syncBusy ? "Syncing…" : "Sync Lightspeed"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      console.log("[catalog] Lightspeed placeholder: reconcile draft SKUs");
                      setCatalogMenuOpen(null);
                    }}
                    className="block w-full px-3 py-2 text-left font-mono text-xs text-slate-300 hover:bg-zinc-800"
                  >
                    Reconcile draft SKUs (placeholder)
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      console.log("[catalog] Lightspeed placeholder: open sync history");
                      setCatalogMenuOpen(null);
                    }}
                    className="block w-full px-3 py-2 text-left font-mono text-xs text-slate-300 hover:bg-zinc-800"
                  >
                    Open sync history (placeholder)
                  </button>
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
                  className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-slate-700 bg-zinc-900 py-1 shadow-xl"
                  role="menu"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      console.log("[catalog] More: bulk tag assign (placeholder)");
                      setCatalogMenuOpen(null);
                    }}
                    className="block w-full px-3 py-2 text-left font-mono text-xs text-slate-300 hover:bg-zinc-800"
                  >
                    Bulk tag assign (placeholder)
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      console.log("[catalog] More: bulk archive (placeholder)");
                      setCatalogMenuOpen(null);
                    }}
                    className="block w-full px-3 py-2 text-left font-mono text-xs text-slate-300 hover:bg-zinc-800"
                  >
                    Bulk archive (placeholder)
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {syncMsg ? (
            <p className="font-mono text-xs text-slate-500" role="status">
              {syncMsg}
            </p>
          ) : null}
          {!canTriggerLightspeedSync ? (
            <p className="font-mono text-[0.6rem] text-slate-600">
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
            className="w-full max-w-md rounded-md border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 md:max-w-lg"
          />
        </div>
      )}

      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Load failed"}
        </p>
      ) : null}

      {showCatalogEmpty ? (
        <div className="rounded-xl border border-slate-800/90 bg-gradient-to-b from-zinc-950 to-zinc-900/80 px-8 py-16 text-center">
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.25em] text-teal-500/80">
            {tab === "lightspeed" ? "Lightspeed catalog" : "RFID matrix"}
          </p>
          <h2 className="mt-3 text-lg font-semibold tracking-tight text-slate-100">
            No synchronized catalog yet
          </h2>
          <p className="mx-auto mt-2 max-w-md font-mono text-xs leading-relaxed text-slate-500">
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
              className="inline-flex items-center justify-center rounded-lg border border-slate-600/50 bg-slate-900/40 px-6 py-3 font-mono text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800/50"
            >
              Sync dashboard
            </Link>
          </div>
        </div>
      ) : tab === "lightspeed" ? (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full min-w-[1000px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-zinc-900 font-mono text-[0.6rem] uppercase tracking-wide text-slate-500">
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
              <tbody className="divide-y divide-slate-800/80 font-mono text-[0.65rem] text-slate-300">
                {isLoading ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                      Loading catalog…
                    </td>
                  </tr>
                ) : showNoMatches ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-14 text-center text-slate-600">
                      <p className="font-mono text-sm text-slate-500">No rows match your search.</p>
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.custom_sku_id} className="hover:bg-zinc-900/40">
                      <td className="max-w-[220px] truncate px-2 py-1.5 text-slate-200" title={r.name}>
                        {r.name}
                      </td>
                      <td className="px-2 py-1.5">{r.sku}</td>
                      <td className="px-2 py-1.5 text-slate-400">{displayUpc(r)}</td>
                      <td className="max-w-[140px] truncate px-2 py-1.5 text-slate-400" title={r.vendor ?? ""}>
                        {r.vendor?.trim() || "—"}
                      </td>
                      <td className="px-2 py-1.5 text-slate-500">{r.color?.trim() || "—"}</td>
                      <td className="px-2 py-1.5 text-slate-500">{r.size?.trim() || "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-300">
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
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full min-w-[960px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-zinc-900 font-mono text-[0.6rem] uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-2">System ID (matrix)</th>
                  <th className="px-2 py-2">Custom SKU</th>
                  <th className="px-2 py-2">UPC</th>
                  <th className="px-2 py-2">Description</th>
                  <th className="px-2 py-2">Attributes</th>
                  <th className="px-2 py-2 text-right tabular-nums">Active EPCs</th>
                  <th className="w-24 px-2 py-2">RFID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 font-mono text-[0.65rem] text-slate-300">
                {isLoading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                      Loading catalog…
                    </td>
                  </tr>
                ) : showNoMatches ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-14 text-center text-slate-600">
                      <p className="font-mono text-sm text-slate-500">No rows match your search.</p>
                      <p className="mt-2 text-[0.65rem] text-slate-600">
                        Try another query or clear the search box.
                      </p>
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.custom_sku_id} className="hover:bg-zinc-900/40">
                      <td className="px-2 py-1.5 text-teal-400/85">
                        {r.matrix_ls_system_id ?? "—"}
                      </td>
                      <td className="px-2 py-1.5">{r.sku}</td>
                      <td className="px-2 py-1.5 text-slate-400">{displayUpc(r)}</td>
                      <td className="max-w-[240px] truncate px-2 py-1.5 text-slate-200" title={r.name}>
                        {r.name}
                      </td>
                      <td className="px-2 py-1.5 text-slate-500">{formatAttributes(r)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-300">
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
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-xl border border-slate-800 bg-zinc-950 p-6 shadow-2xl">
              <h3 className="text-sm font-semibold text-slate-100">New catalog item</h3>
              <p className="mt-2 font-mono text-xs leading-relaxed text-slate-500">
                Placeholder: manual matrix / custom SKU creation is not wired yet. This will create items
                without EPCs in WMS once the API exists.
              </p>
              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={() => setNewItemOpen(false)}
                  className="rounded-md border border-slate-600 px-4 py-2 font-mono text-xs text-slate-300 hover:bg-zinc-800"
                >
                  Close
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
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-xl border border-slate-800 bg-zinc-950 p-6 shadow-2xl">
              <h3 className="text-sm font-semibold text-slate-100">Import catalog</h3>
              <p className="mt-2 font-mono text-xs text-slate-500">
                Upload a file (CSV / XLSX) — processing is a placeholder.
              </p>
              <input
                type="file"
                className="mt-4 block w-full font-mono text-xs text-slate-400 file:mr-3 file:rounded file:border file:border-slate-600 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-slate-200"
                accept=".csv,.xlsx,.xls"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  console.log("[catalog] Import file selected (placeholder)", f?.name ?? "(none)");
                }}
              />
              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={() => setImportOpen(false)}
                  className="rounded-md border border-slate-600 px-4 py-2 font-mono text-xs text-slate-300 hover:bg-zinc-800"
                >
                  Close
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
            <div className="max-h-[min(90vh,560px)] w-full max-w-lg overflow-hidden rounded-xl border border-slate-800 bg-zinc-950 shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">RFID tags</h3>
                  <p className="mt-0.5 font-mono text-[0.6rem] text-slate-500">
                    {modalSku.sku} · UPC {displayUpc(modalSku)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded p-2 text-slate-500 hover:bg-zinc-800"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="max-h-[420px] overflow-y-auto p-4">
                {itemsLoading ? (
                  <p className="font-mono text-xs text-slate-500">Loading EPCs…</p>
                ) : !itemData || itemData.length === 0 ? (
                  <p className="py-8 text-center font-mono text-xs text-slate-600">
                    No items at the active location for this custom SKU.
                  </p>
                ) : (
                  <ul className="space-y-2 font-mono text-[0.65rem]">
                    {itemData.map((it) => (
                      <li
                        key={it.epc}
                        className="rounded border border-slate-800/80 bg-zinc-900/40 px-3 py-2"
                      >
                        <div className="text-teal-400/90">{it.epc}</div>
                        <div className="mt-1 text-slate-500">
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
