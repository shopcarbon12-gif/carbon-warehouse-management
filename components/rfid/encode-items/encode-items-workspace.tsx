"use client";

/**
 * Encode Items workspace — re-encode an already-stuck tag without
 * reprinting it. Three controls + a table:
 *   - Read button: starts a scan-session against the picked reader so
 *     the page can subscribe to its EPC stream via /api/edge/stream.
 *     Each new EPC arrives → calls /api/rfid/encode-resolve to enrich
 *     the row with SKU/UPC/name/size/color/status (formula-passing tags)
 *     OR leaves the columns blank (foreign / undecodable tags).
 *   - Search box: typeahead over /api/inventory/catalog/search. Picking
 *     a row selects the TARGET custom SKU for the encode pass.
 *   - Encode button: for every CHECKED row, POSTs /api/rfid/encode-claim
 *     with { customSkuId: selected.target, oldEpc: row.epc }. The
 *     endpoint atomically rotates the items rows (kill old, insert new
 *     at MAX+1 serial) and returns the new EPC. We surface it in the
 *     row's status column.
 *
 * NOTE — Phase 1 only writes the items table. Physical tag re-write on
 * the chip (MonsoonReader --target_tag <old> --write_tag <new>) is a
 * separate agent-side work item; the operator currently still has to
 * physically rewrite the tag via the C72E handheld OR a follow-up
 * commit that wires the fixed-reader write path through the agent.
 *
 * Default reader: .70 (matches the bulk-status workspace's default).
 * Operator can change via the ReaderPicker.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Pencil, Play, Radio, Search, Square } from "lucide-react";

import { ReaderPicker } from "@/components/shared/reader-picker";

const DEFAULT_READER_IP = "192.168.1.70";

type HardwareConfigZone = {
  readers?: Array<{ id: string; network_address: string | null }>;
};
type HardwareConfigLocation = {
  zones?: HardwareConfigZone[];
  unzoned_readers?: Array<{ id: string; network_address: string | null }>;
};
type HardwareConfigTree = {
  locations?: HardwareConfigLocation[];
};
const hcFetcher = async (url: string): Promise<HardwareConfigTree> => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("hardware-config fetch failed");
  return r.json() as Promise<HardwareConfigTree>;
};

type EncodeResolveResponse =
  | {
      ok: true;
      status: "known" | "valid_orphan" | "foreign";
      epc: string;
      decoded?: { prefix: number; system_id: number; serial: number };
      item?: {
        id: string;
        status: string;
        custom_sku_id: string;
        sku: string;
        name: string;
        color: string;
        size: string;
        bin_code: string | null;
        last_seen_at: string | null;
      };
    }
  | { ok: false; error?: string };

type CatalogSearchHit = {
  custom_sku_id: string;
  sku: string;
  name: string | null;
  color: string | null;
  size: string | null;
  upc: string | null;
  vendor: string | null;
  sku_ls_system_id: string | null;
};

type Row = {
  epc: string;
  /** Filled by /api/rfid/encode-resolve. null when foreign/undecodable. */
  sku: string | null;
  upc: string | null;
  name: string | null;
  size: string | null;
  color: string | null;
  /** items.status from the resolve response. "—" when no row exists yet. */
  status: string;
  /** Post-encode status text — e.g. "Encoded: <new-epc>" or "Failed: …". */
  encodeStatus: string | null;
  /** True while an in-flight POST /encode-claim is updating this row. */
  busy: boolean;
};

export function EncodeItemsWorkspace() {
  // --- Reader picker + default to .70 ----------------------------------
  const [selectedReaders, setSelectedReaders] = useState<Set<string>>(new Set());
  const { data: hcData } = useSWR<HardwareConfigTree>(
    "/api/hardware-config",
    hcFetcher,
    { revalidateOnFocus: false },
  );
  const appliedDefaultRef = useRef(false);
  useEffect(() => {
    if (appliedDefaultRef.current) return;
    if (!hcData) return;
    let defaultId: string | null = null;
    for (const loc of hcData.locations ?? []) {
      for (const z of loc.zones ?? []) {
        for (const r of z.readers ?? []) {
          if (r.network_address === DEFAULT_READER_IP) {
            defaultId = r.id;
            break;
          }
        }
        if (defaultId) break;
      }
      if (defaultId) break;
      for (const r of loc.unzoned_readers ?? []) {
        if (r.network_address === DEFAULT_READER_IP) {
          defaultId = r.id;
          break;
        }
      }
      if (defaultId) break;
    }
    appliedDefaultRef.current = true;
    if (defaultId) setSelectedReaders(new Set([defaultId]));
  }, [hcData]);

  // --- Read state -------------------------------------------------------
  const [reading, setReading] = useState(false);
  const [scanSessionId, setScanSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Rows are keyed by EPC (unique); a Map keeps insertion order.
  const [rowsByEpc, setRowsByEpc] = useState<Map<string, Row>>(() => new Map());
  const rows = useMemo(() => Array.from(rowsByEpc.values()), [rowsByEpc]);

  const [checked, setChecked] = useState<Set<string>>(() => new Set());

  // Enrich newly-seen EPCs via /api/rfid/encode-resolve. Once per EPC.
  const resolvedRef = useRef<Set<string>>(new Set());
  const enrichEpc = useCallback(async (epc: string) => {
    if (resolvedRef.current.has(epc)) return;
    resolvedRef.current.add(epc);
    try {
      const r = await fetch("/api/rfid/encode-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epc }),
      });
      const j = (await r.json().catch(() => null)) as EncodeResolveResponse | null;
      if (!j || !("ok" in j) || !j.ok) return;
      // Foreign tags: clear columns, keep status blank-ish so the operator
      // sees the row exists but the chip isn't ours to interpret.
      if (j.status === "foreign") {
        setRowsByEpc((prev) => {
          const next = new Map(prev);
          const row = next.get(epc);
          if (!row) return prev;
          next.set(epc, {
            ...row,
            sku: null,
            upc: null,
            name: null,
            size: null,
            color: null,
            status: "foreign",
          });
          return next;
        });
        return;
      }
      // Decoded but no items row (valid_orphan) — show what we can derive
      // from the decoded EPC alone (system_id, serial) without item data.
      if (j.status === "valid_orphan") {
        setRowsByEpc((prev) => {
          const next = new Map(prev);
          const row = next.get(epc);
          if (!row) return prev;
          next.set(epc, {
            ...row,
            status: "orphan",
          });
          return next;
        });
        return;
      }
      // Known — full enrichment.
      const it = j.item;
      if (!it) return;
      setRowsByEpc((prev) => {
        const next = new Map(prev);
        const row = next.get(epc);
        if (!row) return prev;
        next.set(epc, {
          ...row,
          sku: it.sku,
          upc: null, // encode-resolve doesn't return UPC; left blank
          name: it.name,
          size: it.size,
          color: it.color,
          status: it.status,
        });
        return next;
      });
    } catch {
      /* transient; the operator can re-Read to retry */
    }
  }, []);

  // --- SSE: stream EPCs into the table while reading -------------------
  useEffect(() => {
    if (!reading) return;
    const es = new EventSource("/api/edge/stream");
    const filterDeviceIds = selectedReaders.size > 0 ? selectedReaders : null;
    const onMessage = (ev: MessageEvent) => {
      if (!ev.data || ev.data.startsWith(":")) return;
      let p: { scanContext?: string; epcs?: string[]; deviceId?: string };
      try {
        p = JSON.parse(ev.data) as { scanContext?: string; epcs?: string[]; deviceId?: string };
      } catch {
        return;
      }
      if (filterDeviceIds && p.deviceId && !filterDeviceIds.has(p.deviceId)) return;
      const list = (p.epcs ?? [])
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => /^[0-9A-F]{24}$/.test(e));
      if (list.length === 0) return;
      // Add new EPCs as empty rows; enrich each via encode-resolve.
      setRowsByEpc((prev) => {
        const next = new Map(prev);
        for (const epc of list) {
          if (next.has(epc)) continue;
          next.set(epc, {
            epc,
            sku: null,
            upc: null,
            name: null,
            size: null,
            color: null,
            status: "—",
            encodeStatus: null,
            busy: false,
          });
        }
        return next;
      });
      // Fire enrichment in the background (idempotent via resolvedRef).
      for (const epc of list) void enrichEpc(epc);
    };
    es.addEventListener("message", onMessage);
    return () => {
      es.removeEventListener("message", onMessage);
      es.close();
    };
  }, [reading, selectedReaders, enrichEpc]);

  // --- Read button: wake the reader via /api/scan-sessions/start ------
  const onReadToggle = useCallback(async () => {
    setErrorMsg(null);
    if (busy) return;
    setBusy(true);
    try {
      if (reading) {
        // Stop: end the scan-session, drop SSE.
        if (scanSessionId) {
          await fetch("/api/scan-sessions/end", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: scanSessionId }),
          });
        }
        setReading(false);
        setScanSessionId(null);
        return;
      }
      const readerIds = Array.from(selectedReaders);
      if (readerIds.length === 0) {
        setErrorMsg("Pick at least one reader first.");
        return;
      }
      // Wake every selected reader. First failure stops the loop.
      const sessionIds: string[] = [];
      for (const readerId of readerIds) {
        const r = await fetch("/api/scan-sessions/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ readerId, kind: "encode-items" }),
        });
        const j = (await r.json().catch(() => null)) as
          | { ok: boolean; sessionId?: string; reason?: string }
          | null;
        if (!j?.ok || !j.sessionId) {
          setErrorMsg(`Could not start reader (${j?.reason ?? "unknown"}).`);
          // Clean up any partials.
          for (const id of sessionIds) {
            void fetch("/api/scan-sessions/end", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId: id }),
            });
          }
          return;
        }
        sessionIds.push(j.sessionId);
      }
      // Save just the first id; ending it ends the slot — the supervisor
      // releases the reader for whichever workflow held it. (We don't
      // bundle multi-reader; keep this simple.)
      setScanSessionId(sessionIds[0] ?? null);
      setReading(true);
    } finally {
      setBusy(false);
    }
  }, [busy, reading, scanSessionId, selectedReaders]);

  // Stop the scan-session on unmount so a closed tab doesn't leave the
  // reader awake forever.
  useEffect(() => {
    return () => {
      if (scanSessionId) {
        void fetch("/api/scan-sessions/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({ sessionId: scanSessionId }),
        });
      }
    };
    // intentional: cleanup only on unmount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Catalog search -------------------------------------------------
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [hits, setHits] = useState<CatalogSearchHit[]>([]);
  const [target, setTarget] = useState<CatalogSearchHit | null>(null);

  // Debounced search.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 1) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/inventory/catalog/search?q=${encodeURIComponent(q)}`,
          { cache: "no-store" },
        );
        if (!r.ok) return;
        const j = (await r.json()) as { rows?: CatalogSearchHit[] };
        setHits(j.rows ?? []);
      } catch {
        /* ignore */
      }
    }, 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const pickTarget = useCallback((hit: CatalogSearchHit) => {
    setTarget(hit);
    setSearchOpen(false);
    setSearchQuery(
      `${hit.sku}${hit.name ? ` · ${hit.name}` : ""}${hit.color ? ` · ${hit.color}` : ""}${hit.size ? ` · ${hit.size}` : ""}`,
    );
  }, []);

  const clearTarget = useCallback(() => {
    setTarget(null);
    setSearchQuery("");
  }, []);

  // --- Encode button: rotate each checked tag's identity --------------
  const onEncode = useCallback(async () => {
    if (busy) return;
    setErrorMsg(null);
    if (!target) {
      setErrorMsg("Pick a target SKU first (use the search box).");
      return;
    }
    const epcs = Array.from(checked);
    if (epcs.length === 0) {
      setErrorMsg("Check at least one EPC to re-encode.");
      return;
    }
    setBusy(true);
    try {
      for (const epc of epcs) {
        // Mark row busy while its claim is in flight.
        setRowsByEpc((prev) => {
          const next = new Map(prev);
          const row = next.get(epc);
          if (row) next.set(epc, { ...row, busy: true, encodeStatus: "Encoding…" });
          return next;
        });
        try {
          const r = await fetch("/api/rfid/encode-claim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              customSkuId: target.custom_sku_id,
              oldEpc: epc,
            }),
          });
          const j = (await r.json().catch(() => null)) as
            | { ok: true; epc: string; serial: number; system_id: number }
            | { error?: string; code?: string }
            | null;
          if (j && "ok" in j && j.ok) {
            setRowsByEpc((prev) => {
              const next = new Map(prev);
              const row = next.get(epc);
              if (!row) return prev;
              next.set(epc, {
                ...row,
                busy: false,
                encodeStatus: `Encoded → ${j.epc} (sn ${j.serial})`,
                // Old EPC is now tag_killed in items; reflect that.
                status: "tag_killed",
              });
              return next;
            });
          } else {
            const errMsg = (j as { error?: string } | null)?.error ?? "failed";
            setRowsByEpc((prev) => {
              const next = new Map(prev);
              const row = next.get(epc);
              if (!row) return prev;
              next.set(epc, { ...row, busy: false, encodeStatus: `Failed: ${errMsg}` });
              return next;
            });
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : "network error";
          setRowsByEpc((prev) => {
            const next = new Map(prev);
            const row = next.get(epc);
            if (!row) return prev;
            next.set(epc, { ...row, busy: false, encodeStatus: `Failed: ${errMsg}` });
            return next;
          });
        }
      }
    } finally {
      setBusy(false);
    }
  }, [busy, checked, target]);

  const toggleCheck = useCallback((epc: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(epc)) next.delete(epc);
      else next.add(epc);
      return next;
    });
  }, []);

  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.epc));
  const toggleAll = useCallback(() => {
    setChecked((prev) => {
      if (allChecked) return new Set();
      const next = new Set(prev);
      for (const r of rows) next.add(r.epc);
      return next;
    });
  }, [allChecked, rows]);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
        <button
          type="button"
          onClick={() => void onReadToggle()}
          disabled={busy || selectedReaders.size === 0}
          className={
            "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 " +
            (reading
              ? "border-red-400/50 bg-red-500/15 text-red-300 hover:bg-red-500/25"
              : "border-emerald-400/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25")
          }
        >
          {reading ? (
            <>
              <Square className="h-3.5 w-3.5" />
              Stop
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" />
              Read
            </>
          )}
        </button>

        <button
          type="button"
          onClick={() => void onEncode()}
          disabled={busy || !target || checked.size === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-accent)]/40 bg-[var(--wms-accent)]/10 px-3 py-1.5 font-mono text-sm font-semibold text-[var(--wms-accent)] hover:bg-[var(--wms-accent)]/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Pencil className="h-3.5 w-3.5" />
          Encode ({checked.size})
        </button>

        <div className="relative flex flex-1 items-center">
          <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-[var(--wms-muted)]" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchOpen(true);
              if (target) setTarget(null);
            }}
            onFocus={() => setSearchOpen(true)}
            placeholder="Search target SKU (sku, upc, name, system id…)"
            className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-1.5 pl-7 pr-2 font-mono text-xs text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)] focus:border-[var(--wms-accent)] focus:outline-none"
          />
          {target ? (
            <button
              type="button"
              onClick={clearTarget}
              className="absolute right-2 font-mono text-[0.6rem] uppercase text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
              title="Clear target"
            >
              clear
            </button>
          ) : null}
          {searchOpen && hits.length > 0 && !target ? (
            <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-lg">
              {hits.map((h) => (
                <button
                  key={h.custom_sku_id}
                  type="button"
                  onClick={() => pickTarget(h)}
                  className="block w-full border-b border-[var(--wms-border)]/40 px-3 py-1.5 text-left font-mono text-xs hover:bg-[var(--wms-surface-elevated)]"
                >
                  <div className="text-[var(--wms-fg)]">
                    {h.sku}
                    {h.sku_ls_system_id ? (
                      <span className="ml-2 text-teal-400/80">[{h.sku_ls_system_id}]</span>
                    ) : null}
                  </div>
                  <div className="truncate text-[var(--wms-muted)]">
                    {[h.name, h.color, h.size].filter(Boolean).join(" · ") || "—"}
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex min-w-[220px] items-center gap-2">
          <Radio className="h-3.5 w-3.5 text-[var(--wms-muted)]" />
          <ReaderPicker selected={selectedReaders} onChange={setSelectedReaders} hidePosDedicated />
        </div>
      </div>

      {errorMsg ? (
        <div className="rounded-md border border-red-400/40 bg-red-400/10 px-3 py-2 font-mono text-xs text-red-300">
          {errorMsg}
        </div>
      ) : null}

      {target ? (
        <div className="rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 font-mono text-xs text-emerald-300">
          Target: <span className="font-semibold">{target.sku}</span>
          {target.sku_ls_system_id ? <span className="ml-2">system id {target.sku_ls_system_id}</span> : null}
          {target.name ? <span className="ml-2 text-emerald-200/80">· {target.name}</span> : null}
        </div>
      ) : null}

      {/* Table */}
      <div className="overflow-auto rounded-lg border border-[var(--wms-border)]">
        <table className="w-full min-w-[1100px] border-collapse font-mono text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
            <tr>
              <th className="px-3 py-2 text-left">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={toggleAll}
                  disabled={rows.length === 0}
                  className="h-4 w-4 cursor-pointer accent-[var(--wms-accent)]"
                />
              </th>
              <th className="px-3 py-2 text-left">EPC</th>
              <th className="px-3 py-2 text-left">SKU</th>
              <th className="px-3 py-2 text-left">UPC</th>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Size</th>
              <th className="px-3 py-2 text-left">Color</th>
              <th className="px-3 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                  {reading ? "Listening… scan some tags." : "Click Read to start streaming EPCs."}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const isChecked = checked.has(r.epc);
                return (
                  <tr
                    key={r.epc}
                    className={
                      "border-b border-[var(--wms-border)]/40 hover:bg-[var(--wms-surface-elevated)]/40 " +
                      (isChecked
                        ? "bg-[color-mix(in_srgb,var(--wms-accent)_6%,transparent)]"
                        : "")
                    }
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleCheck(r.epc)}
                        disabled={r.busy}
                        className="h-4 w-4 cursor-pointer accent-[var(--wms-accent)]"
                      />
                    </td>
                    <td className="px-3 py-2 font-semibold text-teal-400/90" title={r.epc}>
                      {r.epc}
                    </td>
                    <td className="px-3 py-2 text-[var(--wms-fg)]">{r.sku ?? "—"}</td>
                    <td className="px-3 py-2 text-[var(--wms-muted)]">{r.upc ?? "—"}</td>
                    <td className="px-3 py-2 text-[var(--wms-fg)]" title={r.name ?? ""}>
                      {r.name ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-[var(--wms-muted)]">{r.size ?? "—"}</td>
                    <td className="px-3 py-2 text-[var(--wms-muted)]">{r.color ?? "—"}</td>
                    <td className="px-3 py-2">
                      {r.encodeStatus ? (
                        <span
                          className={
                            "rounded px-1.5 py-0.5 text-[0.65rem] " +
                            (r.encodeStatus.startsWith("Failed")
                              ? "border border-red-400/40 bg-red-400/10 text-red-300"
                              : r.encodeStatus.startsWith("Encoded")
                                ? "border border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                                : "border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-muted)]")
                          }
                          title={r.encodeStatus}
                        >
                          {r.encodeStatus}
                        </span>
                      ) : (
                        <span className="text-[var(--wms-muted)]">{r.status}</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
        Phase 1: clicking Encode rotates the WMS items rows (old → tag_killed,
        new → in-stock at fresh serial) and returns the new EPC. The fixed
        reader does NOT yet physically write the new EPC onto the chip — that
        wire-up requires agent-side work to drive MonsoonReader --target_tag
        / --write_tag. Until that lands, finish the re-encode by physically
        rewriting the tag with the C72E handheld using the new EPC shown in
        the Status column.
      </div>
    </div>
  );
}
