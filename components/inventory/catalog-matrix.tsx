"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  CircleCheck,
  Package,
  Package2,
  ShoppingBag,
  Tag,
  X,
} from "lucide-react";
import type {
  CatalogMatrixRow,
  CatalogCustomSkuRow,
  CatalogItemRow,
} from "@/lib/queries/catalog";

function StatusGlyph({ status }: { status: CatalogMatrixRow["status_key"] }) {
  const common = "h-4 w-4 shrink-0";
  switch (status) {
    case "no_custom_skus":
      return <Package2 className={`${common} text-slate-500`} strokeWidth={1.75} aria-hidden />;
    case "no_inventory":
      return <Package className={`${common} text-amber-500/90`} strokeWidth={1.75} aria-hidden />;
    case "in_stock":
      return <CircleCheck className={`${common} text-teal-400`} strokeWidth={1.75} aria-hidden />;
    case "sold_out":
      return <ShoppingBag className={`${common} text-slate-500`} strokeWidth={1.75} aria-hidden />;
    case "mixed":
    default:
      return <AlertCircle className={`${common} text-amber-400`} strokeWidth={1.75} aria-hidden />;
  }
}

function statusLabel(status: CatalogMatrixRow["status_key"]): string {
  switch (status) {
    case "no_custom_skus":
      return "No custom SKUs";
    case "no_inventory":
      return "No EPCs at location";
    case "in_stock":
      return "In stock";
    case "sold_out":
      return "All sold";
    case "mixed":
    default:
      return "Mixed status";
  }
}

export function CatalogMatrix({ initialMatrices }: { initialMatrices: CatalogMatrixRow[] }) {
  const [expandedMatrixId, setExpandedMatrixId] = useState<string | null>(null);
  const [customSkuCache, setCustomSkuCache] = useState<Record<string, CatalogCustomSkuRow[]>>({});
  const [customSkuLoading, setCustomSkuLoading] = useState<string | null>(null);

  const [drawerCustomSku, setDrawerCustomSku] = useState<CatalogCustomSkuRow | null>(null);
  const [drawerMatrixUpc, setDrawerMatrixUpc] = useState<string>("");
  const [itemRows, setItemRows] = useState<CatalogItemRow[] | null>(null);
  const [itemLoading, setItemLoading] = useState(false);

  const loadCustomSkus = useCallback(async (matrixId: string) => {
    setCustomSkuLoading(matrixId);
    try {
      const res = await fetch(
        `/api/inventory/catalog?matrixId=${encodeURIComponent(matrixId)}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as CatalogCustomSkuRow[];
      setCustomSkuCache((c) => ({ ...c, [matrixId]: data }));
    } finally {
      setCustomSkuLoading(null);
    }
  }, []);

  const toggleMatrix = useCallback(
    (matrixId: string) => {
      setExpandedMatrixId((cur) => {
        const next = cur === matrixId ? null : matrixId;
        if (next && customSkuCache[matrixId] === undefined) {
          void loadCustomSkus(matrixId);
        }
        return next;
      });
    },
    [loadCustomSkus, customSkuCache],
  );

  const openDrawer = useCallback(
    (e: React.MouseEvent, cs: CatalogCustomSkuRow, matrixUpc: string) => {
      e.stopPropagation();
      setDrawerCustomSku(cs);
      setDrawerMatrixUpc(matrixUpc);
      setItemRows(null);
      setItemLoading(true);
      void (async () => {
        try {
          const res = await fetch(
            `/api/inventory/catalog?customSkuId=${encodeURIComponent(cs.id)}`,
          );
          if (!res.ok) {
            setItemRows([]);
            return;
          }
          const data = (await res.json()) as CatalogItemRow[];
          setItemRows(data);
        } catch {
          setItemRows([]);
        } finally {
          setItemLoading(false);
        }
      })();
    },
    [],
  );

  const closeDrawer = useCallback(() => {
    setDrawerCustomSku(null);
    setItemRows(null);
  }, []);

  useEffect(() => {
    if (!drawerCustomSku) return;
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
  }, [drawerCustomSku, closeDrawer]);

  return (
    <div className="min-w-0">
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full min-w-[900px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-slate-800 bg-zinc-900 font-mono text-[0.7rem] uppercase tracking-wider text-slate-400">
              <th className="w-10 px-2 py-2.5" aria-hidden />
              <th className="w-12 px-2 py-2.5 text-center">Sts</th>
              <th className="px-3 py-2.5">UPC</th>
              <th className="px-3 py-2.5">Description</th>
              <th className="w-28 px-3 py-2.5 text-right">Custom SKUs</th>
              <th className="w-32 px-3 py-2.5 text-right">On-hand EPCs</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 bg-zinc-950">
            {initialMatrices.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-10 text-center font-mono text-sm text-slate-500"
                >
                  No matrices in catalog. Seed data or import from Lightspeed.
                </td>
              </tr>
            ) : (
              initialMatrices.map((m) => {
                const open = expandedMatrixId === m.id;
                const customSkus = customSkuCache[m.id];
                const loadingCs = customSkuLoading === m.id;
                return (
                  <Fragment key={m.id}>
                    <tr
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleMatrix(m.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleMatrix(m.id);
                        }
                      }}
                      className="cursor-pointer text-slate-200 hover:bg-zinc-900/80"
                    >
                      <td className="px-2 py-2 align-middle">
                        <ChevronRight
                          className={`mx-auto h-4 w-4 text-slate-500 transition-transform ${
                            open ? "rotate-90" : ""
                          }`}
                          strokeWidth={2}
                          aria-hidden
                        />
                      </td>
                      <td className="px-2 py-2 text-center align-middle">
                        <span title={statusLabel(m.status_key)} className="inline-flex">
                          <StatusGlyph status={m.status_key} />
                        </span>
                      </td>
                      <td className="px-3 py-2 align-middle font-mono text-xs text-teal-400/90">
                        {m.upc}
                      </td>
                      <td className="max-w-md truncate px-3 py-2 align-middle font-medium text-slate-100">
                        {m.description}
                      </td>
                      <td className="px-3 py-2 text-right align-middle font-mono text-xs tabular-nums text-slate-300">
                        {m.custom_sku_count}
                      </td>
                      <td className="px-3 py-2 text-right align-middle font-mono text-xs tabular-nums text-slate-300">
                        {m.epc_count}
                      </td>
                    </tr>
                    {open ? (
                      <tr className="bg-black/20">
                        <td colSpan={6} className="p-0">
                          <div className="border-t border-slate-800 px-2 py-3 pl-10">
                            {loadingCs || customSkus === undefined ? (
                              <p className="font-mono text-xs text-slate-500">
                                Loading custom SKUs…
                              </p>
                            ) : customSkus.length === 0 ? (
                              <p className="font-mono text-xs text-slate-500">
                                No custom SKUs for this matrix.
                              </p>
                            ) : (
                              <table className="w-full border-collapse text-left text-xs">
                                <thead>
                                  <tr className="border-b border-slate-800 bg-zinc-900 text-[0.65rem] uppercase tracking-wide text-slate-500">
                                    <th className="w-10 px-2 py-2" aria-hidden />
                                    <th className="px-2 py-2">Custom SKU</th>
                                    <th className="px-2 py-2">Color</th>
                                    <th className="px-2 py-2">Size</th>
                                    <th className="px-2 py-2 font-mono">LS ID</th>
                                    <th className="w-24 py-2 text-right">EPCs</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800/80">
                                  {customSkus.map((cs) => (
                                    <tr key={cs.id} className="text-slate-300">
                                      <td className="px-2 py-1.5 align-middle">
                                        <button
                                          type="button"
                                          title="Item group detail (EPCs)"
                                          className="rounded p-1 text-teal-500 hover:bg-slate-800 hover:text-teal-300"
                                          onClick={(e) => openDrawer(e, cs, m.upc)}
                                        >
                                          <Tag className="h-3.5 w-3.5" strokeWidth={2} />
                                        </button>
                                      </td>
                                      <td className="px-2 py-1.5 font-mono text-[0.7rem] text-slate-200">
                                        {cs.sku}
                                      </td>
                                      <td className="px-2 py-1.5 text-slate-400">
                                        {cs.color_code ?? "—"}
                                      </td>
                                      <td className="px-2 py-1.5 text-slate-400">
                                        {cs.size ?? "—"}
                                      </td>
                                      <td className="px-2 py-1.5 font-mono text-[0.65rem] text-slate-500">
                                        {cs.ls_system_id}
                                      </td>
                                      <td className="py-1.5 text-right font-mono tabular-nums text-slate-400">
                                        {cs.epc_count}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {drawerCustomSku ? (
        <>
          <button
            type="button"
            aria-label="Close modal"
            className="fixed inset-0 z-[60] bg-black/70"
            onClick={closeDrawer}
          />
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center p-4"
            role="presentation"
          >
            <div
              className="flex max-h-[min(85vh,40rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-800 bg-zinc-950 shadow-2xl"
              role="dialog"
              aria-modal="true"
              aria-labelledby="catalog-modal-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 border-b border-slate-800 bg-zinc-900 px-4 py-3">
                <div className="min-w-0">
                  <h2
                    id="catalog-modal-title"
                    className="text-sm font-semibold text-slate-100"
                  >
                    Items for custom SKU
                  </h2>
                  <p className="mt-1 font-mono text-[0.65rem] leading-relaxed text-slate-500">
                    <span className="text-teal-500/90">{drawerMatrixUpc}</span>
                    <span className="text-slate-600"> · </span>
                    <span className="text-slate-400">{drawerCustomSku.sku}</span>
                  </p>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                  onClick={closeDrawer}
                  aria-label="Close"
                >
                  <X className="h-5 w-5" strokeWidth={1.75} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {itemLoading ? (
                  <p className="font-mono text-xs text-slate-500">Loading EPCs…</p>
                ) : itemRows && itemRows.length === 0 ? (
                  <p className="font-mono text-xs text-slate-500">No items at this location.</p>
                ) : itemRows ? (
                  <table className="w-full border-collapse text-left text-xs">
                    <thead className="sticky top-0 z-10">
                      <tr className="border-b border-slate-800 bg-zinc-900 font-mono text-[0.65rem] uppercase tracking-wide text-slate-500">
                        <th className="px-2 py-2">Serial #</th>
                        <th className="px-2 py-2">EPC (96-bit)</th>
                        <th className="px-2 py-2">Bin</th>
                        <th className="px-2 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {itemRows.map((row) => (
                        <tr key={`${row.epc}-${row.serial_number}`} className="text-slate-300">
                          <td className="px-2 py-1.5 font-mono tabular-nums text-slate-400">
                            {row.serial_number}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-[0.65rem] text-teal-400/85">
                            {row.epc}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-[0.7rem] text-slate-400">
                            {row.bin_code}
                          </td>
                          <td className="px-2 py-1.5 text-slate-400">{row.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
