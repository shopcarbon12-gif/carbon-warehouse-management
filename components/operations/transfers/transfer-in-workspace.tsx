"use client";

/**
 * Transfer In (v2) — receive an in-transit transfer at the destination.
 *
 * Layout differs from Transfer Out: instead of choosing a destination dropdown,
 * the operator picks a pending **transfer** (whose destination matches their
 * session location, or any location if admin overrides). The picked transfer's
 * contents drive the staged table. RFID rows are confirmed by scanning the EPC
 * (which must be in-transit AND attached to this transfer); Manual rows are
 * confirmed with a single click since there is nothing to scan.
 *
 * On commit (Receive):
 *   * RFID items flip back to status='in-stock', bin_id auto-routed to the bin
 *     where most existing in-stock items of the same SKU live at this destination.
 *   * Destination-side inventory_adjustments flip from 'in-transit' to 'settled'.
 *   * Transfer record state goes 'partially_received' or 'received'.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Radio, ScanLine, RefreshCw, ChevronDown, ChevronRight, Printer } from "lucide-react";
import { ReaderPicker } from "@/components/shared/reader-picker";
import { PrintActionsModal } from "./print-actions-modal";

type LocationRow = { id: string; code: string; name: string };

type PendingRow = {
  id: string;
  slip_number: number | null;
  source_location_id: string;
  source_location_code: string;
  source_location_name: string;
  destination_location_id: string;
  destination_location_code: string;
  destination_location_name: string;
  state: string;
  rfid_count: number;
  manual_count: number;
  rfid_pending: number;
  manual_pending: number;
  created_at: string;
  created_by_name: string | null;
  notes: string | null;
};

type DetailRfidRow = {
  epc: string;
  serial_number: string | null;
  custom_sku_id: string;
  sku: string;
  sku_ls_system_id: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  upc: string | null;
  retail_price: string | null;
  received: boolean;
};

type DetailManualRow = {
  adjustment_id: string;
  custom_sku_id: string;
  sku: string;
  sku_ls_system_id: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  upc: string | null;
  retail_price: string | null;
  qty: number;
  state: string;
};

type DetailResponse = {
  id: string;
  slip_number: number | null;
  state: string;
  created_at: string;
  source_location_id: string;
  destination_location_id: string;
  source_location_code: string;
  source_location_name: string;
  destination_location_code: string;
  destination_location_name: string;
  rfid: DetailRfidRow[];
  manual: DetailManualRow[];
};

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? r.statusText);
  }
  return r.json();
};

type Props = {
  sessionLocationId: string;
  isAdmin: boolean;
};

type SkuRowData = {
  custom_sku_id: string;
  sku_ls_system_id: string | null;
  sku: string;
  name: string | null;
  color: string | null;
  size: string | null;
  upc: string | null;
  retail_price: string | null;
  sent: number;
  received: number;
  confirmed_in_session: number;
  rfid: DetailRfidRow[];
  manual: DetailManualRow[];
};

function FragmentLikeRow({
  open,
  onToggle,
  idx,
  g,
  sessionReceived,
  missing,
  confirmedEpcs,
  confirmedAdjustmentIds,
  toggleEpc,
  toggleManual,
  formatPrice,
  onPrint,
}: {
  open: boolean;
  onToggle: () => void;
  idx: number;
  g: SkuRowData;
  sessionReceived: number;
  missing: number;
  confirmedEpcs: Set<string>;
  confirmedAdjustmentIds: Set<string>;
  toggleEpc: (epc: string) => void;
  toggleManual: (adjustmentId: string) => void;
  formatPrice: (p: string | null) => string;
  onPrint: (epc: string | null) => void;
}) {
  // Drawer status helpers — RFID line: "received" (settled) | "checked"
  // (queued in this session) | "pending" (in-transit, not yet confirmed).
  // Manual line: same labels but mapped from adjustment state + session set.
  return (
    <>
      <tr
        className={`hover:bg-[var(--wms-surface-elevated)]/50 ${
          open ? "bg-[var(--wms-surface-elevated)]/40" : ""
        }`}
      >
        <td className="px-3 py-1.5 text-right tabular-nums text-[var(--wms-muted)]">
          {idx + 1}
        </td>
        <td className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5">
          {g.sku}
        </td>
        <td className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5 text-[var(--wms-muted)]">
          {g.upc ?? "—"}
        </td>
        <td
          className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5"
          title={g.name ?? undefined}
        >
          {g.name ?? "—"}
        </td>
        <td className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5 text-[var(--wms-muted)]">
          {g.color?.trim() || "—"}
        </td>
        <td className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5 text-[var(--wms-muted)]">
          {g.size?.trim() || "—"}
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums">
          {formatPrice(g.retail_price)}
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums">{g.sent}</td>
        <td className="px-3 py-1.5 text-right tabular-nums text-emerald-300">
          {sessionReceived}
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums">
          <span className={missing > 0 ? "text-red-400/90" : "text-[var(--wms-muted)]"}>
            {missing}
          </span>
        </td>
        <td className="px-2 py-1.5 text-right">
          <button
            type="button"
            onClick={onToggle}
            className="rounded p-1 text-[var(--wms-muted)] hover:bg-[var(--wms-surface)]/80"
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="bg-[var(--wms-surface)]/60">
          <td colSpan={11} className="px-0 py-0">
            <div className="border-y border-[var(--wms-border)]/60">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="bg-orange-900/15 font-mono text-[0.55rem] uppercase tracking-wider text-orange-200/90">
                  <tr>
                    <th className="w-10 px-3 py-1.5"></th>
                    <th className="px-3 py-1.5">Serial #</th>
                    <th className="px-3 py-1.5">EPC</th>
                    <th className="px-3 py-1.5">Status</th>
                    <th className="w-20 px-3 py-1.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--wms-border)]/40 font-mono text-[0.7rem] text-[var(--wms-fg)]">
                  {g.rfid.map((r) => {
                    const checked = r.received || confirmedEpcs.has(r.epc);
                    const status: "pending" | "checked" | "received" = r.received
                      ? "received"
                      : confirmedEpcs.has(r.epc)
                        ? "checked"
                        : "pending";
                    return (
                      <tr
                        key={r.epc}
                        className="hover:bg-[var(--wms-surface-elevated)]/40"
                      >
                        <td className="px-3 py-1">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={r.received}
                            onChange={() => toggleEpc(r.epc)}
                            className="h-3.5 w-3.5 cursor-pointer accent-[var(--wms-accent)]"
                          />
                        </td>
                        <td className="px-3 py-1 tabular-nums text-teal-400/85">
                          {r.serial_number ?? "—"}
                        </td>
                        <td className="px-3 py-1 tabular-nums text-[var(--wms-muted)]">
                          {r.epc}
                        </td>
                        <td className="px-3 py-1">
                          <StatusPill status={status} />
                        </td>
                        <td className="px-3 py-1 text-right">
                          <button
                            type="button"
                            onClick={() => onPrint(r.epc)}
                            className="inline-flex items-center gap-1 rounded border border-[var(--wms-border)] px-2 py-1 text-[0.6rem] text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
                            title="Print label"
                          >
                            <Printer className="h-3 w-3" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {g.manual.map((a) =>
                    Array.from({ length: a.qty }).map((_, i) => {
                      const checked =
                        a.state === "settled" || confirmedAdjustmentIds.has(a.adjustment_id);
                      const status: "pending" | "checked" | "received" =
                        a.state === "settled"
                          ? "received"
                          : confirmedAdjustmentIds.has(a.adjustment_id)
                            ? "checked"
                            : "pending";
                      return (
                        <tr
                          key={`${a.adjustment_id}-${i}`}
                          className="hover:bg-[var(--wms-surface-elevated)]/40"
                        >
                          <td className="px-3 py-1">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={a.state === "settled" || i > 0}
                              onChange={() => toggleManual(a.adjustment_id)}
                              className="h-3.5 w-3.5 cursor-pointer accent-[var(--wms-accent)] disabled:opacity-50"
                              title={
                                i > 0
                                  ? "All units of this manual line confirm together"
                                  : undefined
                              }
                            />
                          </td>
                          <td className="px-3 py-1 text-[var(--wms-muted)]">—</td>
                          <td className="px-3 py-1 text-[var(--wms-muted)]">
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[0.55rem] uppercase tracking-wider text-amber-300">
                              Manual
                            </span>
                          </td>
                          <td className="px-3 py-1">
                            <StatusPill status={status} />
                          </td>
                          <td className="px-3 py-1 text-right">
                            <button
                              type="button"
                              disabled
                              className="inline-flex items-center gap-1 rounded border border-[var(--wms-border)] px-2 py-1 text-[0.6rem] text-[var(--wms-muted)] opacity-40"
                              title="Manual lines have no EPC to reprint"
                            >
                              <Printer className="h-3 w-3" />
                            </button>
                          </td>
                        </tr>
                      );
                    }),
                  )}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function StatusPill({ status }: { status: "pending" | "checked" | "received" }) {
  const cls =
    status === "received"
      ? "bg-emerald-500/15 text-emerald-300"
      : status === "checked"
        ? "bg-teal-500/15 text-teal-300"
        : "bg-zinc-500/15 text-zinc-300";
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[0.55rem] uppercase tracking-wider ${cls}`}
    >
      {status}
    </span>
  );
}

export function TransferInWorkspace({ sessionLocationId, isAdmin }: Props) {
  const { data: locData } = useSWR<LocationRow[]>("/api/locations", fetcher);
  const locations = locData ?? [];

  // Destination defaults to session; admin can override.
  const [destLocationId, setDestLocationId] = useState(sessionLocationId);
  useEffect(() => {
    if (!isAdmin) setDestLocationId(sessionLocationId);
  }, [sessionLocationId, isAdmin]);

  // Pending transfer list for that destination.
  const pendingUrl = `/api/operations/transfers/pending?destinationLocationId=${encodeURIComponent(destLocationId)}`;
  const { data: pendingData, mutate: refreshPending } = useSWR<{ rows: PendingRow[] }>(
    destLocationId ? pendingUrl : null,
    fetcher,
    { revalidateOnFocus: true },
  );
  const pending = pendingData?.rows ?? [];

  // Selected transfer + detail.
  const [selectedTransferId, setSelectedTransferId] = useState<string>("");
  useEffect(() => {
    // If destination changes, drop selection.
    setSelectedTransferId("");
  }, [destLocationId]);

  const detailUrl = selectedTransferId
    ? `/api/operations/transfers/${encodeURIComponent(selectedTransferId)}`
    : null;
  const { data: detail, mutate: refreshDetail } = useSWR<DetailResponse>(
    detailUrl,
    fetcher,
    { revalidateOnFocus: true },
  );

  // Scan toggle + reader filter (same as Transfer Out).
  const [scanning, setScanning] = useState(false);
  const scanningRef = useRef(scanning);
  useEffect(() => {
    scanningRef.current = scanning;
  }, [scanning]);
  const [selectedReaders, setSelectedReaders] = useState<Set<string>>(() => new Set());
  const selectedReadersRef = useRef(selectedReaders);
  useEffect(() => {
    selectedReadersRef.current = selectedReaders;
  }, [selectedReaders]);

  // Locally-confirmed receipts before commit.
  // Keyed by EPC for RFID, adjustment_id for Manual. Both stage as Boolean true.
  const [confirmedEpcs, setConfirmedEpcs] = useState<Set<string>>(() => new Set());
  const [confirmedAdjustmentIds, setConfirmedAdjustmentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const confirmedEpcsRef = useRef(confirmedEpcs);
  useEffect(() => {
    confirmedEpcsRef.current = confirmedEpcs;
  }, [confirmedEpcs]);

  const detailRef = useRef<DetailResponse | undefined>(detail);
  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  const [toast, setToast] = useState<string | null>(null);
  const showToast = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => {
      setToast((cur) => (cur === m ? null : cur));
    }, 3500);
  }, []);

  // Reset confirmations when transfer changes.
  useEffect(() => {
    setConfirmedEpcs(new Set());
    setConfirmedAdjustmentIds(new Set());
  }, [selectedTransferId]);

  const [committing, setCommitting] = useState(false);
  const [printEpc, setPrintEpc] = useState<string | null>(null);

  // SSE — accept reads only when scanning && selected reader && EPC is part
  // of the chosen transfer + currently in-transit.
  useEffect(() => {
    const es = new EventSource("/api/edge/stream");
    es.onmessage = (ev) => {
      if (!scanningRef.current) return;
      if (!ev.data?.trim() || ev.data.startsWith(":")) return;
      let p: { scanContext?: string; epcs?: string[]; deviceId?: string };
      try {
        p = JSON.parse(ev.data) as {
          scanContext?: string;
          epcs?: string[];
          deviceId?: string;
        };
      } catch {
        return;
      }
      // No scanContext gate — receive flow validates each EPC against the
      // chosen pending transfer below, so accept reads regardless of the
      // antenna's bound context. Reader filter still applies.
      const sel = selectedReadersRef.current;
      if (sel.size > 0 && p.deviceId && !sel.has(p.deviceId)) return;
      const detailNow = detailRef.current;
      if (!detailNow) return;
      const transferEpcs = new Set(detailNow.rfid.map((r) => r.epc));
      const incoming = (p.epcs ?? [])
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => /^[0-9A-F]{24}$/.test(e));
      const matched: string[] = [];
      const mismatched: string[] = [];
      for (const e of incoming) {
        if (transferEpcs.has(e)) matched.push(e);
        else mismatched.push(e);
      }
      if (matched.length > 0) {
        setConfirmedEpcs((prev) => {
          const next = new Set(prev);
          matched.forEach((e) => next.add(e));
          return next;
        });
      }
      if (mismatched.length > 0) {
        showToast(
          `${mismatched.length} EPC${mismatched.length === 1 ? "" : "s"} not on this transfer — ignored.`,
        );
      }
    };
    return () => es.close();
  }, [showToast]);

  const toggleManual = useCallback((adjustmentId: string) => {
    setConfirmedAdjustmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(adjustmentId)) next.delete(adjustmentId);
      else next.add(adjustmentId);
      return next;
    });
  }, []);

  // Aggregate by SKU for the staged-look table.
  type SkuRow = {
    custom_sku_id: string;
    sku_ls_system_id: string | null;
    sku: string;
    name: string | null;
    color: string | null;
    size: string | null;
    upc: string | null;
    retail_price: string | null;
    sent: number;
    received: number;
    confirmed_in_session: number;
    rfid: DetailRfidRow[];
    manual: DetailManualRow[];
  };

  const grouped: SkuRow[] = useMemo(() => {
    if (!detail) return [];
    const map = new Map<string, SkuRow>();
    const ensure = (key: string, seed: Pick<SkuRow,
      "custom_sku_id" | "sku_ls_system_id" | "sku" | "name" | "color" | "size" | "upc" | "retail_price"
    >): SkuRow => {
      let g = map.get(key);
      if (!g) {
        g = {
          ...seed,
          sent: 0,
          received: 0,
          confirmed_in_session: 0,
          rfid: [],
          manual: [],
        };
        map.set(key, g);
      }
      return g;
    };
    for (const r of detail.rfid) {
      const g = ensure(r.custom_sku_id, {
        custom_sku_id: r.custom_sku_id,
        sku_ls_system_id: r.sku_ls_system_id,
        sku: r.sku,
        name: r.name,
        color: r.color,
        size: r.size,
        upc: r.upc,
        retail_price: r.retail_price,
      });
      g.rfid.push(r);
      g.sent += 1;
      if (r.received) g.received += 1;
      else if (confirmedEpcs.has(r.epc)) g.confirmed_in_session += 1;
    }
    for (const r of detail.manual) {
      const g = ensure(r.custom_sku_id, {
        custom_sku_id: r.custom_sku_id,
        sku_ls_system_id: r.sku_ls_system_id,
        sku: r.sku,
        name: r.name,
        color: r.color,
        size: r.size,
        upc: r.upc,
        retail_price: r.retail_price,
      });
      g.manual.push(r);
      g.sent += r.qty;
      if (r.state === "settled") g.received += r.qty;
      else if (confirmedAdjustmentIds.has(r.adjustment_id)) g.confirmed_in_session += r.qty;
    }
    return [...map.values()].sort((a, b) =>
      (a.name ?? a.sku ?? "").localeCompare(b.name ?? b.sku ?? ""),
    );
  }, [detail, confirmedEpcs, confirmedAdjustmentIds]);

  // Per-row drawer expand/collapse. SKUs default to closed.
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set());
  const toggleOpen = useCallback((skuId: string) => {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(skuId)) next.delete(skuId);
      else next.add(skuId);
      return next;
    });
  }, []);
  // Reset drawer state when transfer changes.
  useEffect(() => {
    setOpenRows(new Set());
  }, [selectedTransferId]);

  const toggleEpc = useCallback((epc: string) => {
    setConfirmedEpcs((prev) => {
      const next = new Set(prev);
      if (next.has(epc)) next.delete(epc);
      else next.add(epc);
      return next;
    });
  }, []);

  const formatPrice = (p: string | null): string => {
    if (!p) return "—";
    const n = Number(p);
    if (!Number.isFinite(n)) return "—";
    return `$${n.toFixed(2)}`;
  };

  const totalUnits = grouped.reduce((acc, g) => acc + g.sent, 0);
  const confirmedUnits = grouped.reduce((acc, g) => acc + g.confirmed_in_session, 0);

  const doReceive = useCallback(async () => {
    if (!selectedTransferId) return;
    if (confirmedEpcs.size === 0 && confirmedAdjustmentIds.size === 0) {
      showToast("Confirm at least one row to receive.");
      return;
    }
    setCommitting(true);
    try {
      const res = await fetch("/api/operations/transfers/receive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transferId: selectedTransferId,
          epcs: [...confirmedEpcs],
          manualConfirms: [...confirmedAdjustmentIds].map((id) => ({ adjustmentId: id })),
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        rfidReceived?: number;
        manualReceived?: number;
        state?: string;
      };
      if (!res.ok) {
        showToast(data.error ?? "Receive failed.");
        return;
      }
      showToast(
        `Received RFID×${data.rfidReceived ?? 0}, Manual×${data.manualReceived ?? 0}. State: ${data.state ?? "?"}.`,
      );
      setConfirmedEpcs(new Set());
      setConfirmedAdjustmentIds(new Set());
      setScanning(false);
      void refreshDetail();
      void refreshPending();
      // If the transfer is fully received, drop the selection.
      if (data.state === "received") setSelectedTransferId("");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Receive failed.");
    } finally {
      setCommitting(false);
    }
  }, [
    selectedTransferId,
    confirmedEpcs,
    confirmedAdjustmentIds,
    refreshDetail,
    refreshPending,
    showToast,
  ]);

  const destLabel = useMemo(() => {
    const l = locations.find((x) => x.id === destLocationId);
    return l ? `${l.code} — ${l.name}` : "—";
  }, [locations, destLocationId]);

  return (
    <div className="space-y-6">
      {/* Destination location */}
      <div className="grid gap-4 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-4 sm:grid-cols-2">
        <div>
          <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
            Destination location {!isAdmin ? "(locked to your session)" : "(admin override)"}
          </label>
          {isAdmin ? (
            <select
              value={destLocationId}
              onChange={(e) => setDestLocationId(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
            >
              <option value="">— Select —</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} — {l.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="mt-1 w-full cursor-not-allowed rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/50 px-3 py-2 font-mono text-sm text-[var(--wms-muted)]">
              {destLabel}
            </div>
          )}
        </div>
        <div className="font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
          Pending transfers for this destination
          <div className="mt-1 flex items-center gap-2">
            <select
              value={selectedTransferId}
              onChange={(e) => setSelectedTransferId(e.target.value)}
              className="flex-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-sm text-[var(--wms-fg)]"
            >
              <option value="">— Select transfer —</option>
              {pending.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.source_location_code} → {p.destination_location_code} · RFID×
                  {p.rfid_pending} · Manual×{p.manual_pending} ·{" "}
                  {new Date(p.created_at).toLocaleString()}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void refreshPending()}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 text-[var(--wms-muted)] hover:border-teal-500/40"
              title="Refresh pending list"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Scan controls */}
      <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <button
            type="button"
            disabled={!selectedTransferId}
            onClick={() => setScanning((s) => !s)}
            className={`inline-flex min-h-[3rem] min-w-[10rem] items-center justify-center gap-2 rounded-xl border px-5 py-3 font-mono text-sm font-semibold uppercase tracking-wide transition-colors disabled:opacity-40 ${
              scanning
                ? "border-amber-500/60 bg-amber-950/40 text-amber-100"
                : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)] hover:border-teal-500/40"
            }`}
          >
            <Radio
              className={`h-5 w-5 ${
                scanning ? "text-amber-400" : "text-[var(--wms-muted)]"
              }`}
            />
            {scanning ? "Scanning… (click to pause)" : "Start scan"}
          </button>
          <ReaderPicker
            selected={selectedReaders}
            onChange={setSelectedReaders}
            defaultReaderName="Transfer bin"
          />
          <button
            type="button"
            disabled={confirmedEpcs.size === 0 && confirmedAdjustmentIds.size === 0}
            onClick={() => {
              setConfirmedEpcs(new Set());
              setConfirmedAdjustmentIds(new Set());
              setScanning(false);
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-border)] px-4 py-2.5 font-mono text-xs text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40"
          >
            <ScanLine className="h-4 w-4" />
            Clear confirmations
          </button>
        </div>
        <p className="mt-3 font-mono text-[0.6rem] text-[var(--wms-muted)]">
          Scans must match an EPC on the chosen transfer. Manual rows are confirmed by clicking
          the row (no scan possible). RFID will auto-route to the bin most-used by this SKU at
          the destination, otherwise unbinned.
        </p>
      </div>

      {/* Staged table */}
      <div className="overflow-hidden rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80">
        <div className="border-b border-[var(--wms-border)] px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
          Receive payload — {grouped.length} SKU{grouped.length === 1 ? "" : "s"} ·{" "}
          {confirmedUnits} of {totalUnits} confirmed this session
        </div>
        <div className="max-h-[min(50vh,500px)] overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
              <tr className="border-b border-[var(--wms-border)]">
                <th className="w-10 px-3 py-2 text-right">#</th>
                <th className="px-3 py-2">Custom SKU</th>
                <th className="px-3 py-2">UPC</th>
                <th className="px-3 py-2">Item name</th>
                <th className="px-3 py-2">Color</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2 text-right">Price</th>
                <th className="px-3 py-2 text-right">Sent</th>
                <th className="px-3 py-2 text-right">Received</th>
                <th className="px-3 py-2 text-right">Missing</th>
                <th className="w-10 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-xs text-[var(--wms-fg)]">
              {grouped.length > 0 ? (
                grouped.map((g, idx) => {
                  const open = openRows.has(g.custom_sku_id);
                  const sessionReceived = g.received + g.confirmed_in_session;
                  const missing = Math.max(0, g.sent - sessionReceived);
                  return (
                    <FragmentLikeRow
                      key={g.custom_sku_id}
                      open={open}
                      onToggle={() => toggleOpen(g.custom_sku_id)}
                      idx={idx}
                      g={g}
                      sessionReceived={sessionReceived}
                      missing={missing}
                      confirmedEpcs={confirmedEpcs}
                      confirmedAdjustmentIds={confirmedAdjustmentIds}
                      toggleEpc={toggleEpc}
                      toggleManual={toggleManual}
                      formatPrice={formatPrice}
                      onPrint={(epc) => setPrintEpc(epc)}
                    />
                  );
                })
              ) : (
                <tr>
                  <td
                    colSpan={11}
                    className="p-6 text-center font-mono text-xs text-[var(--wms-muted)]"
                  >
                    {!selectedTransferId
                      ? "Pick a pending transfer above to start receiving."
                      : "This transfer is empty."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <button
        type="button"
        disabled={
          !selectedTransferId ||
          (confirmedEpcs.size === 0 && confirmedAdjustmentIds.size === 0) ||
          committing
        }
        onClick={() => void doReceive()}
        className="rounded-lg border border-emerald-600/50 bg-emerald-950/30 px-5 py-2.5 font-mono text-sm text-emerald-200 hover:bg-emerald-900/25 disabled:opacity-40"
      >
        {committing ? "Receiving…" : "Review & receive"}
      </button>

      {toast ? (
        <p className="font-mono text-xs text-amber-300/90" role="status">
          {toast}
        </p>
      ) : null}

      <PrintActionsModal
        open={printEpc !== null}
        epc={printEpc}
        onClose={() => setPrintEpc(null)}
      />
    </div>
  );
}
