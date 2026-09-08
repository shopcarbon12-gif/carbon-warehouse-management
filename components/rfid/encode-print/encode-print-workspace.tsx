"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  Play,
  Printer,
  Radio,
  RefreshCw,
  Search,
  Square,
  XCircle,
} from "lucide-react";

import {
  RssiProximitySlider,
  useRssiThreshold,
  RSSI_NEAR_DEFAULT,
  passesRssi,
} from "@/components/shared/rssi-proximity-slider";
import { useReaderWake } from "@/components/shared/use-reader-wake";
import { ReaderForceStopButton } from "@/components/shared/reader-force-stop-button";
import { LabelPreviewCanvas } from "@/components/tags-labels/label-preview-canvas";
import { generateNonRfidTag203Batch } from "@/lib/utils/zpl-carbon-tag-203";
import type { CarbonTagInput } from "@/lib/utils/zpl-carbon-tag";

/** The .87 reader is the encode + register-area antenna this page is pinned to. */
const READER_IP = "192.168.1.87";
/** Non-RFID label printer — Zebra .220 (ZD500R, 203 dpi), browser-direct. */
const PRINTER_URL = "http://192.168.1.220:80/pstprnt";

type Hit = {
  id: string;
  sku: string;
  ls_system_id: string;
  upc: string;
  description: string;
  size: string | null;
  color: string | null;
  price: string | null;
};
/**
 * What we know about a scanned chip, from /api/rfid/encode-resolve — the same
 * endpoint (and therefore the same field set) the Encode Items table shows, so
 * the operator sees identical information on both screens.
 */
type TagInfo = {
  /** known = items row found · orphan = decodes but no row · foreign = not our prefix */
  kind: "known" | "orphan" | "foreign";
  sku: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  upc: string | null;
  /** items.status — 'in-stock' renders as LIVE. Null for orphan/foreign. */
  status: string | null;
  binCode: string | null;
  lastSeenAt: string | null;
  systemId: number | null;
  serial: number | null;
};
type Seen = { epc: string; rssi: number | null; info: TagInfo | null };
type Step = "scan" | "encoding" | "verify" | "printing" | "done" | "error";

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
        sku: string | null;
        name: string | null;
        color: string | null;
        size: string | null;
        upc: string | null;
        bin_code: string | null;
        last_seen_at: string | null;
      };
    }
  | { ok: false; error?: string };

/** 'in-stock' is the DB value; operators read it as LIVE everywhere in the UI. */
function statusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  if (status === "in-stock") return "LIVE";
  return status.replace(/_/g, " ").toUpperCase();
}

type HcReader = { id: string; network_address: string | null };
type HcTree = {
  locations?: { zones?: { readers?: HcReader[] }[]; unzoned_readers?: HcReader[] }[];
};
const hcFetcher = async (u: string): Promise<HcTree> => {
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error("hardware-config fetch failed");
  return r.json() as Promise<HcTree>;
};

const STEPS: { key: Step; n: string; t: string }[] = [
  { key: "scan", n: "Step 1", t: "Scan tag" },
  { key: "encoding", n: "Step 2", t: "Encode SKU" },
  { key: "verify", n: "Step 3", t: "Re-read & confirm" },
  { key: "printing", n: "Step 4", t: "Print label" },
  { key: "done", n: "Step 5", t: "Complete" },
];
const STEP_ORDER: Step[] = ["scan", "encoding", "verify", "printing", "done"];

export function EncodePrintWorkspace() {
  // ── Resolve the .87 reader UUID ──────────────────────────────────────
  const { data: hc } = useSWR<HcTree>("/api/hardware-config", hcFetcher, {
    revalidateOnFocus: false,
  });
  const readerId = useMemo(() => {
    for (const loc of hc?.locations ?? []) {
      for (const z of loc.zones ?? [])
        for (const r of z.readers ?? []) if (r.network_address === READER_IP) return r.id;
      for (const r of loc.unzoned_readers ?? [])
        if (r.network_address === READER_IP) return r.id;
    }
    return null;
  }, [hc]);

  const [step, setStep] = useState<Step>("scan");
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  // No auto-start: the reader is warmed only while the operator has explicitly
  // STARTED it via the Start/Stop button. `sessionActive` = started AND resolved,
  // so the SSE subscription + status pill only light up on demand.
  const [readerErr] = useState<string | null>(null);
  const [readerOn, setReaderOn] = useState(false);

  // Warm .87 ONLY while started. Capturing/encoding is still driven by the flow's
  // Encode button + the SSE re-read interlock.
  useReaderWake({ active: readerOn, kind: "encode-items", networkAddresses: [READER_IP] });
  const sessionActive = readerOn && readerId !== null;

  const [threshold, setThreshold] = useRssiThreshold("wms.encode-print.rssi.v2", RSSI_NEAR_DEFAULT);
  const thresholdRef = useRef(threshold);
  useEffect(() => {
    thresholdRef.current = threshold;
  }, [threshold]);

  const [seen, setSeen] = useState<Map<string, Seen>>(new Map());
  const [selectedEpc, setSelectedEpc] = useState<string | null>(null);

  // SKU search
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [target, setTarget] = useState<Hit | null>(null);
  const [nextSerial, setNextSerial] = useState(0);

  // encode result + flow refs
  /**
   * Snapshot of the chip as it was BEFORE the rotation, taken at the moment the
   * operator hits Encode. Held separately from `seen` because step 1's reading
   * list is cleared on the way into verify — without this the Complete step
   * could not show what the tag used to be.
   */
  const [oldTag, setOldTag] = useState<{ epc: string; info: TagInfo | null } | null>(null);
  /** Serial minted for the new EPC by encode-claim. */
  const [newSerial, setNewSerial] = useState<number | null>(null);
  /** items.status the new row actually ended up at, per encode-finalize. */
  const [newStatus, setNewStatus] = useState<string | null>(null);
  const [newEpc, setNewEpc] = useState<string | null>(null);
  const newEpcRef = useRef<string | null>(null);
  useEffect(() => {
    newEpcRef.current = newEpc;
  }, [newEpc]);
  const verifiedGuardRef = useRef(false);
  const printStartedRef = useRef(false);

  const [statusMsg, setStatusMsg] = useState("Press Start reader, then bring a tag to the .87 antenna.");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  /**
   * Non-fatal outcome: the chip WAS written but the label didn't print. Kept
   * separate from `errMsg` so the flow still completes (the encode is real and
   * must not be thrown away) while reading unmistakably as "not finished".
   */
  const [warnMsg, setWarnMsg] = useState<string | null>(null);

  /**
   * Resolve a scanned chip to its catalog/inventory record, once per EPC per
   * session. Same endpoint the Encode Items table uses, so step 1 here shows
   * the same information the operator already reads over there instead of a
   * bare EPC they have to recognise from memory.
   */
  const resolvedRef = useRef<Set<string>>(new Set());
  const enrichEpc = useCallback(async (epc: string) => {
    if (resolvedRef.current.has(epc)) return;
    resolvedRef.current.add(epc);
    const apply = (info: TagInfo) =>
      setSeen((prev) => {
        const next = new Map(prev);
        const cur = prev.get(epc);
        // The caller adds the EPC in the same handler that kicks this off, so
        // `cur` is normally present. Create the entry rather than dropping the
        // result if the resolve somehow lands first — resolvedRef has already
        // cached this EPC, so a dropped info would never be retried.
        next.set(epc, cur ? { ...cur, info } : { epc, rssi: null, info });
        return next;
      });
    try {
      const r = await fetch("/api/rfid/encode-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epc }),
      });
      const j = (await r.json().catch(() => null)) as EncodeResolveResponse | null;
      if (!j || !("ok" in j) || !j.ok) {
        // Allow a later re-read to retry rather than caching a non-answer.
        resolvedRef.current.delete(epc);
        return;
      }
      const base = {
        sku: null,
        name: null,
        color: null,
        size: null,
        upc: null,
        status: null,
        binCode: null,
        lastSeenAt: null,
        systemId: j.decoded?.system_id ?? null,
        serial: j.decoded?.serial ?? null,
      };
      if (j.status === "foreign") {
        apply({ ...base, kind: "foreign", systemId: null, serial: null });
        return;
      }
      if (j.status === "valid_orphan" || !j.item) {
        apply({ ...base, kind: "orphan" });
        return;
      }
      const it = j.item;
      apply({
        ...base,
        kind: "known",
        sku: it.sku,
        name: it.name,
        color: it.color,
        size: it.size,
        upc: it.upc,
        status: it.status,
        binCode: it.bin_code,
        lastSeenAt: it.last_seen_at,
      });
    } catch {
      resolvedRef.current.delete(epc);
    }
  }, []);

  // ── SSE: stream EPCs from .87; in verify, watch for the new EPC ──────
  useEffect(() => {
    if (!sessionActive || !readerId) return;
    const es = new EventSource("/api/edge/stream");
    es.onmessage = (ev) => {
      if (!ev.data?.trim() || ev.data.startsWith(":")) return;
      let p: { epcs?: string[]; deviceId?: string; epcRssiMap?: Record<string, number> };
      try {
        p = JSON.parse(ev.data) as typeof p;
      } catch {
        return;
      }
      if (p.deviceId && p.deviceId !== readerId) return;
      const list = (p.epcs ?? [])
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => /^[0-9A-F]{24}$/.test(e));
      if (list.length === 0) return;

      // Verify interlock: print only when the live reader re-reads the exact
      // EPC we just wrote (raw match, before the proximity filter).
      if (
        stepRef.current === "verify" &&
        newEpcRef.current &&
        !verifiedGuardRef.current &&
        list.includes(newEpcRef.current)
      ) {
        verifiedGuardRef.current = true;
        setStatusMsg("Confirmed ✓ — new tag re-read. Printing label…");
        setStep("printing");
        return;
      }
      if (stepRef.current !== "scan") return;

      const rssiMap = p.epcRssiMap ?? {};
      setSeen((prev) => {
        const next = new Map(prev);
        let changed = false;
        for (const epc of list) {
          const rssi = typeof rssiMap[epc] === "number" ? rssiMap[epc] : null;
          const cur = next.get(epc);
          if (!cur) {
            next.set(epc, { epc, rssi, info: null });
            changed = true;
          } else if (rssi != null && (cur.rssi == null || rssi > cur.rssi)) {
            next.set(epc, { ...cur, rssi });
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      // Enrich outside the setState updater — one lookup per EPC per session.
      for (const epc of list) void enrichEpc(epc);
    };
    return () => es.close();
  }, [sessionActive, readerId, enrichEpc]);

  // Proximity-filtered, strongest-first reading list.
  const visible = useMemo(
    () =>
      Array.from(seen.values())
        .filter((s) => passesRssi(s.rssi, threshold))
        .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)),
    [seen, threshold],
  );
  const hiddenCount = seen.size - visible.length;

  // Effective selection (derived, no effect): the operator's click validated
  // against the live proximity list; auto-selects the single tag in range.
  const effectiveEpc = useMemo(() => {
    if (selectedEpc && visible.some((v) => v.epc === selectedEpc)) return selectedEpc;
    if (visible.length === 1) return visible[0].epc;
    return null;
  }, [selectedEpc, visible]);

  // ── SKU search ───────────────────────────────────────────────────────
  useEffect(() => {
    const s = q.trim();
    const t = setTimeout(async () => {
      if (s.length < 2 || target) {
        setHits([]);
        return;
      }
      try {
        const r = await fetch(`/api/rfid/catalog-search?q=${encodeURIComponent(s)}`, {
          cache: "no-store",
        });
        if (!r.ok) return;
        const j = (await r.json()) as { matches?: Hit[] };
        setHits(j.matches ?? []);
        setSearchOpen(true);
      } catch {
        /* ignore */
      }
    }, 220);
    return () => clearTimeout(t);
  }, [q, target]);

  const pickHit = useCallback((h: Hit) => {
    setTarget(h);
    setSearchOpen(false);
    setQ(`${h.sku} — ${h.description}`);
    fetch(`/api/rfid/next-serial?customSkuId=${h.id}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { next_serial?: number } | null) => {
        if (j?.next_serial) setNextSerial(j.next_serial);
      })
      .catch(() => {});
  }, []);

  const clearTarget = useCallback(() => {
    setTarget(null);
    setQ("");
    setHits([]);
  }, []);

  // box 8 (size-run) — fetch the style's real available sizes so the preview
  // matches the printed tag (same /api/tags/sizes the Print Tags page uses).
  const [sizesAvailable, setSizesAvailable] = useState("");
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    fetch(`/api/tags/sizes?customSkuId=${encodeURIComponent(target.id)}`)
      .then((r) => r.json())
      .then((j: { sizesAvailable?: string }) => {
        if (!cancelled) setSizesAvailable(String(j.sizesAvailable ?? ""));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [target]);

  const carbonInput: CarbonTagInput | null = useMemo(
    () =>
      target
        ? {
            itemName: target.description ?? "",
            color: target.color ?? "",
            size: target.size ?? "",
            upc: target.upc ?? "",
            customSku: target.sku,
            retailPrice: target.price ?? "0",
            sizesAvailable,
          }
        : null,
    [target, sizesAvailable],
  );

  // ── Encode → poll chip-write ─────────────────────────────────────────
  const pollJob = useCallback(async (jobId: string): Promise<boolean> => {
    const start = Date.now();
    const CAP = 60_000;
    const IV = 1_500;
    while (Date.now() - start < CAP) {
      await new Promise((r) => setTimeout(r, IV));
      try {
        const r = await fetch(`/api/rfid/encode-jobs/${jobId}`, { cache: "no-store" });
        if (!r.ok) continue;
        const j = (await r.json()) as {
          ok: true;
          job: { status: string; error_msg: string | null };
        };
        if (j.job.status === "done") return true;
        if (j.job.status === "failed") {
          setErrMsg(`Chip-write failed: ${j.job.error_msg ?? "unknown"} — DB rotated, retry.`);
          return false;
        }
      } catch {
        /* transient — keep polling */
      }
    }
    setErrMsg("Chip-write status unknown (no agent response in 60s).");
    return false;
  }, []);

  /**
   * A CONFIRMED chip-write is the moment the new tag becomes real, so promote
   * it out of the 'unknown' staging state `encode-claim` inserts — the operator
   * should not have to set the status by hand after a successful encode. This
   * is the same endpoint the handheld calls once `writeEpcTag = true`, and it
   * also flips the encode_events audit row from 'pending' to 'ok'.
   *
   * `oldEpc` is deliberately NOT sent. Passing it would additionally hard-DELETE
   * the old chip's items row — a separate decision from "mark the new tag live",
   * so it stays opt-in rather than riding along with this change.
   *
   * Non-fatal: the chip is written either way. If promotion fails we say so
   * rather than pretending, and the operator can still set the status manually.
   */
  const promoteLive = useCallback(async (epc: string): Promise<boolean> => {
    try {
      const r = await fetch("/api/rfid/encode-finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newEpc: epc, promoteNew: true }),
      });
      const j = (await r.json().catch(() => null)) as
        | { ok?: true; livePromoted?: boolean }
        | null;
      return Boolean(j?.livePromoted);
    } catch {
      return false;
    }
  }, []);

  const doEncode = useCallback(async () => {
    if (!effectiveEpc || !target || !readerId) return;
    setErrMsg(null);
    setWarnMsg(null);
    // Capture what the chip WAS before we rotate it — the reading list is
    // cleared on the way into verify, so this is the only surviving record of
    // the old tag by the time the Complete step renders it.
    setOldTag({ epc: effectiveEpc, info: seen.get(effectiveEpc)?.info ?? null });
    setNewSerial(null);
    setNewStatus(null);
    setStep("encoding");
    setStatusMsg("Rotating DB…");
    try {
      const r = await fetch("/api/rfid/encode-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customSkuId: target.id, oldEpc: effectiveEpc, readerId }),
      });
      const j = (await r.json().catch(() => null)) as
        | { ok: true; epc: string; serial: number; system_id: number; jobId: string | null }
        | { error?: string }
        | null;
      if (!j || !("ok" in j) || !j.ok) {
        setErrMsg(`Encode failed: ${(j as { error?: string } | null)?.error ?? "unknown"}`);
        setStep("error");
        return;
      }
      setNewEpc(j.epc);
      setNewSerial(j.serial);
      // Only a confirmed chip-write earns LIVE. Without a queued job nothing
      // proves the chip took the write, so the row stays 'unknown' as before.
      let live = false;
      if (j.jobId) {
        setStatusMsg("Writing chip via .87…");
        const ok = await pollJob(j.jobId);
        if (!ok) {
          setStep("error");
          return;
        }
        live = await promoteLive(j.epc);
      } else {
        setStatusMsg(`DB rotated → ${j.epc} (no chip-write job queued).`);
      }
      setNewStatus(live ? "in-stock" : "unknown");
      // Refresh the reading section and wait for the re-read.
      verifiedGuardRef.current = false;
      setSeen(new Map());
      setSelectedEpc(null);
      setStatusMsg(
        `Wrote ✓ → ${j.epc}${
          j.jobId ? (live ? " · status LIVE" : " · status NOT set to LIVE — set it manually") : ""
        }. Bring the tag back to .87 to confirm…`,
      );
      setStep("verify");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "network error");
      setStep("error");
    }
  }, [effectiveEpc, target, readerId, pollJob, promoteLive, seen]);

  // ── Print (fires when step enters "printing") ────────────────────────
  const doPrint = useCallback(async () => {
    if (!carbonInput) {
      setErrMsg("No SKU to print.");
      setStep("error");
      return;
    }
    setStatusMsg(`Printing non-RFID label for ${target?.sku} to .220…`);
    try {
      const zpl = generateNonRfidTag203Batch(carbonInput, 1);
      await fetch(PRINTER_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: zpl,
        mode: "no-cors",
        signal: AbortSignal.timeout(10_000),
      });
      setStatusMsg(`Printed ✓ — ${target?.sku}.`);
      setStep("done");
    } catch (e) {
      // The chip is ALREADY written and the DB has already rotated by the time
      // we get here, so a printer problem must not drop the operator into a
      // dead "error" state — that presents finished work as a total failure and
      // invites a pointless re-encode of a tag that is already correct.
      //
      // Why this fires: the printer sits on the warehouse LAN while this page
      // is served over HTTPS, so the browser will not simply POST to it.
      // Chrome sends a private-network preflight first, and the Zebra answers
      // OPTIONS by closing the connection with no reply (verified against
      // 192.168.1.220 — GET / and HEAD /pstprnt both 200 in ~20ms, OPTIONS
      // returns an empty reply). The fetch then hangs until AbortSignal fires,
      // surfacing Chrome's opaque DOMException "signal timed out".
      //
      // Print tags already treats an unreachable printer as a warning that
      // keeps the created tags; this matches that behaviour.
      const why =
        e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")
          ? "no response within 10s — the browser cannot reach the LAN printer from the HTTPS site"
          : e instanceof Error
            ? e.message
            : "printer fetch failed";
      setWarnMsg(
        `Chip written ✓${newEpc ? ` → ${newEpc}` : ""} — but the label did NOT print (${PRINTER_URL}: ${why}). ` +
          `The tag is encoded and saved: reprint the label from Print tags. Do NOT re-encode this tag.`,
      );
      setStep("done");
    }
  }, [carbonInput, target, newEpc]);

  useEffect(() => {
    if (step === "printing" && !printStartedRef.current) {
      printStartedRef.current = true;
      // Step-transition side effect: fire the print once. setState happens
      // async inside doPrint (after the printer fetch), not synchronously here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void doPrint();
    }
    if (step !== "printing") printStartedRef.current = false;
  }, [step, doPrint]);

  const reset = useCallback(() => {
    setSeen(new Map());
    setSelectedEpc(null);
    setTarget(null);
    setQ("");
    setHits([]);
    setSearchOpen(false);
    setNewEpc(null);
    setOldTag(null);
    setNewSerial(null);
    setNewStatus(null);
    resolvedRef.current.clear();
    verifiedGuardRef.current = false;
    printStartedRef.current = false;
    setErrMsg(null);
    setWarnMsg(null);
    setStatusMsg("Press Start reader, then bring a tag to the .87 antenna.");
    setStep("scan");
  }, []);

  const canEncode = step === "scan" && !!effectiveEpc && !!target;

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Top bar: start/stop + reader status + proximity slider */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            if (readerOn) {
              setReaderOn(false);
              setSeen(new Map());
              setSelectedEpc(null);
            } else {
              setReaderOn(true);
            }
          }}
          className={
            "inline-flex items-center gap-2 rounded-md border px-4 py-1.5 text-xs font-semibold " +
            (readerOn
              ? "border-red-400/50 bg-red-500/12 text-red-300 hover:bg-red-500/20"
              : "border-emerald-400/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25")
          }
        >
          {readerOn ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {readerOn ? "Stop reader" : "Start reader"}
        </button>
        <span
          className={
            "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold " +
            (readerErr
              ? "border-red-400/40 bg-red-500/10 text-red-300"
              : sessionActive
                ? "border-emerald-400/40 bg-emerald-500/12 text-emerald-300"
                : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-muted)]")
          }
        >
          <Radio className="h-3.5 w-3.5" />
          Reader .87 · {readerErr ? "error" : !readerOn ? "off" : sessionActive ? "on" : readerId ? "starting…" : "not found"}
        </span>
        <ReaderForceStopButton
          networkAddresses={[READER_IP]}
          onStopped={() => {
            // reset() already wipes the reading list, the selection, the
            // enrichment cache and the step — this only has to take the reader
            // itself back down.
            setReaderOn(false);
            reset();
          }}
        />
        <div className="min-w-[320px] flex-1">
          <RssiProximitySlider
            value={threshold}
            onChange={setThreshold}
            hint=".87 proximity filter"
          />
        </div>
      </div>
      {readerErr ? (
        <div className="rounded-md border border-red-400/40 bg-red-400/10 px-3 py-2 font-mono text-xs text-red-300">
          {readerErr}
        </div>
      ) : null}

      {/* Stepper */}
      <div className="flex flex-wrap gap-2">
        {STEPS.map((s) => {
          const cur = STEP_ORDER.indexOf(step === "error" ? "encoding" : step);
          const i = STEP_ORDER.indexOf(s.key);
          const state = step === "error" && s.key === "encoding" ? "error" : i < cur ? "done" : i === cur ? "active" : "idle";
          return (
            <div
              key={s.key}
              className={
                "min-w-[120px] flex-1 rounded-lg border px-3 py-2 transition-opacity " +
                (state === "active"
                  ? "border-[var(--wms-accent)] opacity-100 shadow-[0_0_0_1px_rgba(45,212,191,0.25)]"
                  : state === "done"
                    ? "border-emerald-400/40 opacity-100"
                    : state === "error"
                      ? "border-red-400/50 opacity-100"
                      : "border-[var(--wms-border)] opacity-50")
              }
            >
              <div className="text-[10px] uppercase tracking-wider text-[var(--wms-muted)]">{s.n}</div>
              <div className="text-[13px] font-semibold">
                {s.t}
                {state === "done" ? <span className="text-emerald-400"> ✓</span> : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Status bar — full width, directly under the stepper. Deliberately NOT
          inside the label-preview card: this is the one line that reports what
          the flow is doing, and beside the tag artwork it sat in the easiest
          place on the page to miss. */}
      <div
        className={
          "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm " +
          (errMsg
            ? "border-red-400/40 bg-red-500/10 text-red-200"
            : warnMsg
              ? "border-amber-400/40 bg-amber-500/10 text-amber-200"
              : step === "done"
                ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-200"
                : "border-[var(--wms-border)] bg-[var(--wms-surface)] text-[var(--wms-fg)]")
        }
      >
        {step === "encoding" || step === "printing" ? (
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--wms-accent)]" />
        ) : step === "done" ? (
          warnMsg ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          )
        ) : step === "verify" ? (
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-400" />
        ) : step === "error" ? (
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
        ) : (
          <Radio className="mt-0.5 h-4 w-4 shrink-0 text-[var(--wms-muted)]" />
        )}
        <span>{errMsg ?? warnMsg ?? statusMsg}</span>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_380px]">
        {/* LEFT — workflow */}
        <div className="rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-4">
          {step === "scan" ? (
            <>
              <h2 className="mb-3 text-[11px] uppercase tracking-wider text-[var(--wms-muted)]">
                1 · Scan a tag near .87
              </h2>
              {/* reading list */}
              <div className="overflow-hidden rounded-lg border border-[var(--wms-border)]">
                {visible.length === 0 ? (
                  <div className="px-4 py-6 text-center font-mono text-xs text-[var(--wms-muted)]">
                    {seen.size === 0
                      ? "Listening… wave a tag in front of .87."
                      : `All ${seen.size} tag(s) are below the proximity threshold — bring one closer.`}
                  </div>
                ) : (
                  visible.map((s) => {
                    const sel = s.epc === effectiveEpc;
                    const pct =
                      s.rssi == null ? 60 : Math.max(6, Math.min(100, Math.round(((s.rssi + 90) / 70) * 100)));
                    const info = s.info;
                    return (
                      <button
                        key={s.epc}
                        type="button"
                        onClick={() => setSelectedEpc(s.epc)}
                        className={
                          "block w-full border-b border-[var(--wms-border)]/50 px-3 py-2 text-left last:border-b-0 " +
                          (sel
                            ? "bg-[var(--wms-accent)]/10 shadow-[inset_3px_0_0_var(--wms-accent)]"
                            : "hover:bg-white/[0.03]")
                        }
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className="font-mono text-xs font-semibold text-teal-300 max-md:min-w-0 max-md:truncate"
                            title={s.epc}
                          >
                            {s.epc}
                          </span>
                          <span className="ml-auto h-[5px] w-[54px] overflow-hidden rounded bg-[#23304a] max-md:shrink-0">
                            <i className="block h-full bg-[var(--wms-accent)]" style={{ width: `${pct}%` }} />
                          </span>
                          <span className="w-[64px] shrink-0 text-right font-mono text-xs text-[var(--wms-muted)]">
                            {s.rssi == null ? "—" : `${s.rssi} dBm`}
                          </span>
                        </div>
                        {/* Same fields the Encode Items table resolves, so the
                            operator identifies the tag without leaving this page. */}
                        {info === null ? (
                          <div className="mt-1 font-mono text-[10px] text-[var(--wms-muted)]">
                            resolving…
                          </div>
                        ) : info.kind === "foreign" ? (
                          <div className="mt-1 font-mono text-[10px] text-amber-300/80">
                            FOREIGN — not a Carbon tag
                          </div>
                        ) : info.kind === "orphan" ? (
                          <div className="mt-1 font-mono text-[10px] text-amber-300/80">
                            ORPHAN — decodes, no item row
                            {info.serial != null ? ` · sn ${info.serial}` : ""}
                          </div>
                        ) : (
                          <div className="mt-1 space-y-0.5">
                            <div className="truncate text-[12px] text-[var(--wms-fg)]">
                              {info.name ?? "—"}
                            </div>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-[var(--wms-muted)]">
                              <span className="text-[var(--wms-fg)]/70">{info.sku ?? "—"}</span>
                              <span>· {info.size ?? "—"}</span>
                              <span>· {info.color ?? "—"}</span>
                              {info.upc ? <span>· UPC {info.upc}</span> : null}
                              {info.serial != null ? <span>· sn {info.serial}</span> : null}
                              {info.binCode ? <span>· bin {info.binCode}</span> : null}
                              <span
                                className={
                                  "rounded px-1.5 py-px " +
                                  (info.status === "in-stock"
                                    ? "bg-emerald-500/15 text-emerald-300"
                                    : info.status === "sold"
                                      ? "bg-red-500/15 text-red-300"
                                      : "bg-white/10 text-[var(--wms-muted)]")
                                }
                              >
                                {statusLabel(info.status)}
                              </span>
                            </div>
                          </div>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
              {hiddenCount > 0 ? (
                <p className="mt-1 font-mono text-[10px] text-[var(--wms-muted)]">
                  {hiddenCount} tag(s) hidden below the proximity threshold.
                </p>
              ) : null}

              {/* SKU search */}
              <div className="relative mt-4">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--wms-muted)]" />
                <input
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    if (target) setTarget(null);
                  }}
                  onFocus={() => hits.length && setSearchOpen(true)}
                  placeholder="Search target SKU (sku, UPC, name, system id…)"
                  className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-2 pl-9 pr-3 text-sm focus:border-[var(--wms-accent)] focus:outline-none"
                  autoComplete="off"
                />
                {searchOpen && hits.length > 0 && !target ? (
                  <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] shadow-xl">
                    {hits.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => pickHit(h)}
                        className="block w-full border-b border-[var(--wms-border)]/50 px-3 py-2 text-left last:border-b-0 hover:bg-white/[0.04]"
                      >
                        <div className="font-mono text-xs text-[var(--wms-accent)]">
                          {h.sku} · {h.ls_system_id}
                        </div>
                        <div className="text-[11px] text-[var(--wms-muted)]">
                          {[h.description, h.color, h.size].filter(Boolean).join(" · ")}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {target ? (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-[var(--wms-accent)]/40 bg-[var(--wms-accent)]/8 px-3 py-2">
                  <div className="min-w-0">
                    <div className="font-mono text-sm font-semibold">
                      {target.sku} <span className="text-[var(--wms-muted)]">· {target.ls_system_id}</span>
                    </div>
                    <div className="text-xs text-[var(--wms-muted)]">
                      {[target.description, target.color, target.size].filter(Boolean).join(" · ")} · $
                      {target.price}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={clearTarget}
                    className="ml-auto text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
                    aria-label="Clear target"
                  >
                    <XCircle className="h-4 w-4" />
                  </button>
                </div>
              ) : null}

              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  disabled={!canEncode}
                  onClick={() => void doEncode()}
                  className="inline-flex items-center gap-2 rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)]/15 px-4 py-2 text-sm font-semibold text-[var(--wms-accent)] hover:bg-[var(--wms-accent)]/25 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Pencil className="h-4 w-4" /> Encode →
                </button>
                <span className="font-mono text-[11px] text-[var(--wms-muted)]">
                  {!effectiveEpc
                    ? "select the tag in front of .87"
                    : !target
                      ? "pick a target SKU"
                      : `ready: ${effectiveEpc.slice(0, 8)}… → ${target.sku}`}
                </span>
              </div>
            </>
          ) : (
            <>
              <h2 className="mb-3 text-[11px] uppercase tracking-wider text-[var(--wms-muted)]">
                {step === "encoding"
                  ? "2 · Encoding"
                  : step === "verify"
                    ? "3 · Confirm the chip took the write"
                    : step === "printing"
                      ? "4 · Printing label"
                      : step === "done"
                        ? "5 · Complete"
                        : "Error"}
              </h2>
              <div className="space-y-3 text-sm">
                {effectiveEpc || newEpc ? (
                  <div className="font-mono text-xs text-[var(--wms-muted)]">
                    {newEpc ? (
                      <>
                        new tag: <span className="text-teal-300">{newEpc}</span>
                      </>
                    ) : null}
                    {target ? (
                      <>
                        {newEpc ? " · " : ""}SKU: <span className="text-[var(--wms-fg)]">{target.sku}</span>
                      </>
                    ) : null}
                  </div>
                ) : null}

                {/* Complete: the full before/after record. An encode is a
                    destructive identity swap, so show both sides rather than
                    just the new hex string. */}
                {step === "done" && newEpc ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <TagCard
                      title="Old tag — replaced"
                      tone="old"
                      epc={oldTag?.epc ?? "—"}
                      rows={[
                        { k: "Item", v: oldTag?.info?.name },
                        { k: "SKU", v: oldTag?.info?.sku },
                        { k: "Size", v: oldTag?.info?.size },
                        { k: "Color", v: oldTag?.info?.color },
                        { k: "UPC", v: oldTag?.info?.upc },
                        { k: "Serial", v: oldTag?.info?.serial ?? null },
                        { k: "Bin", v: oldTag?.info?.binCode },
                        {
                          k: "Status",
                          v: oldTag?.info
                            ? `${statusLabel(oldTag.info.status)} (at scan)`
                            : null,
                        },
                        {
                          k: "Last seen",
                          v: oldTag?.info?.lastSeenAt
                            ? new Date(oldTag.info.lastSeenAt).toLocaleString()
                            : null,
                        },
                      ]}
                    />
                    <TagCard
                      title="New tag — written"
                      tone="new"
                      epc={newEpc}
                      rows={[
                        { k: "Item", v: target?.description },
                        { k: "SKU", v: target?.sku },
                        { k: "Size", v: target?.size },
                        { k: "Color", v: target?.color },
                        { k: "UPC", v: target?.upc },
                        { k: "Serial", v: newSerial },
                        { k: "Price", v: target?.price ? `$${target.price}` : null },
                        { k: "Sys ID", v: target?.ls_system_id },
                        {
                          k: "Status",
                          v: (
                            <span
                              className={
                                newStatus === "in-stock"
                                  ? "text-emerald-300"
                                  : "text-amber-300"
                              }
                            >
                              {statusLabel(newStatus)}
                            </span>
                          ),
                        },
                      ]}
                    />
                  </div>
                ) : null}

                {step === "verify" ? (
                  <p className="text-[var(--wms-muted)]">
                    Reading section refreshed. The label prints <b className="text-[var(--wms-fg)]">only</b>{" "}
                    when .87 re-reads the new tag above.
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-3">
                  {step === "verify" ? (
                    <button
                      type="button"
                      onClick={() => setStep("printing")}
                      className="inline-flex items-center gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 text-xs hover:bg-[var(--wms-surface)]"
                    >
                      <Printer className="h-3.5 w-3.5" /> Print anyway
                    </button>
                  ) : null}
                  {step === "done" ? (
                    <button
                      type="button"
                      onClick={reset}
                      className="inline-flex items-center gap-2 rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)]/15 px-4 py-2 text-sm font-semibold text-[var(--wms-accent)] hover:bg-[var(--wms-accent)]/25"
                    >
                      <RefreshCw className="h-4 w-4" /> Encode another →
                    </button>
                  ) : null}
                  {step === "error" ? (
                    <button
                      type="button"
                      onClick={reset}
                      className="inline-flex items-center gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-2 text-sm font-semibold hover:bg-[var(--wms-surface)]"
                    >
                      <RefreshCw className="h-4 w-4" /> Start over
                    </button>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </div>

        {/* RIGHT — status + label preview */}
        <div className="rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-4">
          <h2 className="mb-3 text-[11px] uppercase tracking-wider text-[var(--wms-muted)]">
            {target ? `Label preview · ${target.sku}` : "Label preview"}
          </h2>

          {carbonInput ? (
            <>
              <LabelPreviewCanvas input={carbonInput} mode="nonrfid" serial={nextSerial} />
              <div className="mt-1 text-center text-[11px] text-[var(--wms-muted)]">
                prints to the Zebra .220 at 192.168.1.220
              </div>
            </>
          ) : (
            <p className="text-xs text-[var(--wms-muted)]">Pick a SKU to preview its non-RFID label.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** One labelled field inside a TagCard. Renders "—" for anything missing. */
function DetailRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-[68px] shrink-0 text-[10px] uppercase tracking-wider text-[var(--wms-muted)]">
        {k}
      </span>
      <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-[var(--wms-fg)]">
        {v === null || v === undefined || v === "" ? "—" : v}
      </span>
    </div>
  );
}

/**
 * Full record of one chip, shown side by side on the Complete step so the
 * operator can see exactly what the tag was and what it became — the encode is
 * a destructive identity swap, and "new tag: <hex>" alone gave them no way to
 * confirm the right item was rotated.
 */
function TagCard({
  title,
  tone,
  epc,
  rows,
}: {
  title: string;
  tone: "old" | "new";
  epc: string;
  rows: { k: string; v: React.ReactNode }[];
}) {
  return (
    <div
      className={
        "rounded-lg border p-3 " +
        (tone === "new"
          ? "border-emerald-400/40 bg-emerald-500/[0.06]"
          : "border-[var(--wms-border)] bg-black/20")
      }
    >
      <div
        className={
          "mb-2 text-[10px] font-semibold uppercase tracking-wider " +
          (tone === "new" ? "text-emerald-300" : "text-[var(--wms-muted)]")
        }
      >
        {title}
      </div>
      <div
        className={
          "mb-2 break-all font-mono text-xs font-semibold " +
          (tone === "new" ? "text-emerald-300" : "text-[var(--wms-muted)] line-through")
        }
      >
        {epc}
      </div>
      <div className="space-y-1">
        {rows.map((r) => (
          <DetailRow key={r.k} k={r.k} v={r.v} />
        ))}
      </div>
    </div>
  );
}
