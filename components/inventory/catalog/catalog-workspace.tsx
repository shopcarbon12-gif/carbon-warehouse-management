"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Radio, X } from "lucide-react";
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

export function CatalogWorkspace() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [modalSku, setModalSku] = useState<CatalogGridRow | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 320);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debounced]);

  const url = useMemo(() => buildGridUrl(page, debounced), [page, debounced]);

  const { data, error, isLoading } = useSWR<{
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search system ID, description, SKU, UPC…"
          className="w-full max-w-md rounded-md border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 md:max-w-lg"
        />
      </div>

      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Load failed"}
        </p>
      ) : null}

      {showCatalogEmpty ? (
        <div className="rounded-xl border border-slate-800/90 bg-gradient-to-b from-zinc-950 to-zinc-900/80 px-8 py-16 text-center">
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.25em] text-teal-500/80">
            Matrix catalog
          </p>
          <h2 className="mt-3 text-lg font-semibold tracking-tight text-slate-100">
            No synchronized catalog yet
          </h2>
          <p className="mx-auto mt-2 max-w-md font-mono text-xs leading-relaxed text-slate-500">
            Pull matrices and custom SKUs from Lightspeed (or run the dev simulation) to populate this
            grid. RFID tag counts below reflect in-stock EPCs at your active location.
          </p>
          <Link
            href="/inventory/sync"
            className="mt-8 inline-flex items-center justify-center rounded-lg border border-violet-600/50 bg-violet-950/30 px-6 py-3 font-mono text-sm font-medium text-violet-200 transition-colors hover:bg-violet-900/35"
          >
            Go to Sync dashboard
          </Link>
        </div>
      ) : (
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
                <th className="px-2 py-2 w-24">RFID</th>
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
      )}

      {!showCatalogEmpty && total > 0 ? (
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
