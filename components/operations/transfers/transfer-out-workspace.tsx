"use client";

/**
 * Transfer Out (v2) — RFID + Non-RFID outbound transfer.
 *
 * Behavior summary (matches user-locked spec):
 *   - Start scan = pause/resume only. Never clears staged. "Clear staged" is the wipe.
 *   - Reader picker defaults to the reader named "Transfer bin" on first load.
 *   - Source = session location for non-admin (locked); admin can override.
 *   - Destination = free dropdown for everyone.
 *   - Staged table is grouped by custom SKU. Each row is RFID or Manual (mutually exclusive):
 *       * RFID  → qty = EPC count, click qty for EPC popup, qty not editable.
 *       * Manual → qty = 1 default, editable, no popup.
 *   - Conflicts:
 *       * Adding a manual SKU that's already RFID → blocked + toast.
 *       * RFID scan for a SKU that's already Manual → manual row dropped, RFID wins, toast.
 *   - Commit: status flips to in-transit, items move to destination location, bin → NULL,
 *             linked to a new transfer_records row. Manual lines write inventory_adjustments
 *             (source settled now, destination pending receive).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Radio, ScanLine, Search, Trash2, Plus, Minus } from "lucide-react";
import { ReaderPicker } from "@/components/shared/reader-picker";
import { StagedEpcsModal } from "./staged-epcs-modal";

type LocationRow = { id: string; code: string; name: string };

type LookupRow = {
  epc: string;
  sku: string;
  location_id: string;
  location_code: string;
  bin_id: string | null;
  bin_code: string | null;
  status: string;
  name: string | null;
  color: string | null;
  size: string | null;
  upc: string | null;
  asset_id: string | null;
  vendor: string | null;
  retail_price: string | null;
  custom_sku_id: string;
  sku_ls_system_id: string | null;
};

type CatalogSearchRow = {
  custom_sku_id: string;
  sku: string;
  name: string | null;
  color: string | null;
  size: string | null;
  upc: string | null;
  vendor: string | null;
  sku_ls_system_id: string | null;
};

type StagedSku = {
  type: "rfid" | "manual";
  custom_sku_id: string;
  sku_ls_system_id: string | null;
  name: string | null;
  sku: string;
  upc: string | null;
  color: string | null;
  size: string | null;
  retail_price: string | null;
  vendor: string | null;
  /** RFID: count of EPCs. Manual: editable user input. */
  qty: number;
  /** RFID only — populated EPC list for popup. */
  epcs: string[];
};

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

async function postLookup(epcs: string[]): Promise<LookupRow[]> {
  const res = await fetch("/api/operations/transfers/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ epcs }),
  });
  const data = (await res.json()) as { error?: string; rows?: LookupRow[] };
  if (!res.ok) throw new Error(data.error ?? "Lookup failed");
  return data.rows ?? [];
}

function formatPrice(p: string | null): string {
  if (!p) return "—";
  const n = Number(p);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

type Props = {
  /** From server session — drives source-location lock, admin override, etc. */
  sessionLocationId: string;
  isAdmin: boolean;
};

export function TransferOutWorkspace({ sessionLocationId, isAdmin }: Props) {
  // Locations dropdown source.
  const { data: locData } = useSWR<LocationRow[]>("/api/locations", fetcher);
  const locations = locData ?? [];

  // Source defaults to session location; non-admin cannot change it.
  const [sourceLocationId, setSourceLocationId] = useState(sessionLocationId);
  useEffect(() => {
    // Re-lock to session if non-admin's session changes.
    if (!isAdmin) setSourceLocationId(sessionLocationId);
  }, [sessionLocationId, isAdmin]);

  const [destLocationId, setDestLocationId] = useState("");

  // Scan toggle — purely a gate for the SSE handler. ReaderPicker filters
  // by deviceId; this gate filters by "are we listening at all?".
  const [scanning, setScanning] = useState(false);
  const scanningRef = useRef(scanning);
  useEffect(() => {
    scanningRef.current = scanning;
  }, [scanning]);

  // ReaderPicker selection.
  const [selectedReaders, setSelectedReaders] = useState<Set<string>>(() => new Set());
  const selectedReadersRef = useRef(selectedReaders);
  useEffect(() => {
    selectedReadersRef.current = selectedReaders;
  }, [selectedReaders]);

  // Staged: keyed by custom_sku_id. Conflict rules enforced on every mutation.
  const [staged, setStaged] = useState<Map<string, StagedSku>>(() => new Map());
  const stagedRef = useRef(staged);
  useEffect(() => {
    stagedRef.current = staged;
  }, [staged]);

  const [toast, setToast] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => {
      setToast((cur) => (cur === msg ? null : cur));
    }, 3500);
  }, []);

  // Non-RFID search.
  const [searchQ, setSearchQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<CatalogSearchRow[]>([]);
  const searchAnchor = useRef<HTMLDivElement | null>(null);

  // Per-row EPC popup.
  const [epcsModalSku, setEpcsModalSku] = useState<StagedSku | null>(null);

  // Commit progress.
  const [committing, setCommitting] = useState(false);
  // After a successful commit the page becomes a frozen receipt: source / dest
  // locations + all the staged rows stay visible but every interactive control
  // (Start scan, Non-RFID search, qty editor, Review & transfer) is locked.
  // Operator presses Clear staged to start a new session — that's the only
  // way back to an editable state, and it's also the wipe for an in-progress
  // session (so behaviour is identical whether or not a commit happened).
  const [committedSlip, setCommittedSlip] = useState<{ id: string; slipNumber: number | null } | null>(null);
  const isLocked = committedSlip !== null;

  // ─────────────────────────────────────────────────────────────────────────
  // Stage mutations
  // ─────────────────────────────────────────────────────────────────────────

  const ingestRfidRows = useCallback(
    (rows: LookupRow[]) => {
      if (rows.length === 0) return;
      setStaged((prev) => {
        const next = new Map(prev);
        let droppedManual: string | null = null;
        for (const r of rows) {
          const existing = next.get(r.custom_sku_id);
          if (existing?.type === "manual") {
            droppedManual = r.sku;
            next.delete(r.custom_sku_id);
          }
          const cur = next.get(r.custom_sku_id);
          if (!cur) {
            next.set(r.custom_sku_id, {
              type: "rfid",
              custom_sku_id: r.custom_sku_id,
              sku_ls_system_id: r.sku_ls_system_id,
              name: r.name,
              sku: r.sku,
              upc: r.upc,
              color: r.color,
              size: r.size,
              retail_price: r.retail_price,
              vendor: r.vendor,
              qty: 1,
              epcs: [r.epc],
            });
          } else if (cur.type === "rfid" && !cur.epcs.includes(r.epc)) {
            cur.epcs.push(r.epc);
            cur.qty = cur.epcs.length;
            next.set(r.custom_sku_id, { ...cur });
          }
        }
        if (droppedManual) {
          showToast(`RFID scan replaced manual entry for ${droppedManual}.`);
        }
        return next;
      });
    },
    [showToast],
  );

  const addManualLine = useCallback(
    (row: CatalogSearchRow) => {
      const existing = stagedRef.current.get(row.custom_sku_id);
      if (existing?.type === "rfid") {
        showToast(
          `${row.sku} already scanned via RFID — remove the RFID row first to add manually.`,
        );
        return;
      }
      setStaged((prev) => {
        const next = new Map(prev);
        const cur = next.get(row.custom_sku_id);
        if (cur && cur.type === "manual") {
          next.set(row.custom_sku_id, { ...cur, qty: cur.qty + 1 });
        } else {
          next.set(row.custom_sku_id, {
            type: "manual",
            custom_sku_id: row.custom_sku_id,
            sku_ls_system_id: row.sku_ls_system_id,
            name: row.name,
            sku: row.sku,
            upc: row.upc,
            color: row.color,
            size: row.size,
            retail_price: null,
            vendor: row.vendor,
            qty: 1,
            epcs: [],
          });
        }
        return next;
      });
    },
    [showToast],
  );

  const editManualQty = useCallback((custom_sku_id: string, qty: number) => {
    setStaged((prev) => {
      const cur = prev.get(custom_sku_id);
      if (!cur || cur.type !== "manual") return prev;
      if (qty < 1) return prev;
      const next = new Map(prev);
      next.set(custom_sku_id, { ...cur, qty });
      return next;
    });
  }, []);

  const removeRow = useCallback((custom_sku_id: string) => {
    setStaged((prev) => {
      const next = new Map(prev);
      next.delete(custom_sku_id);
      return next;
    });
  }, []);

  const removeEpc = useCallback((custom_sku_id: string, epc: string) => {
    setStaged((prev) => {
      const cur = prev.get(custom_sku_id);
      if (!cur || cur.type !== "rfid") return prev;
      const newEpcs = cur.epcs.filter((e) => e !== epc);
      const next = new Map(prev);
      if (newEpcs.length === 0) {
        next.delete(custom_sku_id);
      } else {
        next.set(custom_sku_id, { ...cur, epcs: newEpcs, qty: newEpcs.length });
      }
      return next;
    });
  }, []);

  const clearStaged = useCallback(() => {
    // Always restarts a session — both during an active session AND after a
    // commit (when the page is locked as a receipt). Either way, blank slate.
    setStaged(new Map());
    setScanning(false);
    setCommittedSlip(null);
    setSearchQ("");
    setSearchOpen(false);
    setSearchResults([]);
    setEpcsModalSku(null);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // SSE — gated by scanningRef + selectedReadersRef
  // ─────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const es = new EventSource("/api/edge/stream");
    es.onmessage = (ev) => {
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
      // Trace every event so devtools can confirm the SSE pipeline is
      // delivering reads (vs. the page-side filters dropping them).
      // eslint-disable-next-line no-console
      console.debug("[transfer-out SSE]", {
        scanContext: p.scanContext,
        deviceId: p.deviceId,
        epcs: p.epcs?.length ?? 0,
        scanning: scanningRef.current,
      });
      if (!scanningRef.current) return;
      // No scanContext gate — operator already chose the reader they care
      // about via ReaderPicker, that's the relevance signal. Gating on
      // scanContext='TRANSFER' was dropping every read for tenants whose
      // antennas weren't bound to that context. Keep the reader filter:
      // empty picker accepts all reads, otherwise only matching device IDs.
      const sel = selectedReadersRef.current;
      if (sel.size > 0 && p.deviceId && !sel.has(p.deviceId)) return;
      const list = (p.epcs ?? [])
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => /^[0-9A-F]{24}$/.test(e));
      if (list.length === 0) return;
      void (async () => {
        try {
          const rows = await postLookup(list);
          if (rows.length > 0) ingestRfidRows(rows);
        } catch {
          /* ignore transient lookup errors */
        }
      })();
    };
    return () => es.close();
  }, [ingestRfidRows]);

  // ─────────────────────────────────────────────────────────────────────────
  // Search (typeahead)
  // ─────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const q = searchQ.trim();
    if (q.length === 0) {
      setSearchResults([]);
      return;
    }
    let abort = false;
    const handle = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/inventory/catalog/search?q=${encodeURIComponent(q)}`,
        );
        if (!res.ok) return;
        const j = (await res.json()) as { rows?: CatalogSearchRow[] };
        if (!abort) setSearchResults(j.rows ?? []);
      } catch {
        /* ignore */
      }
    }, 180);
    return () => {
      abort = true;
      window.clearTimeout(handle);
    };
  }, [searchQ]);

  useEffect(() => {
    if (!searchOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!searchAnchor.current) return;
      if (!searchAnchor.current.contains(e.target as Node)) setSearchOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [searchOpen]);

  // ─────────────────────────────────────────────────────────────────────────
  // Commit
  // ─────────────────────────────────────────────────────────────────────────

  const stagedList = useMemo(
    () =>
      [...staged.values()].sort((a, b) =>
        (a.name ?? a.sku).localeCompare(b.name ?? b.sku),
      ),
    [staged],
  );

  const totalUnits = useMemo(
    () => stagedList.reduce((acc, s) => acc + s.qty, 0),
    [stagedList],
  );

  const doCommit = useCallback(async () => {
    if (!sourceLocationId || !destLocationId) {
      showToast("Pick a destination location.");
      return;
    }
    if (sourceLocationId === destLocationId) {
      showToast("Source and destination must be different.");
      return;
    }
    if (stagedList.length === 0) {
      showToast("Nothing to transfer.");
      return;
    }
    const epcs = stagedList.flatMap((s) => (s.type === "rfid" ? s.epcs : []));
    const manualLines = stagedList
      .filter((s) => s.type === "manual")
      .map((s) => ({ customSkuId: s.custom_sku_id, qty: s.qty }));
    setCommitting(true);
    try {
      const res = await fetch("/api/operations/transfers/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceLocationId,
          destinationLocationId: destLocationId,
          epcs,
          manualLines,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        transferId?: string;
        slipNumber?: number | null;
        rfidCount?: number;
        manualCount?: number;
      };
      if (!res.ok) {
        showToast(data.error ?? "Transfer failed.");
        return;
      }
      const slipNum = data.slipNumber ?? null;
      showToast(
        `Slip #${slipNum ?? "?"} created — RFID×${data.rfidCount ?? 0}, Manual×${data.manualCount ?? 0}. Items are IN TRANSIT until received at destination.`,
      );
      // Freeze the page as a read-only receipt and pop the printable slip
      // in a new tab. Cleared by pressing Clear staged.
      setCommittedSlip({ id: data.transferId ?? "", slipNumber: slipNum });
      setScanning(false);
      if (data.transferId) {
        try {
          window.open(
            `/api/operations/transfers/${encodeURIComponent(data.transferId)}/pdf?autoprint=1`,
            "_blank",
            "noopener",
          );
        } catch {
          /* ignore popup blockers */
        }
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Transfer failed.");
    } finally {
      setCommitting(false);
    }
  }, [sourceLocationId, destLocationId, stagedList, showToast]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  const sourceLabel = useMemo(() => {
    const l = locations.find((x) => x.id === sourceLocationId);
    return l ? `${l.code} — ${l.name}` : "—";
  }, [locations, sourceLocationId]);

  return (
    <div className="space-y-6">
      {/* Source / Destination */}
      <div className="grid gap-4 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-4 sm:grid-cols-2">
        <div>
          <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
            Source location {!isAdmin ? "(locked to your session)" : "(admin override)"}
          </label>
          {isAdmin ? (
            <select
              value={sourceLocationId}
              onChange={(e) => setSourceLocationId(e.target.value)}
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
              {sourceLabel}
            </div>
          )}
        </div>
        <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
          Destination location
          <select
            value={destLocationId}
            onChange={(e) => setDestLocationId(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
          >
            <option value="">— Select —</option>
            {locations
              .filter((l) => l.id !== sourceLocationId)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} — {l.name}
                </option>
              ))}
          </select>
        </label>
      </div>

      {/* Locked banner shown after a commit succeeds. */}
      {isLocked ? (
        <div className="rounded-lg border border-emerald-700/45 bg-emerald-950/25 px-4 py-3 font-mono text-xs text-emerald-200">
          <span className="font-semibold">Slip #{committedSlip?.slipNumber ?? "?"} created</span> — page is now read-only.
          The printable slip opened in a new tab; CSV is available from{" "}
          <a className="underline" href="/reports/transfers/out" target="_blank" rel="noopener">Reports → Transfer Out</a>.
          Press <span className="font-semibold">Clear staged</span> to start a new session.
        </div>
      ) : null}

      {/* Scan controls */}
      <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <button
            type="button"
            disabled={isLocked}
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
            disabled={staged.size === 0}
            onClick={clearStaged}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-border)] px-4 py-2.5 font-mono text-xs text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40"
          >
            <ScanLine className="h-4 w-4" />
            Clear staged
          </button>
        </div>

        {/* Non-RFID typeahead */}
        <div className="mt-4 relative" ref={searchAnchor}>
          <div className="flex items-center gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 focus-within:border-teal-500/50">
            <Search className="h-4 w-4 text-[var(--wms-muted)]" />
            <input
              type="text"
              value={searchQ}
              disabled={isLocked}
              onChange={(e) => setSearchQ(e.target.value)}
              onFocus={() => setSearchOpen(true)}
              placeholder="Non-RFID search — name / SKU / UPC / vendor / color / size / system ID"
              className="flex-1 bg-transparent font-mono text-xs text-[var(--wms-fg)] outline-none placeholder:text-[var(--wms-muted)]/70 disabled:opacity-40"
            />
            {searchQ ? (
              <button
                type="button"
                onClick={() => setSearchQ("")}
                className="rounded p-0.5 text-[var(--wms-muted)] hover:bg-[var(--wms-surface)]"
                aria-label="Clear"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            ) : null}
          </div>
          {searchOpen && searchResults.length > 0 ? (
            <div className="absolute left-0 top-full z-30 mt-1 w-full max-h-80 overflow-auto rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] shadow-xl">
              {searchResults.map((r) => (
                <button
                  key={r.custom_sku_id}
                  type="button"
                  onClick={() => {
                    addManualLine(r);
                    setSearchQ("");
                    setSearchOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-3 border-b border-[var(--wms-border)]/60 px-3 py-2 text-left font-mono text-xs text-[var(--wms-fg)] last:border-0 hover:bg-[var(--wms-surface)]"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-semibold">
                      {r.name ?? r.sku}
                    </span>
                    <span className="truncate text-[0.6rem] text-[var(--wms-muted)]">
                      SKU {r.sku} · {r.color?.trim() || "—"} · {r.size?.trim() || "—"} ·{" "}
                      {r.upc ?? "no upc"}
                    </span>
                  </div>
                  <span className="rounded bg-teal-500/10 px-1.5 py-0.5 text-[0.55rem] uppercase tracking-wider text-teal-300">
                    + Manual
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <p className="mt-3 font-mono text-[0.6rem] text-[var(--wms-muted)]">
          Start scan acts as a pause/resume gate. Clear staged is the only wipe. Non-RFID search
          adds untagged units; source qty can go negative until inventory is reconciled.
        </p>
      </div>

      {/* Staged table */}
      <div className="overflow-hidden rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80">
        <div className="border-b border-[var(--wms-border)] px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
          Staged payload — {stagedList.length} SKU{stagedList.length === 1 ? "" : "s"} ·{" "}
          {totalUnits} unit{totalUnits === 1 ? "" : "s"}
        </div>
        <div className="max-h-[min(50vh,400px)] overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
              <tr className="border-b border-[var(--wms-border)]">
                <th className="px-3 py-2">System ID</th>
                <th className="px-3 py-2">Item name</th>
                <th className="px-3 py-2">Custom SKU</th>
                <th className="px-3 py-2">UPC</th>
                <th className="px-3 py-2">Color</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2 text-right">Retail price</th>
                <th className="px-3 py-2 text-right">Qty (EPC)</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono text-xs text-[var(--wms-fg)]">
              {stagedList.map((g) => (
                <tr key={g.custom_sku_id} className="hover:bg-[var(--wms-surface-elevated)]/50">
                  <td className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5 tabular-nums text-teal-400/85">
                    {g.sku_ls_system_id ?? "—"}
                  </td>
                  <td
                    className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5"
                    title={g.name ?? undefined}
                  >
                    {g.name ?? "—"}
                  </td>
                  <td className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5">
                    {g.sku}
                  </td>
                  <td className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5 text-[var(--wms-muted)]">
                    {g.upc ?? "—"}
                  </td>
                  <td className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5 text-[var(--wms-muted)]">
                    {g.color?.trim() || "—"}
                  </td>
                  <td className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5 text-[var(--wms-muted)]">
                    {g.size?.trim() || "—"}
                  </td>
                  <td className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5 text-right tabular-nums">
                    {formatPrice(g.retail_price)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {g.type === "rfid" ? (
                      <button
                        type="button"
                        onClick={() => setEpcsModalSku(g)}
                        className="inline-flex items-center gap-1 rounded border border-[var(--wms-accent)]/45 bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] px-2 py-0.5 text-[0.65rem] font-medium text-[var(--wms-accent)] hover:opacity-90"
                        title="View EPCs"
                      >
                        <Radio className="h-3 w-3" />
                        {g.qty}
                      </button>
                    ) : (
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => editManualQty(g.custom_sku_id, g.qty - 1)}
                          disabled={g.qty <= 1}
                          className="rounded border border-[var(--wms-border)] p-0.5 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-30"
                          aria-label="Decrement"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <input
                          type="number"
                          min={1}
                          max={9999}
                          value={g.qty}
                          onChange={(e) => {
                            const n = Math.max(1, Number(e.target.value) || 1);
                            editManualQty(g.custom_sku_id, n);
                          }}
                          className="w-14 rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-1.5 py-0.5 text-right font-mono text-xs text-[var(--wms-fg)]"
                        />
                        <button
                          type="button"
                          onClick={() => editManualQty(g.custom_sku_id, g.qty + 1)}
                          className="rounded border border-[var(--wms-border)] p-0.5 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
                          aria-label="Increment"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5">
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-[0.55rem] uppercase tracking-wider ${
                        g.type === "rfid"
                          ? "bg-teal-500/15 text-teal-300"
                          : "bg-amber-500/15 text-amber-300"
                      }`}
                    >
                      {g.type === "rfid" ? "RFID" : "Manual"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => removeRow(g.custom_sku_id)}
                      className="rounded p-1 text-[var(--wms-muted)] hover:bg-red-500/10 hover:text-red-300"
                      aria-label="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {stagedList.length === 0 ? (
            <p className="p-6 text-center font-mono text-xs text-[var(--wms-muted)]">
              Press Start scan + pick a reader to stage RFID, or use the Non-RFID search to add
              untagged units.
            </p>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        disabled={
          isLocked ||
          stagedList.length === 0 ||
          !destLocationId ||
          !sourceLocationId ||
          sourceLocationId === destLocationId ||
          committing
        }
        onClick={() => void doCommit()}
        className="rounded-lg border border-orange-600/50 bg-orange-950/30 px-5 py-2.5 font-mono text-sm text-orange-200 hover:bg-orange-900/25 disabled:opacity-40"
      >
        {committing ? "Transferring…" : "Review & transfer (IN TRANSIT)"}
      </button>

      {toast ? (
        <p className="font-mono text-xs text-amber-300/90" role="status">
          {toast}
        </p>
      ) : null}

      <StagedEpcsModal
        open={epcsModalSku !== null}
        onClose={() => setEpcsModalSku(null)}
        sku={epcsModalSku?.sku ?? ""}
        name={epcsModalSku?.name ?? null}
        color={epcsModalSku?.color ?? null}
        size={epcsModalSku?.size ?? null}
        epcs={epcsModalSku?.epcs ?? []}
        onRemoveEpc={(epc) => {
          if (!epcsModalSku) return;
          removeEpc(epcsModalSku.custom_sku_id, epc);
          if (epcsModalSku.epcs.length <= 1) setEpcsModalSku(null);
        }}
      />
    </div>
  );
}
