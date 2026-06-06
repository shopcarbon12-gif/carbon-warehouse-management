"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
  CheckCircle2,
  Loader2,
  Pencil,
  Printer,
  Radio,
  RefreshCw,
  Search,
  XCircle,
} from "lucide-react";

import {
  RssiProximitySlider,
  useRssiThreshold,
  passesRssi,
} from "@/components/shared/rssi-proximity-slider";
import { LabelPreviewCanvas } from "@/components/tags-labels/label-preview-canvas";
import { generateNonRfidTag203Batch } from "@/lib/utils/zpl-carbon-tag-203";
import type { CarbonTagInput } from "@/lib/utils/zpl-carbon-tag";

/** The .15 reader is the encode + register-area antenna this page is pinned to. */
const READER_IP = "192.168.1.15";
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
type Seen = { epc: string; rssi: number | null };
type Step = "scan" | "encoding" | "verify" | "printing" | "done" | "error";

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
  // ── Resolve the .15 reader UUID ──────────────────────────────────────
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

  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  const [sessionActive, setSessionActive] = useState(false);
  const [readerErr, setReaderErr] = useState<string | null>(null);

  const [threshold, setThreshold] = useRssiThreshold("wms.encode-print.rssi");
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
  const [newEpc, setNewEpc] = useState<string | null>(null);
  const newEpcRef = useRef<string | null>(null);
  useEffect(() => {
    newEpcRef.current = newEpc;
  }, [newEpc]);
  const verifiedGuardRef = useRef(false);
  const printStartedRef = useRef(false);

  const [statusMsg, setStatusMsg] = useState("Bring a tag to the .15 antenna to begin.");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // ── .15 scan-session: auto-start on mount, end on unmount ────────────
  const startSession = useCallback(async (rid: string) => {
    try {
      const r = await fetch("/api/scan-sessions/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ readerId: rid, kind: "encode-items", context: { page: "encode-print" } }),
      });
      const j = (await r.json().catch(() => null)) as
        | { ok?: boolean; sessionId?: string; reason?: string; error?: string }
        | null;
      if (j?.ok && j.sessionId) {
        setSessionId(j.sessionId);
        setSessionActive(true);
        setReaderErr(null);
      } else {
        setReaderErr(`Could not start .15 (${j?.reason ?? j?.error ?? "unknown"}).`);
      }
    } catch {
      setReaderErr("Network error starting the .15 reader.");
    }
  }, []);

  const appliedRef = useRef(false);
  useEffect(() => {
    if (appliedRef.current || !readerId) return;
    appliedRef.current = true;
    // Mount-time external sync: wake the .15 reader. setState happens async
    // inside startSession (after the fetch), not synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void startSession(readerId);
  }, [readerId, startSession]);

  useEffect(
    () => () => {
      const id = sessionIdRef.current;
      if (id) {
        void fetch("/api/scan-sessions/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({ sessionId: id }),
        });
      }
    },
    [],
  );

  // ── SSE: stream EPCs from .15; in verify, watch for the new EPC ──────
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
            next.set(epc, { epc, rssi });
            changed = true;
          } else if (rssi != null && (cur.rssi == null || rssi > cur.rssi)) {
            next.set(epc, { epc, rssi });
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    return () => es.close();
  }, [sessionActive, readerId]);

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

  const doEncode = useCallback(async () => {
    if (!effectiveEpc || !target || !readerId) return;
    setErrMsg(null);
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
      if (j.jobId) {
        setStatusMsg("Writing chip via .15…");
        const ok = await pollJob(j.jobId);
        if (!ok) {
          setStep("error");
          return;
        }
      } else {
        setStatusMsg(`DB rotated → ${j.epc} (no chip-write job queued).`);
      }
      // Refresh the reading section and wait for the re-read.
      verifiedGuardRef.current = false;
      setSeen(new Map());
      setSelectedEpc(null);
      setStatusMsg(`Wrote ✓ → ${j.epc}. Bring the tag back to .15 to confirm…`);
      setStep("verify");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "network error");
      setStep("error");
    }
  }, [effectiveEpc, target, readerId, pollJob]);

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
      setErrMsg(e instanceof Error ? e.message : "Printer unreachable at 192.168.1.220");
      setStep("error");
    }
  }, [carbonInput, target]);

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
    verifiedGuardRef.current = false;
    printStartedRef.current = false;
    setErrMsg(null);
    setStatusMsg("Bring a tag to the .15 antenna to begin.");
    setStep("scan");
  }, []);

  const canEncode = step === "scan" && !!effectiveEpc && !!target;

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Top bar: reader status + proximity slider */}
      <div className="flex flex-wrap items-center gap-3">
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
          Reader .15 · {readerErr ? "error" : sessionActive ? "on" : readerId ? "starting…" : "not found"}
        </span>
        <div className="min-w-[320px] flex-1">
          <RssiProximitySlider
            value={threshold}
            onChange={setThreshold}
            hint=".15 proximity filter"
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

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_380px]">
        {/* LEFT — workflow */}
        <div className="rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-4">
          {step === "scan" ? (
            <>
              <h2 className="mb-3 text-[11px] uppercase tracking-wider text-[var(--wms-muted)]">
                1 · Scan a tag near .15
              </h2>
              {/* reading list */}
              <div className="overflow-hidden rounded-lg border border-[var(--wms-border)]">
                {visible.length === 0 ? (
                  <div className="px-4 py-6 text-center font-mono text-xs text-[var(--wms-muted)]">
                    {seen.size === 0
                      ? "Listening… wave a tag in front of .15."
                      : `All ${seen.size} tag(s) are below the proximity threshold — bring one closer.`}
                  </div>
                ) : (
                  visible.map((s) => {
                    const sel = s.epc === effectiveEpc;
                    const pct =
                      s.rssi == null ? 60 : Math.max(6, Math.min(100, Math.round(((s.rssi + 90) / 70) * 100)));
                    return (
                      <button
                        key={s.epc}
                        type="button"
                        onClick={() => setSelectedEpc(s.epc)}
                        className={
                          "flex w-full items-center gap-3 border-b border-[var(--wms-border)]/50 px-3 py-2 text-left last:border-b-0 " +
                          (sel
                            ? "bg-[var(--wms-accent)]/10 shadow-[inset_3px_0_0_var(--wms-accent)]"
                            : "hover:bg-white/[0.03]")
                        }
                      >
                        <span className="font-mono text-xs font-semibold text-teal-300">{s.epc}</span>
                        <span className="ml-auto h-[5px] w-[54px] overflow-hidden rounded bg-[#23304a]">
                          <i className="block h-full bg-[var(--wms-accent)]" style={{ width: `${pct}%` }} />
                        </span>
                        <span className="w-[64px] text-right font-mono text-xs text-[var(--wms-muted)]">
                          {s.rssi == null ? "—" : `${s.rssi} dBm`}
                        </span>
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
                    ? "select the tag in front of .15"
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

                {step === "verify" ? (
                  <p className="text-[var(--wms-muted)]">
                    Reading section refreshed. The label prints <b className="text-[var(--wms-fg)]">only</b>{" "}
                    when .15 re-reads the new tag above.
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
            {target ? `Label preview · ${target.sku}` : "Status"}
          </h2>
          <div className="mb-3 flex items-start gap-2 text-sm">
            {step === "encoding" || step === "printing" ? (
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--wms-accent)]" />
            ) : step === "done" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            ) : step === "verify" ? (
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-400" />
            ) : step === "error" ? (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            ) : null}
            <span className={step === "error" ? "text-red-300" : step === "done" ? "text-emerald-300" : ""}>
              {errMsg ?? statusMsg}
            </span>
          </div>

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
