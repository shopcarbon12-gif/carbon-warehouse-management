"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Eye, EyeOff, Pin, Radio, Send, Tag, X } from "lucide-react";
import type { CatalogGridRow } from "@/lib/server/inventory-catalog";
import type { CatalogItemRow } from "@/lib/queries/catalog";

type StatusLabelRow = {
  id: number;
  name: string;
  display_label: string;
  is_visible_to_scanner: boolean;
  is_visible_in_ui: boolean;
  is_system_only: boolean;
};

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

/* WMS items.status → display label per /settings/statuses convention. */
const WMS_TO_LABEL: Record<string, string> = {
  "in-stock": "LIVE",
  return: "RETURN",
  damaged: "DAMAGED",
  sold: "SOLD",
  stolen: "STOLEN",
  tag_killed: "TAG KILLED",
  pending_visibility: "PENDING VISIBILITY",
  "in-transit": "IN TRANSIT",
  pending_transaction: "PENDING TRANSACTION",
};
function displayStatus(wms: string): string {
  return WMS_TO_LABEL[wms] ?? wms.toUpperCase();
}

/* Status options surfaced in the bulk-change drawer (per user spec). */
const CHANGEABLE_STATUSES: { wms: string; label: string }[] = [
  { wms: "in-stock", label: "LIVE" },
  { wms: "return", label: "RETURN" },
  { wms: "damaged", label: "DAMAGED" },
  { wms: "sold", label: "SOLD" },
  { wms: "stolen", label: "STOLEN" },
  { wms: "tag_killed", label: "TAG KILLED" },
];

function formatLastSeen(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never";
  /* MM/DD/YY hh:mm AM/PM */
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  let h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd}/${yy} ${String(h).padStart(2, "0")}:${mi} ${ampm}`;
}

function statusPillClasses(status: string): string {
  switch (status) {
    case "in-stock":
      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/40";
    case "sold":
      return "bg-sky-500/15 text-sky-400 border-sky-500/40";
    case "return":
      return "bg-amber-500/15 text-amber-400 border-amber-500/40";
    case "damaged":
      return "bg-orange-500/15 text-orange-400 border-orange-500/40";
    case "stolen":
      return "bg-red-500/15 text-red-400 border-red-500/40";
    case "tag_killed":
      return "bg-zinc-600/25 text-zinc-300 border-zinc-500/40 line-through";
    default:
      return "bg-[var(--wms-surface-elevated)] text-[var(--wms-muted)] border-[var(--wms-border)]";
  }
}

export function RfidTagsModal({
  modalSku,
  onClose,
  onMutated,
}: {
  modalSku: CatalogGridRow;
  onClose: () => void;
  /** Called after a successful status change so the parent can re-fetch grid counts. */
  onMutated?: () => void;
}) {
  const { data: itemData, isLoading: itemsLoading, mutate: mutateItems } = useSWR<CatalogItemRow[]>(
    `/api/inventory/catalog?customSkuId=${encodeURIComponent(modalSku.custom_sku_id)}`,
    fetcher,
    { revalidateOnFocus: false },
  );

  const [showAllStatuses, setShowAllStatuses] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statusDrawerOpen, setStatusDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  /* One-click fan-out to every authorized handheld at the operator's active
     location. Unified with the Defective EPCs modal — no more per-device
     picker drawer; EPCs land on every handheld's Cloud + Geiger screen via
     POST /api/handhelds/epc-queue. */
  const handleSendToHandheld = useCallback(async () => {
    if (selected.size === 0 || busy) return;
    const epcs = [...selected];
    const ok = window.confirm(
      `Send ${epcs.length} EPC${epcs.length === 1 ? "" : "s"} to every handheld at your active location?\n\nThey'll appear on each handheld's Cloud + Geiger screen.`,
    );
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/handhelds/epc-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epcs }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        enqueued?: number;
        handhelds?: number;
        location?: { code?: string; name?: string };
        warning?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? "Send failed");
      if (j.warning) {
        setMsg(j.warning);
      } else {
        const where = j.location?.code
          ? `${j.location.code}${j.location.name ? ` — ${j.location.name}` : ""}`
          : "this location";
        setMsg(
          `Sent ${epcs.length} EPC${epcs.length === 1 ? "" : "s"} to ${j.handhelds ?? 0} handheld${
            (j.handhelds ?? 0) === 1 ? "" : "s"
          } at ${where}.`,
        );
        setSelected(new Set());
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }, [selected, busy]);

  /* Default visible: only items whose status maps to LIVE (in-stock). */
  const visibleItems = useMemo(() => {
    if (!itemData) return [];
    if (showAllStatuses) return itemData;
    return itemData.filter((it) => it.status === "in-stock");
  }, [itemData, showAllStatuses]);

  const allChecked = visibleItems.length > 0 && visibleItems.every((it) => selected.has(it.epc));
  const someChecked = visibleItems.some((it) => selected.has(it.epc));
  const selectedCount = selected.size;

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allChecked) {
        for (const it of visibleItems) next.delete(it.epc);
      } else {
        for (const it of visibleItems) next.add(it.epc);
      }
      return next;
    });
  }, [allChecked, visibleItems]);

  const toggleOne = useCallback((epc: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(epc)) next.delete(epc);
      else next.add(epc);
      return next;
    });
  }, []);

  /* Esc closes the outer modal. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !statusDrawerOpen) onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, statusDrawerOpen]);

  const headerLine = useMemo(() => {
    const head = visibleItems[0] ?? itemData?.[0];
    if (!head) return null;
    const partA = [head.name, head.color?.trim(), head.size?.trim()]
      .filter((v): v is string => !!v && v.length > 0)
      .join(" · ");
    return { partA, sku: head.sku };
  }, [visibleItems, itemData]);

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[60] bg-black/70"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 max-md:items-stretch max-md:p-0">
        <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl max-md:h-full max-md:max-h-none max-md:max-w-none max-md:rounded-none">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 border-b border-[var(--wms-border)] px-5 py-4">
            <div className="min-w-0 flex-1">
              <h3 className="flex items-center gap-2 text-base font-semibold text-[var(--wms-fg)]">
                <Tag className="h-4 w-4 text-[var(--wms-accent)]" />
                RFID tags
              </h3>
              <p className="mt-1.5 truncate font-mono text-base font-semibold tracking-tight text-[var(--wms-fg)]">
                {headerLine?.partA || modalSku.name}
                <span className="mx-2 text-[var(--wms-muted)]">|</span>
                <span className="text-[var(--wms-muted)]">Custom SKU:</span>{" "}
                {headerLine?.sku ?? modalSku.sku}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--wms-border)]/80 bg-[var(--wms-surface-elevated)]/30 px-5 py-3">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 font-mono text-sm text-[var(--wms-fg)]">
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = !allChecked && someChecked;
                  }}
                  onChange={toggleAll}
                  className="h-4 w-4 cursor-pointer accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
                />
                Select all ({visibleItems.length})
              </label>
              {selectedCount > 0 ? (
                <span className="font-mono text-xs text-[var(--wms-accent)]">
                  {selectedCount} selected
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowAllStatuses((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 font-mono text-xs font-semibold text-[var(--wms-fg)] hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))] max-md:min-h-11"
              >
                {showAllStatuses ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {showAllStatuses ? "Hide non-live" : "Show all statuses"}
              </button>
              <button
                type="button"
                disabled={selectedCount === 0 || busy}
                onClick={() => void handleSendToHandheld()}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-accent)]/45 bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] px-3 py-1.5 font-mono text-xs font-semibold text-[var(--wms-accent)] hover:opacity-90 disabled:opacity-40 max-md:min-h-11"
                title="Push these EPCs to every handheld at your active location (Cloud + Geiger screen)"
              >
                <Send className="h-3.5 w-3.5" />
                Send to handheld
              </button>
              <button
                type="button"
                disabled={selectedCount === 0}
                onClick={() => setStatusDrawerOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_14%,var(--wms-surface-elevated))] px-3 py-1.5 font-mono text-xs font-semibold text-[var(--wms-fg)] hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))] disabled:opacity-40 max-md:min-h-11"
              >
                Change status
              </button>
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto px-5 py-4 max-md:overscroll-contain">
            {itemsLoading ? (
              <p className="font-mono text-sm text-[var(--wms-muted)]">Loading EPCs…</p>
            ) : !itemData || itemData.length === 0 ? (
              <p className="py-10 text-center font-mono text-sm text-[var(--wms-muted)]">
                No items at the active location for this custom SKU.
              </p>
            ) : visibleItems.length === 0 ? (
              <p className="py-10 text-center font-mono text-sm text-[var(--wms-muted)]">
                No LIVE items. Click &quot;Show all statuses&quot; to see {itemData.length} non-live item(s).
              </p>
            ) : (
              <ul className="space-y-2 font-mono">
                {visibleItems.map((it) => {
                  const checked = selected.has(it.epc);
                  return (
                    <li
                      key={it.epc}
                      className={`flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors ${
                        checked
                          ? "border-[var(--wms-accent)]/50 bg-[color-mix(in_srgb,var(--wms-accent)_8%,var(--wms-surface-elevated))]"
                          : "border-[var(--wms-border)]/80 bg-[var(--wms-surface-elevated)]/40"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(it.epc)}
                        className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
                        aria-label={`Select EPC ${it.epc}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-base text-[var(--wms-fg)]">
                          <Radio className="h-3.5 w-3.5 shrink-0 text-[var(--wms-accent)]" />
                          <span className="truncate font-semibold tracking-tight text-teal-400/90 max-md:whitespace-normal max-md:break-all">
                            {it.epc}
                          </span>
                          {it.pinned_bin_code ? (
                            <span
                              className="inline-flex items-center gap-1 rounded border border-emerald-400/40 bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wide text-emerald-300 max-md:text-xs"
                              title={`Pinned to "${it.pinned_bin_code.toLowerCase()}" bin via cycle count`}
                            >
                              <Pin className="h-2.5 w-2.5" />
                              {it.pinned_bin_code.toLowerCase()}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--wms-muted)]">
                          <span>
                            <span className="text-[var(--wms-muted)]">Serial #:</span>{" "}
                            <span className="text-[var(--wms-fg)]">{it.serial_number}</span>
                          </span>
                          <span>·</span>
                          <span>
                            <span className="text-[var(--wms-muted)]">Bin:</span>{" "}
                            <span className="text-[var(--wms-fg)]">{it.bin_code || "—"}</span>
                          </span>
                          <span>·</span>
                          <span>
                            <span className="text-[var(--wms-muted)]">Last seen:</span>{" "}
                            <span className="text-[var(--wms-fg)]">{formatLastSeen(it.last_seen_at)}</span>
                          </span>
                          <span className="ml-auto">
                            <span
                              className={`inline-block rounded-md border px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide max-md:text-xs ${statusPillClasses(it.status)}`}
                            >
                              {displayStatus(it.status)}
                            </span>
                          </span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {msg ? (
              <p className="mt-3 font-mono text-xs text-[var(--wms-accent)]" role="status">
                {msg}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {statusDrawerOpen ? (
        <ChangeStatusDrawer
          epcs={[...selected]}
          busy={busy}
          setBusy={setBusy}
          onClose={() => setStatusDrawerOpen(false)}
          onChanged={async (n, label) => {
            setMsg(`Changed ${n} EPC(s) to ${label}.`);
            setStatusDrawerOpen(false);
            setSelected(new Set());
            await mutateItems();
            onMutated?.();
          }}
        />
      ) : null}
    </>
  );
}

function ChangeStatusDrawer({
  epcs,
  busy,
  setBusy,
  onClose,
  onChanged,
}: {
  epcs: string[];
  busy: boolean;
  setBusy: (v: boolean) => void;
  onClose: () => void;
  onChanged: (n: number, label: string) => Promise<void> | void;
}) {
  const { data: labels } = useSWR<StatusLabelRow[]>(
    "/api/settings/status-labels",
    fetcher,
    { revalidateOnFocus: false },
  );
  const [errMsg, setErrMsg] = useState<string | null>(null);

  /* Cross-check the user-facing list against the status_labels table.
   * Hide labels marked is_system_only=true — those require Super Admin via
   * /api/inventory/bulk-status anyway. We surface only the 6 the user listed. */
  const allowed = useMemo(() => {
    const visibleNames = new Set(
      (labels ?? [])
        .filter((l) => !l.is_system_only && l.is_visible_in_ui)
        .map((l) => l.name),
    );
    if (visibleNames.size === 0) {
      /* Until /api/settings/status-labels resolves, fall back to the user's allow-list. */
      return CHANGEABLE_STATUSES;
    }
    return CHANGEABLE_STATUSES.filter((s) => visibleNames.has(s.label));
  }, [labels]);

  const apply = useCallback(
    async (target: { wms: string; label: string }) => {
      setBusy(true);
      setErrMsg(null);
      try {
        const res = await fetch("/api/inventory/bulk-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            epcs,
            targetStatus: target.wms,
            reason: "catalog_rfid_modal",
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          error?: string;
          updated?: number;
        };
        if (!res.ok) throw new Error(j.error ?? "Status change failed");
        await onChanged(j.updated ?? 0, target.label);
      } catch (e) {
        setErrMsg(e instanceof Error ? e.message : "Status change failed");
      } finally {
        setBusy(false);
      }
    },
    [epcs, onChanged, setBusy],
  );

  return (
    <>
      <button
        type="button"
        aria-label="Close drawer"
        className="fixed inset-0 z-[80] bg-black/60"
        onClick={onClose}
      />
      <div className="fixed inset-y-0 right-0 z-[81] flex w-full max-w-md flex-col border-l border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-[var(--wms-fg)]">Change status</h3>
            <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]">
              {epcs.length} EPC(s) will be updated and audit-logged.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <ul className="space-y-2 font-mono">
            {allowed.map((s) => (
              <li key={s.wms}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void apply(s)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 px-4 py-3 text-left hover:border-[var(--wms-accent)]/45 hover:bg-[color-mix(in_srgb,var(--wms-accent)_8%,var(--wms-surface-elevated))] disabled:opacity-50"
                >
                  <span className="text-sm font-semibold text-[var(--wms-fg)]">{s.label}</span>
                  <span
                    className={`rounded-md border px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide max-md:text-xs ${statusPillClasses(s.wms)}`}
                  >
                    {s.label}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {errMsg ? (
            <p className="mt-3 font-mono text-xs text-red-400/90" role="status">
              {errMsg}
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
