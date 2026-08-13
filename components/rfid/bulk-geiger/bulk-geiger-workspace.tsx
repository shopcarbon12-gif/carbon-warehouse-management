"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload, Radio, Loader2, Plus } from "lucide-react";

import { ReaderPicker } from "@/components/shared/reader-picker";
import { useReaderWake } from "@/components/shared/use-reader-wake";

/**
 * Bulk Geiger — upload a CSV/XLSX EPC list, auto-resolve each EPC to its
 * catalog item, then either:
 *
 *   1. "Send to handheld" — fan the selected EPCs out to every authorized
 *      handheld at the operator's active location (Cloud + Geiger screen).
 *      Same behaviour as the catalog RFID-tags / Defective-EPCs modals.
 *
 *   2. Scan with FIXED readers — pick readers (default: all off) and Start.
 *      As fixed-reader reads roll in over the SSE edge stream, any uploaded
 *      EPC that is physically seen is marked FOUND. For a found EPC:
 *        • passes the tenant formula  → show its live status; if it has no
 *          status (no items row) or status 'unknown', auto-flip it to LIVE
 *          (add to inventory) when "Auto-add" is on.
 *        • fails the formula          → just FOUND, no status.
 *        • not seen at all            → nothing marked.
 */

const LOOKUP_CHUNK = 200; // /api/operations/transfers/lookup zod cap
const SCAN_LOOKUP_CHUNK = 500; // /api/handheld/epc-lookup zod cap

type Row = {
  epc: string;
  sku: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  resolved: boolean;
  /** Physically seen by a fixed reader during this scan session. */
  found: boolean;
  /** Passes the tenant EPC formula. null = not yet evaluated. */
  passesFormula: boolean | null;
  /** Current items.status for this EPC (null = no items row). */
  liveStatus: string | null;
  /** We auto-added / recovered this EPC to LIVE this session. */
  promoted: boolean;
  /** Whether the post-found formula+status lookup has been attempted. */
  scanLookedUp: boolean;
};

function statusBadgeClasses(status: string): string {
  switch (status) {
    case "in-stock":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
    case "unknown":
      return "bg-amber-500/15 text-amber-300 border-amber-500/40";
    case "tag_killed":
      return "bg-red-500/15 text-red-300 border-red-500/40 line-through";
    default:
      return "bg-slate-500/15 text-slate-300 border-slate-500/40";
  }
}
function statusLabel(status: string): string {
  return status === "in-stock" ? "LIVE" : status.toUpperCase();
}

export function BulkGeigerWorkspace() {
  // Warm the .15 reader while this page is open so it's ready before the
  // operator clicks Start scan. Capture is still gated by the Start button.
  useReaderWake({ active: true, kind: "bulk-geiger", networkAddresses: ["192.168.1.87"] });

  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<"upload" | "send" | "add" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Manual single-EPC entry box (in-table). Same enrichment path as import.
  const [manualEpc, setManualEpc] = useState("");

  // Set of uploaded EPC keys (uppercased) for fast membership tests in the
  // SSE handler — we only mark FOUND for EPCs that are in the table.
  const uploadedSetRef = useRef<Set<string>>(new Set());

  // ── Fixed-reader scan state (mirrors the Bulk Status workspace) ──────────
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
  const scanSessionIdsRef = useRef<string[]>([]);

  // Auto-add found+formula-passing tags with no/unknown status to inventory.
  const [autoAdd, setAutoAdd] = useState(true);
  const autoAddRef = useRef(autoAdd);
  useEffect(() => {
    autoAddRef.current = autoAdd;
  }, [autoAdd]);

  // Seed + two-pass enrich an EPC list into fully-built rows. The single source
  // of truth for "resolve an EPC to its catalog item", shared verbatim by file
  // import and manual single-EPC entry so a typed EPC behaves identically to an
  // imported one: items-lookup (decode + catalog) first, then C-prefix decode
  // for tags that encode their custom SKU in the first 13 chars.
  const enrichEpcs = useCallback(async (epcs: string[]): Promise<Row[]> => {
    const base = new Map<string, Row>();
    for (const e of epcs) {
      base.set(e, {
        epc: e,
        sku: null,
        name: null,
        color: null,
        size: null,
        resolved: false,
        found: false,
        passesFormula: null,
        liveStatus: null,
        promoted: false,
        scanLookedUp: false,
      });
    }
    // Pass 1 — items lookup for every EPC.
    for (let i = 0; i < epcs.length; i += LOOKUP_CHUNK) {
      const chunk = epcs.slice(i, i + LOOKUP_CHUNK);
      try {
        const lres = await fetch("/api/operations/transfers/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ epcs: chunk }),
        });
        if (!lres.ok) continue;
        const lj = (await lres.json()) as {
          rows?: { epc: string; sku: string | null; name: string | null; color: string | null; size: string | null }[];
        };
        for (const r of lj.rows ?? []) {
          const cur = base.get(r.epc.toUpperCase());
          if (cur) {
            cur.sku = r.sku ?? null;
            cur.name = r.name ?? null;
            cur.color = r.color ?? null;
            cur.size = r.size ?? null;
            cur.resolved = true;
          }
        }
      } catch {
        /* leave chunk unresolved → N/A */
      }
    }
    // Pass 2 — EPCs the items lookup couldn't resolve (no items row yet) but
    // that encode their custom SKU in the first 13 chars (C-prefix tags).
    // Decode + pull catalog so the row shows description/color/size pre-commission.
    const cMisses = epcs.filter((e) => {
      const cur = base.get(e);
      return cur !== undefined && !cur.resolved && e.toUpperCase().startsWith("C");
    });
    for (let i = 0; i < cMisses.length; i += LOOKUP_CHUNK) {
      const chunk = cMisses.slice(i, i + LOOKUP_CHUNK);
      try {
        const dres = await fetch("/api/rfid/bulk-geiger/decode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ epcs: chunk }),
        });
        if (!dres.ok) continue;
        const dj = (await dres.json()) as {
          rows?: { epc: string; sku: string | null; name: string | null; color: string | null; size: string | null }[];
        };
        for (const r of dj.rows ?? []) {
          const cur = base.get(r.epc.toUpperCase());
          if (cur && r.sku) {
            cur.sku = r.sku;
            cur.name = r.name ?? null;
            cur.color = r.color ?? null;
            cur.size = r.size ?? null;
            cur.resolved = true;
          }
        }
      } catch {
        /* leave unresolved → N/A */
      }
    }
    return epcs.map((e) => base.get(e)!);
  }, []);

  const onFile = useCallback(
    async (file: File) => {
      setBusy("upload");
      setErr(null);
      setMsg(null);
      setRows([]);
      setChecked(new Set());
      uploadedSetRef.current = new Set();
      try {
        // 1) parse EPCs from the file (server: CSV + XLSX)
        const fd = new FormData();
        fd.append("file", file);
        const pres = await fetch("/api/rfid/bulk-geiger/parse", { method: "POST", body: fd });
        const pj = (await pres.json().catch(() => ({}))) as { epcs?: string[]; error?: string };
        if (!pres.ok) throw new Error(pj.error ?? "Parse failed");
        const epcs = pj.epcs ?? [];
        if (epcs.length === 0) {
          setErr("No EPCs found in the file.");
          return;
        }
        // 2) seed + enrich (the exact path manual entry reuses)
        const built = await enrichEpcs(epcs);
        setRows(built);
        uploadedSetRef.current = new Set(built.map((r) => r.epc.toUpperCase()));
        // default: select everything
        setChecked(new Set(built.map((r) => r.epc)));
        const resolved = built.filter((r) => r.resolved).length;
        setMsg(`Loaded ${built.length} EPC(s) — ${resolved} resolved, ${built.length - resolved} N/A.`);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setBusy(null);
      }
    },
    [enrichEpcs],
  );

  // Manual single-EPC entry. Identical to importing a one-line file: the typed
  // EPC runs through the same enrichEpcs() path, lands in the table fully
  // resolved (or N/A), is auto-selected, and participates in fixed-reader
  // scanning + formula-pass status + auto-add exactly like an imported row.
  const addManualEpc = useCallback(async () => {
    const epc = manualEpc.replace(/\s+/g, "").toUpperCase();
    if (!epc) return;
    // Already present → just (re)select it, never duplicate.
    const existing = rowsRef.current.find((r) => r.epc.toUpperCase() === epc);
    if (existing) {
      setChecked((prev) => new Set(prev).add(existing.epc));
      setManualEpc("");
      setErr(null);
      setMsg(`${epc} is already in the list.`);
      return;
    }
    setBusy("add");
    setErr(null);
    setMsg(null);
    try {
      const [built] = await enrichEpcs([epc]);
      // Prepend so the just-added row is visible at the top of the table.
      setRows((prev) => [built, ...prev]);
      uploadedSetRef.current.add(epc);
      setChecked((prev) => new Set(prev).add(built.epc));
      setManualEpc("");
      setMsg(
        built.resolved
          ? `Added ${epc} — ${[built.sku, built.name].filter(Boolean).join(" · ") || "resolved"}.`
          : `Added ${epc} — N/A (no catalog match in this location).`,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not add EPC");
    } finally {
      setBusy(null);
    }
  }, [manualEpc, enrichEpcs]);

  const allChecked = rows.length > 0 && checked.size === rows.length;
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.epc)));
  const toggleOne = (epc: string) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(epc)) n.delete(epc);
      else n.add(epc);
      return n;
    });

  const selectedEpcs = useMemo(() => rows.filter((r) => checked.has(r.epc)).map((r) => r.epc), [rows, checked]);

  // ── Send to handheld — fan out to every authorized handheld at the active
  // location (POST /api/handhelds/epc-queue). Unified with the catalog
  // RFID-tags / Defective-EPCs modals; no per-device picker. ────────────────
  const sendToHandheld = useCallback(async () => {
    if (selectedEpcs.length === 0) {
      setErr("Select at least one row.");
      return;
    }
    const ok = window.confirm(
      `Send ${selectedEpcs.length} EPC${selectedEpcs.length === 1 ? "" : "s"} to every handheld at your active location?\n\nThey'll appear on each handheld's Cloud + Geiger screen.`,
    );
    if (!ok) return;
    setBusy("send");
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch("/api/handhelds/epc-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epcs: selectedEpcs }),
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
          `Sent ${selectedEpcs.length} EPC${selectedEpcs.length === 1 ? "" : "s"} to ${j.handhelds ?? 0} handheld${
            (j.handhelds ?? 0) === 1 ? "" : "s"
          } at ${where} — open Cloud + Geiger on each device.`,
        );
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(null);
    }
  }, [selectedEpcs]);

  // ── Fixed-reader scan lifecycle ──────────────────────────────────────────
  const stopScan = useCallback(() => {
    const ids = scanSessionIdsRef.current;
    scanSessionIdsRef.current = [];
    setScanning(false);
    for (const id of ids) {
      void fetch("/api/scan-sessions/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
        keepalive: true,
      }).catch(() => {});
    }
  }, []);

  const startScan = useCallback(async (readerIds: string[]) => {
    if (readerIds.length === 0) {
      setErr("Pick at least one reader first.");
      return;
    }
    setErr(null);
    const newIds: string[] = [];
    for (const readerId of readerIds) {
      try {
        const res = await fetch("/api/scan-sessions/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ readerId, kind: "bulk-geiger", context: { page: "bulk-geiger" } }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          sessionId?: string;
          reason?: string;
          error?: string;
        };
        if (res.ok && j.ok && j.sessionId) newIds.push(j.sessionId);
        else setErr(`Could not start a reader (${j.reason ?? j.error ?? "unknown"}).`);
      } catch {
        setErr("Network error starting reader.");
      }
    }
    if (newIds.length > 0) {
      scanSessionIdsRef.current = [...scanSessionIdsRef.current, ...newIds];
      setScanning(true);
    }
  }, []);

  const onScanToggle = useCallback(() => {
    if (scanning) stopScan();
    else void startScan(Array.from(selectedReadersRef.current));
  }, [scanning, startScan, stopScan]);

  // End all sessions when leaving the page so readers return to default-paused.
  useEffect(() => {
    return () => {
      const ids = scanSessionIdsRef.current;
      scanSessionIdsRef.current = [];
      for (const id of ids) {
        void fetch("/api/scan-sessions/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: id }),
          keepalive: true,
        }).catch(() => {});
      }
    };
  }, []);

  // Edge-stream subscription — mark uploaded EPCs FOUND as reads roll in.
  // We do NOT add rows for EPCs that weren't uploaded.
  useEffect(() => {
    const es = new EventSource("/api/edge/stream");
    es.onmessage = (ev) => {
      if (!scanningRef.current) return;
      if (!ev.data?.trim() || ev.data.startsWith(":")) return;
      let p: { epcs?: string[]; deviceId?: string };
      try {
        p = JSON.parse(ev.data) as { epcs?: string[]; deviceId?: string };
      } catch {
        return;
      }
      const sel = selectedReadersRef.current;
      if (sel.size > 0 && p.deviceId && !sel.has(p.deviceId)) return;
      const uploaded = uploadedSetRef.current;
      const hits = (p.epcs ?? [])
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => uploaded.has(e));
      if (hits.length === 0) return;
      const hitSet = new Set(hits);
      let changed = false;
      const next = rowsRef.current.map((r) => {
        if (!r.found && hitSet.has(r.epc.toUpperCase())) {
          changed = true;
          return { ...r, found: true };
        }
        return r;
      });
      if (changed) setRows(next);
    };
    return () => es.close();
  }, []);

  // Post-found processing: for each newly-found row, look up whether it passes
  // the formula and its current live status, then auto-promote eligible ones.
  useEffect(() => {
    const pending = rows.filter((r) => r.found && !r.scanLookedUp).map((r) => r.epc);
    if (pending.length === 0) return;
    // Optimistically mark so we don't re-enqueue on the next render tick.
    setRows((prev) =>
      prev.map((r) => (r.found && !r.scanLookedUp ? { ...r, scanLookedUp: true } : r)),
    );

    void (async () => {
      const unmark = (chunk: string[]) =>
        setRows((prev) => {
          const cs = new Set(chunk.map((e) => e.toUpperCase()));
          return prev.map((r) => (cs.has(r.epc.toUpperCase()) ? { ...r, scanLookedUp: false } : r));
        });

      for (let i = 0; i < pending.length; i += SCAN_LOOKUP_CHUNK) {
        const chunk = pending.slice(i, i + SCAN_LOOKUP_CHUNK);
        try {
          const res = await fetch("/api/handheld/epc-lookup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ epcs: chunk }),
          });
          if (!res.ok) {
            unmark(chunk);
            continue;
          }
          const data = (await res.json()) as {
            rows?: { epcHex: string; valid: boolean; status: string | null }[];
          };
          const byEpc = new Map<string, { valid: boolean; status: string | null }>();
          for (const r of data.rows ?? []) {
            byEpc.set(r.epcHex.toUpperCase(), { valid: r.valid, status: r.status });
          }
          setRows((prev) =>
            prev.map((r) => {
              const info = byEpc.get(r.epc.toUpperCase());
              if (!info) return r;
              return { ...r, passesFormula: info.valid, liveStatus: info.status };
            }),
          );

          // Eligible for "flip to live": passes formula AND (no status OR unknown).
          const eligible = chunk.filter((e) => {
            const info = byEpc.get(e.toUpperCase());
            return info?.valid && (info.status === null || info.status === "unknown");
          });
          if (autoAddRef.current && eligible.length > 0) {
            try {
              const pr = await fetch("/api/rfid/bulk-geiger/promote", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ epcs: eligible }),
              });
              if (pr.ok) {
                const pj = (await pr.json()) as {
                  results?: { epc: string; action: string; status: string | null }[];
                };
                const live = new Set(
                  (pj.results ?? [])
                    .filter((x) => x.action === "inserted" || x.action === "promoted")
                    .map((x) => x.epc.toUpperCase()),
                );
                if (live.size > 0) {
                  setRows((prev) =>
                    prev.map((r) =>
                      live.has(r.epc.toUpperCase())
                        ? { ...r, liveStatus: "in-stock", promoted: true }
                        : r,
                    ),
                  );
                }
              }
            } catch {
              /* promote is best-effort; status badge still reflects the lookup */
            }
          }
        } catch {
          unmark(chunk);
        }
      }
    })();
  }, [rows]);

  const foundCount = useMemo(() => rows.filter((r) => r.found).length, [rows]);
  const addedCount = useMemo(() => rows.filter((r) => r.promoted).length, [rows]);

  return (
    <div className="space-y-4">
      {/* Toolbar: import + send to handheld */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-2 rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)]/15 px-4 py-2 font-mono text-sm font-semibold text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25 disabled:opacity-50"
        >
          {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Import CSV / XLSX
        </button>

        <div className="mx-2 h-6 w-px bg-[var(--wms-border)]" />

        <button
          type="button"
          disabled={busy !== null || selectedEpcs.length === 0}
          onClick={() => void sendToHandheld()}
          title="Push the selected EPCs to every handheld at your active location (Cloud + Geiger screen)"
          className="inline-flex items-center gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-2 font-mono text-sm font-semibold text-[var(--wms-fg)] hover:bg-[var(--wms-surface)] disabled:opacity-50"
        >
          {busy === "send" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
          Send to handheld ({selectedEpcs.length})
        </button>
      </div>

      {/* Fixed-reader scan controls */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-3">
        <button
          type="button"
          onClick={() => onScanToggle()}
          disabled={rows.length === 0 || (!scanning && selectedReaders.size === 0)}
          title={
            rows.length === 0
              ? "Import an EPC list first."
              : selectedReaders.size === 0 && !scanning
                ? "Pick at least one reader (or All)."
                : undefined
          }
          className={`inline-flex min-h-[2.75rem] min-w-[10rem] items-center justify-center gap-2 rounded-xl border px-5 py-2.5 font-mono text-sm font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            scanning
              ? "border-amber-500/60 bg-amber-950/40 text-amber-100"
              : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)] hover:border-teal-500/40"
          }`}
        >
          <Radio className={`h-5 w-5 ${scanning ? "text-amber-400" : "text-[var(--wms-muted)]"}`} />
          {scanning ? "Scanning… (click to stop)" : "Start scan"}
        </button>
        <ReaderPicker selected={selectedReaders} onChange={setSelectedReaders} hidePosDedicated />
        <label
          className="flex items-center gap-2 font-mono text-xs text-[var(--wms-muted)]"
          title="When a found tag passes the formula and has no status (or 'unknown'), flip it to LIVE and add it to inventory."
        >
          <input
            type="checkbox"
            checked={autoAdd}
            onChange={(e) => setAutoAdd(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--wms-accent)]"
          />
          Auto-add found to inventory (LIVE)
        </label>
        <span className="ml-auto font-mono text-[10px] text-[var(--wms-muted)]">
          <strong className="text-[var(--wms-fg)]">{foundCount}</strong> found ·{" "}
          <strong className="text-emerald-300">{addedCount}</strong> added to inventory
        </span>
      </div>

      {err ? (
        <div className="rounded-md border border-red-400/40 bg-red-400/10 px-3 py-2 font-mono text-xs text-red-300">{err}</div>
      ) : null}
      {msg ? (
        <div className="rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 font-mono text-xs text-emerald-300">{msg}</div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
        <table className="w-full min-w-[820px] border-collapse font-mono text-xs">
          <thead className="bg-[var(--wms-surface-elevated)]/80 text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
            <tr>
              <th className="w-10 px-3 py-2 text-left">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allChecked}
                  disabled={rows.length === 0}
                  onChange={toggleAll}
                  className="h-4 w-4 accent-[var(--wms-accent)]"
                />
              </th>
              <th className="px-3 py-2 text-left">EPC</th>
              <th className="px-3 py-2 text-left">Custom SKU</th>
              <th className="px-3 py-2 text-left">Item Description</th>
              <th className="px-3 py-2 text-left">Found</th>
              <th className="px-3 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/50">
            {/* Manual entry row — type/scan an EPC; resolved identically to import. */}
            <tr className="bg-[var(--wms-surface-elevated)]/40">
              <td className="px-3 py-2 text-center text-[var(--wms-muted)]">
                <Plus className="mx-auto h-3.5 w-3.5" />
              </td>
              <td className="px-3 py-2" colSpan={5}>
                <div className="flex items-center gap-2">
                  <input
                    value={manualEpc}
                    onChange={(e) => setManualEpc(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void addManualEpc();
                      }
                    }}
                    placeholder="Type or scan an EPC, press Enter — resolved exactly like an imported one"
                    disabled={busy !== null}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="Add EPC manually"
                    className="w-full max-w-[460px] rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-1.5 font-mono text-xs uppercase text-[var(--wms-fg)] placeholder:normal-case placeholder:text-[var(--wms-muted)] focus:border-[var(--wms-accent)] focus:outline-none disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => void addManualEpc()}
                    disabled={busy !== null || manualEpc.trim() === ""}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)]/15 px-3 py-1.5 font-mono text-xs font-semibold text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25 disabled:opacity-50"
                  >
                    {busy === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                    Add
                  </button>
                </div>
              </td>
            </tr>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-[var(--wms-muted)]">
                  Import a CSV / XLSX of EPCs — or type one in the row above — to begin.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const desc = r.resolved
                  ? [r.name, r.color, r.size].filter((v) => v && v.trim()).join(" · ") || "—"
                  : "N/A";
                // Status shown only when found AND passes the formula.
                const showStatus = r.found && r.passesFormula === true;
                return (
                  <tr key={r.epc} className={`text-[var(--wms-fg)] ${!r.resolved ? "bg-amber-500/5" : ""}`}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.epc}`}
                        checked={checked.has(r.epc)}
                        onChange={() => toggleOne(r.epc)}
                        className="h-4 w-4 accent-[var(--wms-accent)]"
                      />
                    </td>
                    <td className="px-3 py-2 font-semibold text-teal-400/90">{r.epc}</td>
                    <td className="px-3 py-2">{r.resolved ? r.sku ?? "N/A" : "N/A"}</td>
                    <td className={`px-3 py-2 ${r.resolved ? "text-[var(--wms-fg)]" : "text-amber-300/80"}`}>{desc}</td>
                    <td className="px-3 py-2">
                      {r.found ? (
                        <span className="inline-block rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-emerald-300">
                          Found
                        </span>
                      ) : (
                        <span className="text-[var(--wms-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {showStatus && r.liveStatus ? (
                        <span
                          className={`inline-block rounded-md border px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide ${statusBadgeClasses(r.liveStatus)}`}
                        >
                          {statusLabel(r.liveStatus)}
                          {r.promoted ? " ·added" : ""}
                        </span>
                      ) : (
                        <span className="text-[var(--wms-muted)]">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 0 ? (
        <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
          {rows.length} row(s) · {selectedEpcs.length} selected · {foundCount} found by readers · N/A rows are
          EPCs not in this location&apos;s catalog. Status appears once a found tag passes the formula; tags with no
          status or &quot;unknown&quot; flip to LIVE when Auto-add is on.
        </p>
      ) : null}
    </div>
  );
}
