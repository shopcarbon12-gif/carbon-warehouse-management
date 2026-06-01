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
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Filter,
  Pencil,
  Play,
  Radio,
  RefreshCw,
  Search,
  Square,
  Trash2,
} from "lucide-react";

import { ReaderPicker } from "@/components/shared/reader-picker";
import {
  RssiProximitySlider,
  useRssiThreshold,
  passesRssi,
} from "@/components/shared/rssi-proximity-slider";

const DEFAULT_READER_IP = "192.168.1.70";

type HardwareConfigReader = {
  id: string;
  network_address: string | null;
  /**
   * Set true for the WiFi-extender POS reader (.34). The legacy
   * MonsoonReader (2019) segfaults on C-prefix --target_tag values;
   * MonsoonReader2 (2020) doesn't segfault but fails RFID_RadioOpen
   * with -9983 RADIO_NOT_PRESENT on this reader's chip path. So
   * C-prefix chip-writes are NOT POSSIBLE on is_pos_dedicated
   * readers — we block the Encode button instead of letting the
   * operator queue 5 doomed jobs that rotate the DB without
   * touching the chip.
   */
  is_pos_dedicated?: boolean;
};
type HardwareConfigZone = {
  readers?: HardwareConfigReader[];
};
type HardwareConfigLocation = {
  zones?: HardwareConfigZone[];
  unzoned_readers?: HardwareConfigReader[];
  unzonedReaders?: HardwareConfigReader[];
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
        upc: string | null;
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
  /** Strongest per-tag RSSI seen this session (dBm, negative). null = none reported. */
  rssi: number | null;
  /** Post-encode status text — e.g. "Encoded: <new-epc>" or "Failed: …". */
  encodeStatus: string | null;
  /** True while an in-flight POST /encode-claim is updating this row. */
  busy: boolean;
  /**
   * AUTO-RESOLVED target SKU id for EPCs that start with "C1"/"C2".
   *
   * Semantics (per operator spec): C1/C2 tags carry the destination SKU
   * in their first 13 hex chars (e.g. "C217016334845") — that 13-char
   * string IS the `custom_skus.sku` code. Encoding this kind of tag
   * doesn't need a manually-picked target from the search box: we look
   * up the SKU automatically when the row is enriched and stash its id
   * here. The Encode button reads this first, falling back to the
   * manually-picked target only when null.
   *
   * null = either not a C1/C2 EPC, or the 13-char code didn't resolve
   * to any catalog row.
   */
  autoCustomSkuId: string | null;
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

  // RSSI proximity slider — shown ONLY when .70 is the single selected reader.
  // (RSSI across multiple readers at different distances is meaningless.)
  const [rssiThreshold, setRssiThreshold] = useRssiThreshold("wms.encode-items.rssi");
  const reader70Id = useMemo(() => {
    for (const loc of hcData?.locations ?? []) {
      for (const z of loc.zones ?? [])
        for (const r of z.readers ?? []) if (r.network_address === DEFAULT_READER_IP) return r.id;
      for (const r of loc.unzoned_readers ?? [])
        if (r.network_address === DEFAULT_READER_IP) return r.id;
      for (const r of loc.unzonedReaders ?? [])
        if (r.network_address === DEFAULT_READER_IP) return r.id;
    }
    return null;
  }, [hcData]);
  const showRssi =
    selectedReaders.size === 1 && reader70Id !== null && selectedReaders.has(reader70Id);

  // --- Read state -------------------------------------------------------
  const [reading, setReading] = useState(false);
  const [scanSessionId, setScanSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Rows are keyed by EPC (unique); a Map keeps insertion order.
  const [rowsByEpc, setRowsByEpc] = useState<Map<string, Row>>(() => new Map());

  // C-prefix filter: when true, only EPCs starting with C (the Senitron
  // legacy pool — the ones the operator most often wants to re-encode in
  // bulk) are shown. Default off so the table shows everything by default.
  const [cPrefixOnly, setCPrefixOnly] = useState(false);

  // Column sort. null = insertion order (oldest first), which is the
  // default and matches how reads arrive over SSE. asc = A→Z / numeric
  // small→large; desc = Z→A / large→small. Strings sort case-insensitive
  // via localeCompare; the EPC and status columns sort lexicographically.
  type SortKey = "epc" | "sku" | "upc" | "name" | "size" | "color" | "status";
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const onHeaderClick = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      if (prevKey !== key) {
        setSortDir("asc");
        return key;
      }
      // Same column tapped again: asc → desc → off.
      let nextKey: SortKey | null = key;
      setSortDir((prevDir) => {
        if (prevDir === "asc") return "desc";
        nextKey = null;
        return "asc";
      });
      return nextKey;
    });
  }, []);

  const rows = useMemo(() => {
    let arr = Array.from(rowsByEpc.values());
    if (cPrefixOnly) {
      arr = arr.filter((r) => /^[Cc]/.test(r.epc));
    }
    // Proximity filter (only when .70 is the sole selected reader).
    if (showRssi) {
      arr = arr.filter((r) => passesRssi(r.rssi, rssiThreshold));
    }
    if (sortKey) {
      const dir = sortDir === "asc" ? 1 : -1;
      const get = (r: Row): string => {
        switch (sortKey) {
          case "epc":
            return r.epc;
          case "sku":
            return r.sku ?? "";
          case "upc":
            return r.upc ?? "";
          case "name":
            return r.name ?? "";
          case "size":
            return r.size ?? "";
          case "color":
            return r.color ?? "";
          case "status":
            return r.encodeStatus ?? r.status ?? "";
        }
      };
      arr = [...arr].sort((a, b) =>
        dir * get(a).localeCompare(get(b), undefined, { sensitivity: "base", numeric: true }),
      );
    }
    return arr;
  }, [rowsByEpc, cPrefixOnly, sortKey, sortDir, showRssi, rssiThreshold]);

  const [checked, setChecked] = useState<Set<string>>(() => new Set());

  // Enrich newly-seen EPCs via /api/rfid/encode-resolve. Once per EPC.
  const resolvedRef = useRef<Set<string>>(new Set());

  // EPCs the operator has explicitly trash-iconed during this session.
  // The SSE handler skips re-adding any EPC in this set so the table
  // doesn't reanimate something the operator just removed. Cleared by
  // the Clear session button (treats the session as fresh — re-scanning
  // a previously-trashed tag puts it back in the table).
  const suppressedRef = useRef<Set<string>>(new Set());

  // C1/C2 auto-resolve. The first 13 chars of these EPCs (the leading
  // "C1"/"C2" + 11 following chars) form the destination `custom_skus.sku`
  // code. We resolve it via /api/inventory/catalog/search and use the
  // matched custom_sku_id when the operator hits Encode — no manual
  // search-box pick required for these. The lookup runs in addition to
  // (not instead of) encode-resolve so the operator sees the resolved
  // SKU/name/color/size in the row preview before encoding.
  const tryAutoResolveC1C2 = useCallback(async (epc: string) => {
    if (!/^[Cc][12]/.test(epc)) return null;
    const code = epc.slice(0, 13).toUpperCase();
    try {
      const r = await fetch(
        `/api/inventory/catalog/search?q=${encodeURIComponent(code)}`,
        { cache: "no-store" },
      );
      if (!r.ok) return null;
      const j = (await r.json()) as { rows?: CatalogSearchHit[] };
      // Exact match on the sku code only — substring matches against
      // unrelated SKUs would silently wrong-encode tags. The catalog
      // /search endpoint does ILIKE so we filter client-side.
      const exact = (j.rows ?? []).find(
        (h) => (h.sku ?? "").toUpperCase() === code,
      );
      return exact ?? null;
    } catch {
      return null;
    }
  }, []);

  const enrichEpc = useCallback(async (epc: string) => {
    if (resolvedRef.current.has(epc)) return;
    resolvedRef.current.add(epc);
    // Kick the C1/C2 auto-resolve in parallel with encode-resolve. Both
    // updates are upserts on the same row; whichever finishes second wins
    // on its fields. encode-resolve sets sku/upc/etc; auto-resolve sets
    // autoCustomSkuId AND fills the preview fields when the EPC is foreign
    // to the Carbon prefix (encode-resolve will return "foreign" for
    // C1/C2 EPCs because they don't carry F0A0B).
    void (async () => {
      const hit = await tryAutoResolveC1C2(epc);
      if (!hit) return;
      setRowsByEpc((prev) => {
        const next = new Map(prev);
        const row = next.get(epc);
        if (!row) return prev;
        next.set(epc, {
          ...row,
          autoCustomSkuId: hit.custom_sku_id,
          // Only fill preview fields when encode-resolve hasn't already
          // populated them with items-table data (rare for C1/C2 since
          // those are typically orphan).
          sku: row.sku ?? hit.sku,
          upc: row.upc ?? hit.upc,
          name: row.name ?? hit.name,
          size: row.size ?? hit.size,
          color: row.color ?? hit.color,
        });
        return next;
      });
    })();
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
          upc: it.upc ?? row.upc,
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
  }, [tryAutoResolveC1C2]);

  // --- SSE: stream EPCs into the table while reading -------------------
  useEffect(() => {
    if (!reading) return;
    const es = new EventSource("/api/edge/stream");
    const filterDeviceIds = selectedReaders.size > 0 ? selectedReaders : null;
    const onMessage = (ev: MessageEvent) => {
      if (!ev.data || ev.data.startsWith(":")) return;
      let p: {
        scanContext?: string;
        epcs?: string[];
        deviceId?: string;
        epcRssiMap?: Record<string, number>;
      };
      try {
        p = JSON.parse(ev.data) as typeof p;
      } catch {
        return;
      }
      if (filterDeviceIds && p.deviceId && !filterDeviceIds.has(p.deviceId)) return;
      const list = (p.epcs ?? [])
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => /^[0-9A-F]{24}$/.test(e))
        // Drop EPCs the operator has trash-iconed during this session.
        // Clear session resets the suppression so a re-scan re-surfaces them.
        .filter((e) => !suppressedRef.current.has(e));
      if (list.length === 0) return;
      // Add new EPCs as empty rows; enrich each via encode-resolve.
      const rssiMap = p.epcRssiMap ?? {};
      setRowsByEpc((prev) => {
        const next = new Map(prev);
        for (const epc of list) {
          const rssi = typeof rssiMap[epc] === "number" ? rssiMap[epc] : null;
          const cur = next.get(epc);
          if (!cur) {
            next.set(epc, {
              epc,
              sku: null,
              upc: null,
              name: null,
              size: null,
              color: null,
              status: "—",
              rssi,
              encodeStatus: null,
              busy: false,
              autoCustomSkuId: null,
            });
          } else if (rssi != null && (cur.rssi == null || rssi > cur.rssi)) {
            // Keep the strongest (closest) sighting so the slider tracks proximity.
            next.set(epc, { ...cur, rssi });
          }
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

  // Poll an encode-job's status until it's terminal (done | failed) or
  // the hard cap is hit. Flips the row's Status cell to "Wrote ✓ → ..."
  // / "Write failed: ..." so the operator sees whether the chip actually
  // got rewritten. The DB rotation is independent — that's already done
  // by /api/rfid/encode-claim before this poller starts.
  const pollEncodeJob = useCallback(
    async (epcKey: string, jobId: string, newEpc: string, serial: number) => {
      const startedAt = Date.now();
      const HARD_CAP_MS = 60_000;
      const POLL_MS = 1_500;
      while (Date.now() - startedAt < HARD_CAP_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        try {
          const r = await fetch(`/api/rfid/encode-jobs/${jobId}`, { cache: "no-store" });
          if (!r.ok) continue;
          const j = (await r.json()) as {
            ok: true;
            job: { status: string; error_msg: string | null; attempts: number };
          };
          if (j.job.status === "done") {
            setRowsByEpc((prev) => {
              const next = new Map(prev);
              const row = next.get(epcKey);
              if (!row) return prev;
              next.set(epcKey, {
                ...row,
                busy: false,
                encodeStatus: `Wrote ✓ → ${newEpc} (sn ${serial})`,
              });
              return next;
            });
            return;
          }
          if (j.job.status === "failed") {
            const reason = j.job.error_msg ?? "unknown";
            setRowsByEpc((prev) => {
              const next = new Map(prev);
              const row = next.get(epcKey);
              if (!row) return prev;
              next.set(epcKey, {
                ...row,
                busy: false,
                encodeStatus: `Write failed: ${reason} — DB rotated, retry from handheld`,
              });
              return next;
            });
            return;
          }
        } catch {
          /* transient network — keep polling */
        }
      }
      // Timed out waiting for the agent to report. The job may still
      // be running on the agent; the operator can refresh later.
      setRowsByEpc((prev) => {
        const next = new Map(prev);
        const row = next.get(epcKey);
        if (!row) return prev;
        next.set(epcKey, {
          ...row,
          busy: false,
          encodeStatus: `DB rotated → ${newEpc}. Chip-write status unknown (no agent response in 60s)`,
        });
        return next;
      });
    },
    [],
  );

  // --- Encode button: rotate each checked tag's identity --------------
  //
  // For each checked EPC, derive the destination customSkuId in this order:
  //   1. Row's auto-resolved SKU (C1/C2 → first-13 → cs.sku lookup)
  //   2. Manually-picked target from the search box
  // If neither is available for a given row, the row fails with a clear
  // message — the operator can pick a target and re-click Encode for the
  // failed rows only (checked state and row data are preserved).
  const onEncode = useCallback(async () => {
    if (busy) return;
    setErrorMsg(null);
    const epcs = Array.from(checked);
    if (epcs.length === 0) {
      setErrorMsg("Check at least one EPC to re-encode.");
      return;
    }
    // Pre-flight: C-prefix chip writes physically don't work on
    // is_pos_dedicated readers (.34 specifically, the WiFi-extender
    // POS reader). MR1 segfaults on C-prefix targets; MR2 fails
    // RFID_RadioOpen on this chip path (verified bench 2026-05-26).
    // Block the queue rather than let the DB rotate 5 rows whose
    // physical chips will never be rewritten.
    const cPrefixCheckedEpcs = epcs.filter((e) => /^[Cc]/.test(e));
    if (cPrefixCheckedEpcs.length > 0) {
      const allReaders: HardwareConfigReader[] = [];
      for (const loc of hcData?.locations ?? []) {
        for (const z of loc.zones ?? []) for (const r of z.readers ?? []) allReaders.push(r);
        for (const r of loc.unzonedReaders ?? []) allReaders.push(r);
        for (const r of loc.unzoned_readers ?? []) allReaders.push(r);
      }
      const posDedicatedSelected = allReaders.filter(
        (r) => selectedReaders.has(r.id) && r.is_pos_dedicated === true,
      );
      if (posDedicatedSelected.length > 0) {
        setErrorMsg(
          `C-prefix tags can't be encoded through the POS reader ` +
            `(${posDedicatedSelected.map((r) => r.network_address ?? r.id).join(", ")}) — ` +
            `the chip path on the WiFi extender doesn't support our write binary. ` +
            `Pick a non-extender reader (e.g. 192.168.1.70) and bring the tag to its antenna.`,
        );
        return;
      }
    }
    // Pre-flight: do any checked rows lack BOTH an auto-resolve and a
    // manual target? If so, surface a single banner — but still try the
    // rows that CAN encode so the operator isn't blocked end-to-end.
    const orphans = epcs.filter((epc) => {
      const row = rowsByEpc.get(epc);
      return !row?.autoCustomSkuId && !target;
    });
    if (orphans.length > 0 && !target) {
      setErrorMsg(
        `Pick a target SKU first — ${orphans.length} checked row${
          orphans.length === 1 ? "" : "s"
        } isn't a C1/C2 auto-resolve match.`,
      );
      return;
    }
    setBusy(true);
    try {
      for (const epc of epcs) {
        const row = rowsByEpc.get(epc);
        const customSkuId = row?.autoCustomSkuId ?? target?.custom_sku_id ?? null;
        if (!customSkuId) {
          setRowsByEpc((prev) => {
            const next = new Map(prev);
            const r = next.get(epc);
            if (!r) return prev;
            next.set(epc, {
              ...r,
              encodeStatus: "Failed: no target SKU (manual or auto)",
            });
            return next;
          });
          continue;
        }
        // Mark row busy while its claim is in flight.
        setRowsByEpc((prev) => {
          const next = new Map(prev);
          const r = next.get(epc);
          if (r) next.set(epc, { ...r, busy: true, encodeStatus: "Encoding…" });
          return next;
        });
        try {
          // First reader id from the picker — the agent will use this
          // bridge to physically write the chip. When the picker is
          // empty (shouldn't normally happen, the Read button required
          // it) we still post without readerId; encode-claim falls
          // back to DB-only behavior (no chip-write queued).
          const readerForWrite =
            selectedReaders.size > 0 ? Array.from(selectedReaders)[0] : undefined;
          const r = await fetch("/api/rfid/encode-claim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              customSkuId,
              oldEpc: epc,
              readerId: readerForWrite,
            }),
          });
          const j = (await r.json().catch(() => null)) as
            | {
                ok: true;
                epc: string;
                serial: number;
                system_id: number;
                jobId: string | null;
              }
            | { error?: string; code?: string }
            | null;
          if (j && "ok" in j && j.ok) {
            // DB rotation succeeded. If a chip-write job was queued,
            // surface "Writing chip…" and start polling its status;
            // otherwise just show the new EPC and stop.
            setRowsByEpc((prev) => {
              const next = new Map(prev);
              const row = next.get(epc);
              if (!row) return prev;
              next.set(epc, {
                ...row,
                busy: !!j.jobId,
                encodeStatus: j.jobId
                  ? `DB rotated → ${j.epc}. Writing chip…`
                  : `Encoded → ${j.epc} (sn ${j.serial})`,
                status: "tag_killed",
              });
              return next;
            });
            if (j.jobId) {
              // Poll the job status until done/failed. 1.5s cadence;
              // 60s hard cap so a stuck job doesn't loop forever.
              void pollEncodeJob(epc, j.jobId, j.epc, j.serial);
            }
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
  }, [busy, checked, target, rowsByEpc, selectedReaders, hcData, pollEncodeJob]);

  const toggleCheck = useCallback((epc: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(epc)) next.delete(epc);
      else next.add(epc);
      return next;
    });
  }, []);

  // Trash icon on a row → remove the EPC from this session's table AND
  // add it to suppressedRef so the SSE handler won't bring it back.
  // Survives until Clear session.
  const trashEpc = useCallback((epc: string) => {
    suppressedRef.current.add(epc);
    setRowsByEpc((prev) => {
      const next = new Map(prev);
      next.delete(epc);
      return next;
    });
    setChecked((prev) => {
      if (!prev.has(epc)) return prev;
      const next = new Set(prev);
      next.delete(epc);
      return next;
    });
  }, []);

  // Clear session resets all the per-session state:
  //   • the suppressed Set (so a re-scanned previously-trashed EPC is
  //     surfaced again — operator's "fresh start" semantics)
  //   • the enrichment dedup ref (so EPCs that re-appear get their
  //     encode-resolve call again)
  //   • the table, the per-row check set, the manual search target,
  //     and any banner messages
  // The reader stays awake — Clear session is a state reset, not a
  // scan stop. Operator clicks Stop separately to release the reader.
  const onClearSession = useCallback(() => {
    suppressedRef.current = new Set();
    resolvedRef.current = new Set();
    setRowsByEpc(new Map());
    setChecked(new Set());
    setTarget(null);
    setSearchQuery("");
    setHits([]);
    setErrorMsg(null);
  }, []);

  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.epc));
  // True if any checked row carries an auto-resolved SKU id — used to
  // enable the Encode button even when the operator hasn't picked a
  // manual target. (C1/C2 EPCs carry their own destination.)
  const checkedHasAutoResolve = useMemo(
    () => rows.some((r) => checked.has(r.epc) && r.autoCustomSkuId !== null),
    [rows, checked],
  );
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

        {/* Reader picker sits right next to the Read button — operator
            picks the reader, then hits Read. Moved here from the
            far-right per operator request 2026-05-26. */}
        <div className="flex min-w-[220px] items-center gap-2">
          <Radio className="h-3.5 w-3.5 text-[var(--wms-muted)]" />
          {/* Show every reader incl. is_pos_dedicated ones — Encode Items is the
              operator's "rewrite this specific chip through this specific reader"
              page, and the POS reader (.34) is exactly the kind of reader they
              physically place a tag in front of. Mirrors Cycle Counts + Hardware
              Config behavior. */}
          <ReaderPicker selected={selectedReaders} onChange={setSelectedReaders} />
        </div>

        <button
          type="button"
          onClick={() => void onEncode()}
          disabled={busy || checked.size === 0 || (!target && !checkedHasAutoResolve)}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-accent)]/40 bg-[var(--wms-accent)]/10 px-3 py-1.5 font-mono text-sm font-semibold text-[var(--wms-accent)] hover:bg-[var(--wms-accent)]/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Pencil className="h-3.5 w-3.5" />
          Encode ({checked.size})
        </button>

        {/* Clear session: wipes the per-session local state (table,
            suppression set, dedup refs, target/search) but does NOT
            stop scanning. Re-scanning surfaces previously-trashed
            EPCs again. */}
        <button
          type="button"
          onClick={onClearSession}
          disabled={busy || (rows.length === 0 && suppressedRef.current.size === 0)}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 font-mono text-sm text-[var(--wms-fg)] hover:bg-[var(--wms-surface)] disabled:cursor-not-allowed disabled:opacity-50"
          title="Wipe this session's table + suppression list. Reader stays awake."
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Clear session
        </button>

        {/* C-prefix filter toggle. When on, only EPCs starting with C (the
            Senitron legacy pool) are shown. Pure view filter — doesn't
            touch the underlying rowsByEpc Map, so toggling off restores
            everything that's been read. */}
        <button
          type="button"
          onClick={() => setCPrefixOnly((v) => !v)}
          className={
            "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-sm " +
            (cPrefixOnly
              ? "border-amber-400/50 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
              : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)] hover:bg-[var(--wms-surface)]")
          }
          title="Show only EPCs starting with C (Senitron legacy pool)"
        >
          <Filter className="h-3.5 w-3.5" />
          C only
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

      {showRssi ? (
        <RssiProximitySlider
          value={rssiThreshold}
          onChange={setRssiThreshold}
          hint=".70 proximity filter"
        />
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
              <SortableTh label="EPC" sortKeyName="epc" activeKey={sortKey} dir={sortDir} onClick={onHeaderClick} />
              <SortableTh label="SKU" sortKeyName="sku" activeKey={sortKey} dir={sortDir} onClick={onHeaderClick} />
              <SortableTh label="UPC" sortKeyName="upc" activeKey={sortKey} dir={sortDir} onClick={onHeaderClick} />
              <SortableTh label="Name" sortKeyName="name" activeKey={sortKey} dir={sortDir} onClick={onHeaderClick} />
              <SortableTh label="Size" sortKeyName="size" activeKey={sortKey} dir={sortDir} onClick={onHeaderClick} />
              <SortableTh label="Color" sortKeyName="color" activeKey={sortKey} dir={sortDir} onClick={onHeaderClick} />
              {showRssi ? <th className="px-3 py-2 text-left">RSSI</th> : null}
              <SortableTh label="Status" sortKeyName="status" activeKey={sortKey} dir={sortDir} onClick={onHeaderClick} />
              <th className="px-3 py-2 text-left w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={showRssi ? 10 : 9} className="px-3 py-8 text-center text-[var(--wms-muted)]">
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
                    {showRssi ? (
                      <td className="px-3 py-2 text-[var(--wms-muted)]">
                        {r.rssi != null ? `${r.rssi} dBm` : "—"}
                      </td>
                    ) : null}
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
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => trashEpc(r.epc)}
                        disabled={r.busy}
                        title="Remove from this session (will reappear after Clear session if re-scanned)"
                        className="inline-flex items-center rounded border border-red-400/30 bg-red-400/5 px-1.5 py-0.5 text-red-300 hover:bg-red-400/15 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
        Clicking Encode rotates the WMS items row (old → tag_killed, new →
        in-stock at fresh serial) AND queues a chip-write job on the picked
        reader. The agent borrows the bridge slot, runs MonsoonReader
        --target_tag &lt;old&gt; --write_tag &lt;new&gt;, then reports back.
        Status column shows "Writing chip…" → "Wrote ✓" / "Write failed: …".
        Keep the tag in the antenna&apos;s field while the write is in flight.
      </div>
    </div>
  );
}

/**
 * Clickable column header. asc/desc toggle on repeat clicks, third click
 * clears sort (insertion order). Arrow icon shows current state.
 */
function SortableTh<K extends string>({
  label,
  sortKeyName,
  activeKey,
  dir,
  onClick,
}: {
  label: string;
  sortKeyName: K;
  activeKey: K | null;
  dir: "asc" | "desc";
  onClick: (key: K) => void;
}) {
  const isActive = activeKey === sortKeyName;
  const Icon = !isActive ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      className={
        "px-3 py-2 text-left select-none cursor-pointer transition-colors " +
        (isActive
          ? "text-[var(--wms-accent)]"
          : "hover:text-[var(--wms-fg)]")
      }
      onClick={() => onClick(sortKeyName)}
      title={`Sort by ${label} (click to toggle A→Z / Z→A / off)`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <Icon className="h-3 w-3 opacity-70" />
      </span>
    </th>
  );
}
